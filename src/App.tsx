import { useEffect } from "react";
import { CommandBar } from "./components/CommandBar";
import { LeftRail } from "./components/LeftRail";
import { QuickPanel } from "./components/QuickPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { StatusBar } from "./components/StatusBar";
import { TerminalView } from "./components/TerminalView";
import { useActiveSession, useStore } from "./store";

export default function App() {
  const ready = useStore((s) => s.ready);
  const boot = useStore((s) => s.boot);
  const sessions = useStore((s) => s.sessions);
  const activeKey = useStore((s) => s.activeKey);
  const layout = useStore((s) => s.layout);
  const setLayout = useStore((s) => s.setLayout);
  const settingsOpen = useStore((s) => s.settingsOpen);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const lastError = useStore((s) => s.lastError);
  const clearError = useStore((s) => s.clearError);
  const toast = useStore((s) => s.toast);
  const session = useActiveSession();

  useEffect(() => {
    void boot();
  }, [boot]);

  // Global shortcuts (SRS ch.6).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.shiftKey && e.key.toLowerCase() === "p") {
        e.preventDefault();
        s.toggleManualLock();
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "t") {
        e.preventDefault();
        void s.createSession();
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "w") {
        e.preventDefault();
        if (s.activeKey) void s.closeSession(s.activeKey);
        return;
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === "e") {
        e.preventDefault();
        s.setLayout({ rightCollapsed: !s.layout.rightCollapsed });
        return;
      }
      if (mod && e.key === "Tab") {
        e.preventDefault();
        const i = s.sessions.findIndex((x) => x.key === s.activeKey);
        if (i < 0) return;
        const next = (i + (e.shiftKey ? -1 : 1) + s.sessions.length) % s.sessions.length;
        s.activate(s.sessions[next].key);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Closing the window must (a) flush the workspace and (b) actually destroy the
  // window — the previous handler awaited the save but never closed (#2).
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    let unlisten: (() => void) | undefined;
    let disposed = false;
    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      const off = await win.onCloseRequested(async (event) => {
        event.preventDefault();
        try {
          await useStore.getState().persistNow();
        } catch {
          /* keep closing even if the save failed */
        }
        try {
          await win.destroy();
        } catch {
          await win.close().catch(() => undefined);
        }
      });
      if (disposed) off();
      else unlisten = off;
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    const onBeforeUnload = () => {
      void useStore.getState().persistNow();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const startResize = (side: "left" | "right") => (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = side === "left" ? layout.leftWidth : layout.rightWidth;
    document.body.classList.add("is-resizing");
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const next = side === "left" ? startW + dx : startW - dx;
      setLayout(
        side === "left"
          ? { leftWidth: Math.min(420, Math.max(180, next)) }
          : { rightWidth: Math.min(440, Math.max(200, next)) },
      );
    };
    const up = () => {
      document.body.classList.remove("is-resizing");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div
      className="app"
      style={
        {
          "--left": `${layout.leftWidth}px`,
          "--right": `${layout.rightWidth}px`,
        } as React.CSSProperties
      }
    >
      <div className="app-body">
        <LeftRail />
        <div className="resizer" onMouseDown={startResize("left")} />

        <main className="main">
          {lastError && (
            <div className="error-banner" onClick={clearError} title="点击关闭">
              <span>{lastError}</span>
              <span className="error-close">×</span>
            </div>
          )}
          <div className="term-host">
            {sessions.map((s) => (
              <TerminalView key={s.key} session={s} active={s.key === activeKey} />
            ))}
            {sessions.length === 0 && ready && (
              <div className="empty-state">
                <h1>TermDeck</h1>
                <p>左侧点击 + 新建一个 Shell 会话开始。</p>
                <p className="empty-hint">
                  Ctrl+Shift+T 新建 · Ctrl+Shift+P 切换直通 · Ctrl+R 搜索历史
                </p>
              </div>
            )}
          </div>
          {session ? (
            <CommandBar session={session} />
          ) : (
            <div className="cmdbar-wrap">
              <div className="cmdbar is-disabled">请先创建一个会话</div>
            </div>
          )}
        </main>

        {!layout.rightCollapsed && <div className="resizer" onMouseDown={startResize("right")} />}
        <QuickPanel />
      </div>
      <StatusBar />
      {toast && <div className="toast">{toast}</div>}
      {settingsOpen && <SettingsPanel onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
