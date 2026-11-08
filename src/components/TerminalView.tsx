import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SerializeAddon } from "@xterm/addon-serialize";
import { WebglAddon } from "@xterm/addon-webgl";
import { ipc } from "../ipc";
import { ui } from "../focusBus";
import { scrollbacks } from "../scrollbackBus";
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

const RESTORE_TEXT = "以上为上次会话的输出";

/** Written between the restored screen and the new shell's first prompt. */
const RESTORE_MARK = `\r\n\x1b[38;5;245m──── ${RESTORE_TEXT} ────\x1b[0m\r\n`;

/**
 * Drops previously written separators before saving.
 *
 * The screen is persisted verbatim, so without this every restart would add one
 * more separator and the snapshot would slowly fill up with them.
 */
function stripRestoreMarks(text: string): string {
  if (!text.includes(RESTORE_TEXT)) return text;
  return text
    .split(/\r?\n/)
    .filter((line) => !line.includes(RESTORE_TEXT))
    .join("\r\n");
}

/** Give the shell a moment to settle before serializing the whole buffer. */
const SAVE_DEBOUNCE_MS = 3000;

/** Cap how many scrollback lines get serialized; the rest is not worth 3 MB. */
const MAX_SERIALIZED_LINES = 2000;

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
    const serialize = new SerializeAddon();
    term.loadAddon(fit);
    term.loadAddon(serialize);
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

    let disposed = false;
    let saveTimer: number | undefined;

    /**
     * Serializes the visible screen plus scrollback as ANSI text.
     *
     * The alternate buffer belongs to a full-screen app (vim, ssh): replaying it
     * would resurrect a screen whose process is long gone, so it is skipped.
     */
    const snapshot = (): string => {
      if (disposed) return "";
      try {
        if (term.buffer.active.type !== "normal") return "";
        return stripRestoreMarks(
          serialize.serialize({ scrollback: Math.min(scrollback, MAX_SERIALIZED_LINES) }),
        );
      } catch {
        return "";
      }
    };

    const scheduleSave = () => {
      if (saveTimer) window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => {
        saveTimer = undefined;
        if (disposed) return;
        void ipc.scrollbackSave(session.key, snapshot()).catch(() => undefined);
      }, SAVE_DEBOUNCE_MS);
    };

    scrollbacks.register(session.key, snapshot);

    const dataSub = term.onData((data) => {
      void ipc.writePty(pid, data);
    });

    let offData: (() => void) | undefined;

    // Restore first, then attach: the backend replays everything that arrived
    // before the attach, so nothing printed during the await is lost.
    void (async () => {
      if (useStore.getState().settings.restoreScrollback) {
        const saved = await ipc.scrollbackLoad(session.key).catch(() => null);
        if (disposed) return;
        if (saved) {
          term.write(saved);
          term.write(RESTORE_MARK);
        }
      }
      if (disposed) return;

      const off = await ipc.onPtyData(({ sessionId, data }) => {
        if (sessionId !== pid) return;
        term.write(data);
        scheduleSave();
      });
      if (disposed) {
        off();
        return;
      }
      offData = off;

      const buffered = await ipc.attachSession(pid).catch(() => "");
      if (!disposed && buffered) {
        term.write(buffered);
        scheduleSave();
      }
    })();

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
      if (saveTimer) window.clearTimeout(saveTimer);
      scrollbacks.unregister(session.key);

      // Save the last screen, unless the session itself is being deleted -
      // closeSession clears the file and a save here would recreate it.
      const stillExists = useStore.getState().sessions.some((s) => s.key === session.key);
      if (stillExists) {
        try {
          if (term.buffer.active.type === "normal") {
            const data = stripRestoreMarks(
              serialize.serialize({
                scrollback: Math.min(scrollback, MAX_SERIALIZED_LINES),
              }),
            );
            if (data) void ipc.scrollbackSave(session.key, data).catch(() => undefined);
          }
        } catch {
          /* nothing to save */
        }
      }

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
            {session.kind === "serial"
              ? `${session.serial?.config.port ?? ""} 尚未连接`
              : session.cwd || session.profile.executable}
            <br />
            {session.kind === "serial"
              ? "连接会打开串口，部分开发板会因此复位"
              : "该会话尚未启动，点击下方按钮启动 Shell 进程"}
          </span>
          <button
            className="mini-btn"
            onClick={() => void useStore.getState().ensureSpawned(session.key)}
          >
            {session.kind === "serial" ? "连接串口" : "启动会话"}
          </button>
        </div>
      )}
    </div>
  );
}
