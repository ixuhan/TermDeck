import { ipc } from "../ipc";
import { useActiveSession, useStore } from "../store";
import { UpdateSection } from "./UpdateSection";
import type { AdoptKeys } from "../types";

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="set-row">
      <div className="set-text">
        <span className="set-label">{label}</span>
        {hint && <span className="set-hint">{hint}</span>}
      </div>
      <input
        type="checkbox"
        className="set-check"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

const ADOPT_OPTIONS: Array<{ key: keyof AdoptKeys; label: string; hint: string }> = [
  { key: "tab", label: "Tab", hint: "整条采纳" },
  { key: "arrowRight", label: "→ 右方向键", hint: "光标在末尾时整条采纳" },
  { key: "ctrlArrowRight", label: "Ctrl + →", hint: "按词逐段采纳" },
  { key: "arrowUp", label: "↑ 上方向键", hint: "整条采纳" },
];

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const session = useActiveSession();
  const dataDir = useStore((s) => s.dataDir);
  const showToast = useStore((s) => s.showToast);

  const toggleAdopt = (key: keyof AdoptKeys, value: boolean) =>
    setSettings({ adoptKeys: { ...settings.adoptKeys, [key]: value } });

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>设置</span>
          <button className="icon-btn" onClick={onClose} title="关闭">
            ×
          </button>
        </div>

        <div className="modal-body">
          <div className="set-group-title">命令输入</div>

          <Toggle
            label="Ghost Text 预测补全"
            hint="按当前输入前缀检索本会话历史，灰色显示未输入部分"
            checked={settings.ghostText}
            onChange={(v) => setSettings({ ghostText: v })}
          />

          <label className="set-row">
            <div className="set-text">
              <span className="set-label">预测查询防抖</span>
              <span className="set-hint">越大越省 CPU，越小越跟手（建议 30–80ms）</span>
            </div>
            <input
              type="number"
              className="set-num"
              min={0}
              max={500}
              step={10}
              value={settings.ghostDebounceMs}
              onChange={(e) =>
                setSettings({
                  ghostDebounceMs: Math.min(500, Math.max(0, Number(e.target.value) || 0)),
                })
              }
            />
          </label>

          <div className="set-row set-row-block">
            <div className="set-text">
              <span className="set-label">采纳补全的按键（可多选）</span>
              <span className="set-hint">同时生效；未勾选的按键保持原行为</span>
            </div>
          </div>
          <div className="adopt-grid">
            {ADOPT_OPTIONS.map((opt) => (
              <label key={opt.key} className="adopt-item">
                <input
                  type="checkbox"
                  className="set-check"
                  checked={settings.adoptKeys[opt.key]}
                  onChange={(e) => toggleAdopt(opt.key, e.target.checked)}
                />
                <span className="adopt-label">{opt.label}</span>
                <span className="adopt-hint">{opt.hint}</span>
              </label>
            ))}
          </div>

          <Toggle
            label="退出全屏程序后自动回到输入框"
            hint="关闭后需要手动 Ctrl+Shift+P 切回"
            checked={settings.autoFocusOnTuiExit}
            onChange={(v) => setSettings({ autoFocusOnTuiExit: v })}
          />

          <Toggle
            label="点击终端即进入直通模式"
            hint="开启后点击终端画布会把键盘交给 PTY"
            checked={settings.clickTerminalEntersPassthrough}
            onChange={(v) => setSettings({ clickTerminalEntersPassthrough: v })}
          />

          <div className="set-group-title">历史记录</div>

          <label className="set-row">
            <div className="set-text">
              <span className="set-label">单会话历史上限</span>
              <span className="set-hint">超出后按最旧优先淘汰（FIFO）</span>
            </div>
            <input
              type="number"
              className="set-num"
              min={100}
              max={50000}
              step={500}
              value={settings.historyLimit}
              onChange={(e) =>
                setSettings({
                  historyLimit: Math.min(50000, Math.max(100, Number(e.target.value) || 100)),
                })
              }
            />
          </label>

          <Toggle
            label="敏感命令掩码"
            hint="入库前把 --password=/--token=/XXX_KEY= 的值替换为 ***"
            checked={settings.maskSecrets}
            onChange={(v) => setSettings({ maskSecrets: v })}
          />

          <div className="set-row">
            <div className="set-text">
              <span className="set-label">当前会话历史</span>
              <span className="set-hint">{session ? session.title : "未选择会话"}</span>
            </div>
            <button
              className="mini-btn is-ghost"
              disabled={!session}
              onClick={() => {
                if (!session) return;
                if (!window.confirm(`清空「${session.title}」的全部历史记录？`)) return;
                void ipc
                  .historyClear(session.key)
                  .then(() => showToast("已清空当前会话的命令历史"))
                  .catch((e) => showToast(`清空失败：${String(e)}`));
              }}
            >
              清空
            </button>
          </div>

          <div className="set-group-title">终端显示</div>

          <Toggle
            label="每行开头显示时间"
            hint="在输出每行前插入 [时:分:秒]，串口调试常用；全屏程序（vim / ssh）不受影响"
            checked={settings.lineTimestamps}
            onChange={(v) => setSettings({ lineTimestamps: v })}
          />

          <div className="set-group-title">性能与内存</div>

          <Toggle
            label="会话按需启动"
            hint="只给正在查看的会话创建 Shell 进程，其余点击时再启动，显著降低常驻内存"
            checked={settings.lazySpawn}
            onChange={(v) => setSettings({ lazySpawn: v })}
          />

          <label className="set-row">
            <div className="set-text">
              <span className="set-label">回滚缓冲行数</span>
              <span className="set-hint">每个会话保留的终端历史行数，越小越省内存</span>
            </div>
            <input
              type="number"
              className="set-num"
              min={200}
              max={20000}
              step={500}
              value={settings.scrollback}
              onChange={(e) =>
                setSettings({
                  scrollback: Math.min(20000, Math.max(200, Number(e.target.value) || 200)),
                })
              }
            />
          </label>

          <Toggle
            label="恢复上次的终端内容"
            hint="重开会话时回放上次屏幕上的输出（只读），命令历史与目录不受影响"
            checked={settings.restoreScrollback}
            onChange={(v) => setSettings({ restoreScrollback: v })}
          />

          <Toggle
            label="WebGL 渲染"
            hint="关闭后改用 DOM 渲染，省显存，长文本滚动可能略慢"
            checked={settings.webgl}
            onChange={(v) => setSettings({ webgl: v })}
          />

          <div className="set-group-title">数据</div>

          <div className="set-row">
            <div className="set-text">
              <span className="set-label">数据目录</span>
              <span className="set-hint">{dataDir || "—"}</span>
            </div>
            <button className="mini-btn is-ghost" onClick={() => void ipc.openDataDir()}>
              打开
            </button>
          </div>

          <UpdateSection />
        </div>

        <div className="modal-foot">
          <span className="set-hint">设置即时生效并写入 settings.json</span>
          <button className="mini-btn" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}
