import { useEffect, useState } from "react";
import { ipc } from "../ipc";
import { useStore } from "../store";
import { COMMON_BAUDS, type DetectedShell, type Session } from "../types";
import { SerialConfigDialog } from "./SerialConfigDialog";
import { SerialPortsPanel } from "./SerialPortsPanel";

export function LeftRail() {
  const sessions = useStore((s) => s.sessions);
  const activeKey = useStore((s) => s.activeKey);
  const activate = useStore((s) => s.activate);
  const closeSession = useStore((s) => s.closeSession);
  const renameSession = useStore((s) => s.renameSession);
  const createSession = useStore((s) => s.createSession);
  const reorder = useStore((s) => s.reorderSessions);
  const restartSession = useStore((s) => s.restartSession);

  const [menuOpen, setMenuOpen] = useState(false);
  const [profiles, setProfiles] = useState<DetectedShell[]>([]);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [baudFor, setBaudFor] = useState<string | null>(null);
  const [configFor, setConfigFor] = useState<string | null>(null);
  const pauseSerial = useStore((s) => s.pauseSerial);
  const resumeSerial = useStore((s) => s.resumeSerial);
  const updateSerial = useStore((s) => s.updateSerial);
  const showToast = useStore((s) => s.showToast);

  useEffect(() => {
    if (!menuOpen) return;
    void ipc.detectShells().then(setProfiles);
    const close = () => setMenuOpen(false);
    // Defer so the opening click itself does not immediately close the menu.
    const t = window.setTimeout(() => window.addEventListener("mousedown", close), 0);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener("mousedown", close);
    };
  }, [menuOpen]);

  return (
    <aside className="rail">
      <div className="rail-head">
        <span className="rail-title">会话</span>
        <div className="rail-add-wrap" onMouseDown={(e) => e.stopPropagation()}>
          <button
            className="icon-btn"
            title="新建会话 (Ctrl+Shift+T)"
            onClick={() => setMenuOpen((v) => !v)}
          >
            +
          </button>
          {menuOpen && (
            <div className="profile-menu">
              <div className="profile-menu-head">选择 Shell</div>
              {profiles.map((p, i) => (
                <button
                  key={`${p.executable}-${i}`}
                  className="profile-item"
                  onClick={() => {
                    setMenuOpen(false);
                    void createSession({
                      name: p.name,
                      executable: p.executable,
                      args: p.args,
                      cwd: null,
                      env: {},
                    });
                  }}
                >
                  <span className="profile-name">{p.name}</span>
                  <span className="profile-path" title={p.executable}>
                    {p.executable}
                  </span>
                </button>
              ))}
              {profiles.length === 0 && <div className="profile-empty">正在探测可用 Shell…</div>}
            </div>
          )}
        </div>
      </div>

      <div className="session-list">
        {sessions.map((s, index) => {
          const active = s.key === activeKey;
          return (
            <div
              key={s.key}
              className={`session-item ${active ? "is-active" : ""}`}
              data-key={s.key}
              data-active={active ? "1" : "0"}
              draggable
              onDragStart={() => setDragIndex(index)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => {
                if (dragIndex !== null && dragIndex !== index) reorder(dragIndex, index);
                setDragIndex(null);
              }}
              onClick={() => activate(s.key)}
              onDoubleClick={() => {
                setEditingKey(s.key);
                setDraft(s.title);
              }}
              title={`${s.profile.name}\n${s.profile.executable}`}
            >
              <span
                className={`status-dot ${
                  !s.spawned ? "is-idle" : s.alive ? "is-alive" : "is-dead"
                }`}
              />
              <div className="session-body">
                {editingKey === s.key ? (
                  <input
                    className="session-rename"
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => {
                      if (draft.trim()) renameSession(s.key, draft.trim());
                      setEditingKey(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        if (draft.trim()) renameSession(s.key, draft.trim());
                        setEditingKey(null);
                      } else if (e.key === "Escape") {
                        setEditingKey(null);
                      }
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : s.kind === "serial" && s.serial ? (
                  <span className="session-title serial-title">
                    <span className="serial-port-name">{s.serial.config.port}</span>
                    <button
                      className={`serial-baud-pill ${s.alive ? "is-live" : ""}`}
                      title="切换波特率（会重新打开串口）"
                      onClick={(e) => {
                        e.stopPropagation();
                        setBaudFor((v) => (v === s.key ? null : s.key));
                      }}
                    >
                      {s.serial.config.baud}
                    </button>
                  </span>
                ) : (
                  <span className="session-title">{s.title}</span>
                )}

                {s.kind === "serial" && s.serial ? (
                  <span className="session-meta">
                    {s.serial.config.dataBits}
                    {s.serial.config.parity === "none"
                      ? "N"
                      : s.serial.config.parity === "odd"
                        ? "O"
                        : "E"}
                    {s.serial.config.stopBits}
                    {" · "}
                    {s.serial.paused ? "已暂停（端口已释放）" : s.alive ? "已连接" : "未打开"}
                  </span>
                ) : (
                  <span className="session-meta">
                    {!s.spawned
                      ? "未启动"
                      : s.alive
                        ? s.profile.executable.split(/[\\/]/).pop()
                        : `已退出 · code ${s.exitCode ?? "?"}`}
                  </span>
                )}
                {s.kind !== "serial" && s.cwd && (
                  <span className="session-cwd" title={s.cwd}>
                    {s.cwd}
                  </span>
                )}
                {s.kind === "serial" && s.serial ? (
                  <span className="serial-actions">
                    <button
                      title={s.serial.paused ? "继续（重新打开串口）" : "暂停（释放串口给其他程序）"}
                      onClick={(e) => {
                        e.stopPropagation();
                        void (s.serial!.paused ? resumeSerial(s.key) : pauseSerial(s.key));
                      }}
                    >
                      {s.serial.paused ? "▶" : "⏸"}
                    </button>
                    {s.serial.log.enabled && (
                      <button
                        title="打开日志文件夹"
                        onClick={(e) => {
                          e.stopPropagation();
                          void ipc
                            .serialRevealLog(s.key)
                            .catch((err) => showToast(`无法打开日志目录：${String(err)}`));
                        }}
                      >
                        <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden>
                          <path
                            d="M1.8 4.2h4l1.3 1.6h7.1v6.6H1.8z"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="1.3"
                            strokeLinejoin="round"
                          />
                        </svg>
                      </button>
                    )}
                    <button
                      title="串口设置"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfigFor(s.key);
                      }}
                    >
                      ⚙
                    </button>
                  </span>
                ) : (
                  s.spawned &&
                  !s.alive && (
                    <button
                      className="session-restart"
                      onClick={(e) => {
                        e.stopPropagation();
                        void restartSession(s.key);
                      }}
                    >
                      ↻ 重启本会话
                    </button>
                  )
                )}
              </div>
              {baudFor === s.key && s.serial && (
                <div className="baud-menu" onClick={(e) => e.stopPropagation()}>
                  <div className="baud-menu-head">波特率</div>
                  {COMMON_BAUDS.map((b) => (
                    <button
                      key={b}
                      className={s.serial!.config.baud === b ? "is-on" : ""}
                      onClick={() => {
                        setBaudFor(null);
                        void updateSerial(s.key, {
                          config: { ...s.serial!.config, baud: b },
                        });
                      }}
                    >
                      {b}
                    </button>
                  ))}
                  <button
                    className="baud-menu-more"
                    onClick={() => {
                      setBaudFor(null);
                      setConfigFor(s.key);
                    }}
                  >
                    自定义…
                  </button>
                </div>
              )}

              <button
                className="session-close"
                title="关闭会话"
                onClick={(e) => {
                  e.stopPropagation();
                  void closeSession(s.key);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
        {sessions.length === 0 && (
          <div className="rail-empty">
            还没有会话
            <br />
            点击右上角 + 新建
          </div>
        )}
      </div>

      <SerialPortsPanel />

      {configFor &&
        (() => {
          const target = sessions.find((x) => x.key === configFor);
          if (!target?.serial) return null;
          return <SerialConfigDialog session={target} onClose={() => setConfigFor(null)} />;
        })()}
    </aside>
  );
}
