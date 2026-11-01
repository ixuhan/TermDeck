import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { ipc } from "../ipc";
import { ui } from "../focusBus";
import { useStore } from "../store";
import type { Session } from "../types";

const THEME = {
  background: "#ffffff",
  foreground: "#24292f",
  cursor: "#0969da",
  cursorAccent: "#ffffff",
  selectionBackground: "#b6e3ff",
  black: "#24292f",
  red: "#cf222e",
  green: "#116329",
  yellow: "#7d4e00",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#633c01",
  brightBlue: "#218bff",
  brightMagenta: "#a475f9",
  brightCyan: "#3192aa",
  brightWhite: "#8c959f",
};

export function TerminalView({ session, active }: { session: Session; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const pid = session.ptyId;
  const scrollback = useStore((s) => s.settings.scrollback);
  const useWebgl = useStore((s) => s.settings.webgl);
  const mode = useStore((s) => s.mode);

  useEffect(() => {
    if (!pid || !hostRef.current) return;

    const term = new Terminal({
      fontFamily:
        '"Cascadia Mono", "JetBrains Mono", Consolas, "Microsoft YaHei Mono", monospace',
      fontSize: 13,
      lineHeight: 1.25,
      letterSpacing: 0,
      cursorBlink: true,
      allowProposedApi: true,
      theme: THEME,
      scrollback,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);

    // WebGL is a nice-to-have: no GPU / headless hosts must not break rendering.
    if (useWebgl) {
      try {
        const probe = document.createElement("canvas");
        if (probe.getContext("webgl2") || probe.getContext("webgl")) {
          const addon = new WebglAddon();
          addon.onContextLoss(() => addon.dispose());
          term.loadAddon(addon);
        }
      } catch {
        /* fall back to the DOM renderer */
      }
    }
    fit.fit();

    termRef.current = term;
    fitRef.current = fit;

    const dataSub = term.onData((data) => {
      void ipc.writePty(pid, data);
    });

    let disposed = false;
    let offData: (() => void) | undefined;
    void ipc
      .onPtyData(({ sessionId, data }) => {
        if (sessionId === pid) term.write(data);
      })
      .then((off) => {
        if (disposed) {
          off();
          return;
        }
        offData = off;
        void ipc.attachSession(pid).then((buffered) => {
          if (!disposed && buffered) term.write(buffered);
        });
      });

    // Alternate-screen detection drives the pass-through state machine.
    let bufferSub: { dispose: () => void } | undefined;
    const ns = term.buffer as unknown as {
      onBufferChange?: (cb: () => void) => { dispose: () => void };
    };
    if (typeof ns.onBufferChange === "function") {
      bufferSub = ns.onBufferChange(() => {
        const isAlt = term.buffer.active.type === "alternate";
        const state = useStore.getState();
        if (state.manualLock) return;
        state.setMode(isAlt ? "passthrough" : "input");
        if (isAlt) term.focus();
        else if (useStore.getState().settings.autoFocusOnTuiExit) ui.focusCommand();
      });
    }

    // OSC 7 gives us a real CWD when the shell reports it.
    const oscSub = term.parser.registerOscHandler(7, (payload) => {
      const m = /^file:\/\/[^/]*(\/.*)$/.exec(payload);
      if (m) useStore.getState().setCwd(session.key, decodeURIComponent(m[1]));
      return true;
    });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        void ipc.resizePty(pid, term.cols, term.rows);
      } catch {
        /* ignore transient layout states */
      }
    });
    ro.observe(hostRef.current);

    return () => {
      disposed = true;
      ro.disconnect();
      offData?.();
      dataSub.dispose();
      bufferSub?.dispose();
      oscSub.dispose();
      requestAnimationFrame(() => {
        try {
          term.dispose();
        } catch {
          /* already gone */
        }
      });
      termRef.current = null;
    };
  }, [pid, session.key, scrollback, useWebgl]);

  useEffect(() => {
    if (!active || !pid) return;
    const id = window.setTimeout(() => {
      try {
        fitRef.current?.fit();
        if (termRef.current) void ipc.resizePty(pid, termRef.current.cols, termRef.current.rows);
      } catch {
        /* ignore */
      }
    }, 20);
    return () => window.clearTimeout(id);
  }, [active, pid]);

  useEffect(() => {
    if (!active || mode !== "passthrough") return;
    termRef.current?.focus();
  }, [active, mode]);

  useEffect(() => {
    if (!active) return;
    ui.focusTerminal = () => termRef.current?.focus();
  }, [active]);

  return (
    <div
      className={`term-pane ${active ? "is-active" : ""}`}
      aria-hidden={!active}
      onMouseDown={() => {
        if (!active) return;
        const state = useStore.getState();
        if (state.settings.clickTerminalEntersPassthrough && state.mode !== "passthrough") {
          state.setMode("passthrough");
        }
      }}
    >
      {pid ? (
        <div className="term-surface" ref={hostRef} />
      ) : (
        <div className="lazy-pane">
          <span className="lazy-title">{session.title}</span>
          <span className="lazy-hint">
            {session.cwd || session.profile.executable}
            <br />
            该会话尚未启动，点击下方按钮启动 Shell 进程
          </span>
          <button
            className="mini-btn"
            onClick={() => void useStore.getState().ensureSpawned(session.key)}
          >
            启动会话
          </button>
        </div>
      )}
    </div>
  );
}
