import { useEffect, useState } from "react";
import { ipc } from "../ipc";
import { trackCwd } from "../cwd";
import { useActiveSession, useStore } from "../store";
import type { QuickItem, Session } from "../types";

async function writeToSession(session: Session, data: string): Promise<boolean> {
  const store = useStore.getState();
  let pid = store.sessions.find((s) => s.key === session.key)?.ptyId;
  if (!pid) {
    await store.ensureSpawned(session.key);
    pid = useStore.getState().sessions.find((s) => s.key === session.key)?.ptyId;
  }
  if (!pid) return false;
  await ipc.writePty(pid, data);
  return true;
}

function QuickRow({
  item,
  session,
  first,
  last,
}: {
  item: QuickItem;
  session: Session;
  first: boolean;
  last: boolean;
}) {
  const updateQuick = useStore((s) => s.updateQuick);
  const removeQuick = useStore((s) => s.removeQuick);
  const moveQuick = useStore((s) => s.moveQuick);
  const recordCommand = useStore((s) => s.recordCommand);
  const fillCommand = useStore((s) => s.fillCommand);
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(item.label);
  const [command, setCommand] = useState(item.command);

  const run = async () => {
    if (!item.command.trim()) {
      setEditing(true);
      return;
    }
    if (item.autoExecute) {
      const ok = await writeToSession(session, item.command + "\r");
      if (ok) {
        recordCommand(session.key, item.command, session.cwd || null);
        const nextCwd = trackCwd(session.cwd, item.command);
        if (nextCwd) useStore.getState().setCwd(session.key, nextCwd);
      }
    } else {
      // Filling always returns to input mode, even if pass-through was locked.
      fillCommand(item.command);
    }
  };

  if (editing) {
    return (
      <div className="quick-card is-editing">
        <input
          className="quick-input"
          value={label}
          placeholder="按钮名称"
          onChange={(e) => setLabel(e.target.value)}
          autoFocus
        />
        <textarea
          className="quick-input quick-input-cmd"
          value={command}
          placeholder="命令内容（不支持占位符）"
          onChange={(e) => setCommand(e.target.value)}
          rows={2}
        />
        <label className="quick-toggle">
          <input
            type="checkbox"
            checked={item.autoExecute}
            onChange={(e) => updateQuick(session.key, item.id, { autoExecute: e.target.checked })}
          />
          点击后立即执行
        </label>
        <div className="quick-actions">
          <button
            className="mini-btn"
            onClick={() => {
              if (!command.trim()) return;
              updateQuick(session.key, item.id, {
                label: label.trim() || "未命名",
                command: command.trim(),
              });
              setEditing(false);
            }}
          >
            保存
          </button>
          <button className="mini-btn is-ghost" onClick={() => setEditing(false)}>
            取消
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`quick-card ${item.autoExecute ? "" : "is-fill"}`}>
      <button className="quick-main" onClick={() => void run()} title={item.command}>
        <span className="quick-label">
          {item.label}
          <span className={`quick-badge ${item.autoExecute ? "is-run" : "is-fill"}`}>
            {item.autoExecute ? "执行" : "填入"}
          </span>
        </span>
        <code className="quick-cmd">{item.command || "（空命令）"}</code>
      </button>
      <div className="quick-tools">
        <button
          className="tool-btn"
          title="上移"
          disabled={first}
          onClick={() => moveQuick(session.key, item.id, -1)}
        >
          ↑
        </button>
        <button
          className="tool-btn"
          title="下移"
          disabled={last}
          onClick={() => moveQuick(session.key, item.id, 1)}
        >
          ↓
        </button>
        <button className="tool-btn" title="编辑" onClick={() => setEditing(true)}>
          ✎
        </button>
        <button className="tool-btn" title="删除" onClick={() => removeQuick(session.key, item.id)}>
          ×
        </button>
      </div>
    </div>
  );
}

