import { useActiveSession, useStore } from "../store";
import { ipc } from "../ipc";

const MODE_LABEL: Record<string, string> = {
  input: "输入框模式",
  passthrough: "直通模式",
  palette: "历史检索",
};

export function StatusBar() {
  const session = useActiveSession();
  const mode = useStore((s) => s.mode);
  const manualLock = useStore((s) => s.manualLock);
  const toggleManualLock = useStore((s) => s.toggleManualLock);
  const sessions = useStore((s) => s.sessions);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const dataDir = useStore((s) => s.dataDir);

  return (
    <footer className="statusbar">
      <div className="status-left">
        <button
          className={`mode-chip ${mode === "passthrough" ? "is-pass" : ""} ${
            manualLock ? "is-locked" : ""
          }`}
          title="切换 输入框模式 / 直通模式 (Ctrl+Shift+P)"
          onClick={toggleManualLock}
        >
          <span className="mode-dot" />
          {manualLock ? "手动锁定 · 直通" : MODE_LABEL[mode] ?? mode}
        </button>
        {session && (
          <>
            <span className="status-sep">|</span>
            <span className="status-item">{session.title}</span>
            {session.cwd && (
              <span className="status-item status-cwd" title={session.cwd}>
                {session.cwd}
              </span>
            )}
            <span
              className={`status-item ${
                !session.spawned ? "is-idle" : session.alive ? "is-ok" : "is-bad"
              }`}
            >
              {!session.spawned ? "未启动" : session.alive ? "运行中" : `已退出 (${session.exitCode ?? "?"})`}
            </span>
          </>
        )}
      </div>
      <div className="status-right">
        <button
          className="data-chip"
          title={dataDir ? `打开数据目录：${dataDir}` : "打开数据目录"}
          onClick={() => void ipc.openDataDir().catch(() => undefined)}
        >
          <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden>
            <path
              d="M1.5 4.2h4l1.3 1.6h7.7v7.4a.8.8 0 0 1-.8.8H2.3a.8.8 0 0 1-.8-.8V4.2Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.2"
              strokeLinejoin="round"
            />
          </svg>
          <span className="data-path">{dataDir || "数据目录"}</span>
        </button>
        <span className="status-item">{sessions.length} 会话</span>
        {ipc.isMock && <span className="mock-badge">Mock</span>}
        <button className="status-gear" title="设置" onClick={() => setSettingsOpen(true)}>
          ⚙
        </button>
      </div>
    </footer>
  );
}
