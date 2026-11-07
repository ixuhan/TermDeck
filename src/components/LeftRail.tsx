import { useEffect, useState } from "react";
import { ipc } from "../ipc";
import { useStore } from "../store";
import type { DetectedShell } from "../types";
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
                ) : (
                  <span className="session-title">{s.title}</span>
                )}
                <span className="session-meta">
                  {!s.spawned
                    ? "未启动"
                    : s.alive
                      ? s.profile.executable.split(/[\\/]/).pop()
                      : `已退出 · code ${s.exitCode ?? "?"}`}
                </span>
                {s.cwd && (
                  <span className="session-cwd" title={s.cwd}>
                    {s.cwd}
                  </span>
                )}
                {s.spawned && !s.alive && (
                  <button
                    className="session-restart"
                    onClick={(e) => {
                      e.stopPropagation();
                      void restartSession(s.key);
                    }}
                  >
                    ↻ 重启本会话
                  </button>
                )}
              </div>
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
    </aside>
  );
}