export function QuickPanel() {
  const session = useActiveSession();
  const presets = useStore((s) => s.presets);
  const addQuick = useStore((s) => s.addQuick);
  const applyPreset = useStore((s) => s.applyPreset);
  const savePreset = useStore((s) => s.savePreset);
  const exportQuickCommands = useStore((s) => s.exportQuickCommands);
  const importQuickCommands = useStore((s) => s.importQuickCommands);
  const listExports = useStore((s) => s.listExports);
  const layout = useStore((s) => s.layout);
  const setLayout = useStore((s) => s.setLayout);

  const [presetKey, setPresetKey] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [exportFiles, setExportFiles] = useState<string[]>([]);

  useEffect(() => {
    if (!importOpen) return;
    void listExports().then(setExportFiles);
  }, [importOpen, listExports]);

  // Each session owns its own list, so the dropdown must not keep showing a
  // template name after switching sessions — that read as "every session
  // changed" even though only one had been overwritten.
  useEffect(() => {
    setPresetKey("");
  }, [session?.key]);

  if (layout.rightCollapsed) {
    return (
      <button
        className="rail-collapsed right"
        title="展开快捷指令面板"
        onClick={() => setLayout({ rightCollapsed: false })}
      >
        快捷指令
      </button>
    );
  }

  return (
    <aside className="quick-panel">
      <div className="quick-head">
        <span className="rail-title">快捷指令</span>
        <button
          className="icon-btn"
          title="折叠面板"
          onClick={() => setLayout({ rightCollapsed: true })}
        >
          ›
        </button>
      </div>

      <div className="quick-preset">
        <select
          className="quick-select"
          value={presetKey}
          onChange={(e) => {
            const key = e.target.value;
            setPresetKey(key);
            if (key && session) {
              applyPreset(session.key, key);
              setNotice(`已把「${presets[key]?.name ?? key}」载入当前会话（不影响其他会话）`);
            }
          }}
        >
          <option value="">装载预设…</option>
          {Object.entries(presets).map(([key, p]) => (
            <option key={key} value={key}>
              {p.name}
            </option>
          ))}
        </select>
        <button
          className="icon-btn"
          title="把当前列表保存为预设"
          disabled={!session}
          onClick={() => {
            const name = window.prompt("新预设名称");
            if (!name) return;
            savePreset(name);
            setNotice(`已保存预设「${name}」`);
          }}
        >
          ★
        </button>
      </div>

      <div className="quick-list">
        {!session && <div className="rail-empty">请先选择一个会话</div>}
        {session?.quickItems.map((item, i) => (
          <QuickRow
            key={item.id}
            item={item}
            session={session}
            first={i === 0}
            last={i === session.quickItems.length - 1}
          />
        ))}
        {session && (
          <button className="quick-add" onClick={() => addQuick(session.key)}>
            + 添加指令
          </button>
        )}
      </div>

      <div className="quick-foot">
        <button
          className="link-btn"
          onClick={async () => {
            const path = await exportQuickCommands();
            if (path) setNotice(`已导出到 ${path}`);
          }}
        >
          导出指令集
        </button>
        <button className="link-btn" onClick={() => setImportOpen(true)}>
          导入指令集
        </button>
      </div>

      {notice && (
        <div className="quick-notice" onAnimationEnd={() => setNotice(null)}>
          {notice}
        </div>
      )}

      {importOpen && (
        <div className="modal-mask" onClick={() => setImportOpen(false)}>
          <div className="modal modal-sm" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>导入指令集</span>
              <button className="icon-btn" onClick={() => setImportOpen(false)}>
                ×
              </button>
            </div>
            <div className="modal-body">
              <p className="set-hint">
                从数据目录的 <code>exports/</code> 读取导出的 JSON，导入后只替换当前会话的指令列表。
              </p>
              {exportFiles.length === 0 && <div className="rail-empty">还没有导出过指令集</div>}
              <div className="export-list">
                {exportFiles.map((f) => (
                  <button
                    key={f}
                    className="export-item"
                    onClick={async () => {
                      const err = await importQuickCommands(f);
                      setImportOpen(false);
                      setNotice(err ?? `已导入 ${f}`);
                    }}
                  >
                    {f}
                  </button>
                ))}
              </div>
            </div>
            <div className="modal-foot">
              <span className="set-hint">导入过程不会执行任何命令</span>
              <button className="mini-btn" onClick={() => setImportOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
