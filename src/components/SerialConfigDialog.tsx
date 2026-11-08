import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ipc } from "../ipc";
import { useStore } from "../store";
import {
  COMMON_BAUDS,
  type SerialConfig,
  type SerialLogConfig,
  type SerialPort,
  type SerialView,
  type Session,
} from "../types";

const PARITIES: Array<{ value: SerialConfig["parity"]; label: string }> = [
  { value: "none", label: "无" },
  { value: "odd", label: "奇" },
  { value: "even", label: "偶" },
];

const FLOWS: Array<{ value: SerialConfig["flow"]; label: string }> = [
  { value: "none", label: "无" },
  { value: "rtscts", label: "硬件" },
  { value: "xonxoff", label: "软件" },
];

function Segmented<T extends string | number>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="dir-mode" role="group">
      {options.map((o) => (
        <button
          key={String(o.value)}
          className={value === o.value ? "is-on" : ""}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Serial session settings.
 *
 * Connection parameters can only change while the port is closed, so applying
 * them reopens the port (the store handles the pause/resume). Display and log
 * options apply immediately.
 */
export function SerialConfigDialog({
  session,
  onClose,
}: {
  session: Session;
  onClose: () => void;
}) {
  const updateSerial = useStore((s) => s.updateSerial);
  const resumeSerial = useStore((s) => s.resumeSerial);
  const showToast = useStore((s) => s.showToast);
  const state = session.serial!;

  const [config, setConfig] = useState<SerialConfig>(state.config);
  const [view, setView] = useState<SerialView>(state.view);
  const [log, setLog] = useState<SerialLogConfig>(state.log);
  const [ports, setPorts] = useState<SerialPort[]>([]);

  useEffect(() => {
    void ipc.listSerialPorts().then(setPorts).catch(() => setPorts([]));
  }, []);

  const patch = (p: Partial<SerialConfig>) => setConfig((c) => ({ ...c, ...p }));

  const apply = async () => {
    await updateSerial(session.key, { config, view, log });
    showToast(`${config.port} · ${config.baud} 配置已应用`);
    onClose();
  };

  const applyView = async (next: SerialView, nextLog = log) => {
    setView(next);
    await updateSerial(session.key, { view: next, log: nextLog });
  };

  const applyLog = async (next: SerialLogConfig) => {
    setLog(next);
    await updateSerial(session.key, { view, log: next });
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal modal-serial" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>串口设置 · {state.config.port}</span>
          <button className="icon-btn" onClick={onClose} title="关闭">
            ×
          </button>
        </div>

        <div className="modal-body">
          <div className="set-group-title">连接</div>

          <label className="set-row">
            <div className="set-text">
              <span className="set-label">端口</span>
              <span className="set-hint">修改后重新打开串口</span>
            </div>
            <select
              className="serial-select"
              value={config.port}
              onChange={(e) => patch({ port: e.target.value })}
            >
              {!ports.some((p) => p.name === config.port) && (
                <option value={config.port}>{config.port}（当前）</option>
              )}
              {ports.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name} — {p.label}
                </option>
              ))}
            </select>
          </label>

          <label className="set-row">
            <div className="set-text">
              <span className="set-label">波特率</span>
              <span className="set-hint">也可以直接改会话列表里的胶囊</span>
            </div>
            <input
              type="number"
              className="set-num"
              value={config.baud}
              min={50}
              max={12000000}
              step={1}
              onChange={(e) => patch({ baud: Math.max(50, Number(e.target.value) || 115200) })}
            />
          </label>

          <div className="serial-bauds">
            {COMMON_BAUDS.map((b) => (
              <button
                key={b}
                className={`serial-chip ${config.baud === b ? "is-on" : ""}`}
                onClick={() => patch({ baud: b })}
              >
                {b}
              </button>
            ))}
          </div>

          <div className="set-row">
            <div className="set-text">
              <span className="set-label">数据位</span>
            </div>
            <Segmented
              value={config.dataBits}
              options={[5, 6, 7, 8].map((v) => ({ value: v, label: String(v) }))}
              onChange={(v) => patch({ dataBits: v })}
            />
          </div>

          <div className="set-row">
            <div className="set-text">
              <span className="set-label">停止位</span>
            </div>
            <Segmented
              value={config.stopBits}
              options={[1, 2].map((v) => ({ value: v, label: String(v) }))}
              onChange={(v) => patch({ stopBits: v })}
            />
          </div>

          <div className="set-row">
            <div className="set-text">
              <span className="set-label">校验</span>
            </div>
            <Segmented
              value={config.parity}
              options={PARITIES}
              onChange={(v) => patch({ parity: v })}
            />
          </div>

          <div className="set-row">
            <div className="set-text">
              <span className="set-label">流控</span>
            </div>
            <Segmented value={config.flow} options={FLOWS} onChange={(v) => patch({ flow: v })} />
          </div>

          <label className="set-row">
            <div className="set-text">
              <span className="set-label">DTR / RTS</span>
              <span className="set-hint">打开时拉低会让部分开发板复位</span>
            </div>
            <span className="serial-flags">
              <label>
                <input
                  type="checkbox"
                  className="ports-auto-check"
                  checked={config.dtr}
                  onChange={(e) => patch({ dtr: e.target.checked })}
                />
                DTR
              </label>
              <label>
                <input
                  type="checkbox"
                  className="ports-auto-check"
                  checked={config.rts}
                  onChange={(e) => patch({ rts: e.target.checked })}
                />
                RTS
              </label>
            </span>
          </label>

          <div className="set-group-title">显示</div>

          <label className="set-row">
            <div className="set-text">
              <span className="set-label">HEX 显示</span>
              <span className="set-hint">收到的字节按每行 16 字节显示；发送时按 HEX 解析</span>
            </div>
            <input
              type="checkbox"
              className="set-check"
              checked={view.hex}
              onChange={(e) => void applyView({ ...view, hex: e.target.checked })}
            />
          </label>

          <label className="set-row">
            <div className="set-text">
              <span className="set-label">单独的 \r 视为换行</span>
              <span className="set-hint">很多单片机只发 CR，不补换行会把整屏内容压在同一行</span>
            </div>
            <input
              type="checkbox"
              className="set-check"
              checked={view.crAsNewline}
              onChange={(e) => void applyView({ ...view, crAsNewline: e.target.checked })}
            />
          </label>

          <div className="set-row">
            <div className="set-text">
              <span className="set-label">发送行尾</span>
              <span className="set-hint">回车时追加到发送内容之后</span>
            </div>
            <Segmented
              value={view.sendNewline}
              options={[
                { value: "\r\n", label: "CRLF" },
                { value: "\r", label: "CR" },
                { value: "\n", label: "LF" },
                { value: "", label: "无" },
              ]}
              onChange={(v) => void applyView({ ...view, sendNewline: v })}
            />
          </div>

          <label className="set-row">
            <div className="set-text">
              <span className="set-label">发送内容回显</span>
              <span className="set-hint">本地把发出去的内容也显示出来</span>
            </div>
            <input
              type="checkbox"
              className="set-check"
              checked={view.localEcho}
              onChange={(e) => void applyView({ ...view, localEcho: e.target.checked })}
            />
          </label>

          <div className="set-group-title">记录</div>

          <label className="set-row">
            <div className="set-text">
              <span className="set-label">保存接收数据到文件</span>
              <span className="set-hint">
                追加写入；暂停时关闭文件。开启「设置 → 每行开头显示时间」后，日志每行也会带 [时:分:秒]
              </span>
            </div>
            <input
              type="checkbox"
              className="set-check"
              checked={log.enabled}
              onChange={(e) => void applyLog({ ...log, enabled: e.target.checked })}
            />
          </label>

          <div className="serial-template">
            <input
              className="serial-input"
              value={log.template}
              placeholder="logs/%Port/%Y%M%D-%h%m%s.log"
              onChange={(e) => setLog({ ...log, template: e.target.value })}
              onBlur={() => void applyLog(log)}
            />
            <div className="serial-template-row">
              <div className="serial-tokens">
                <code>%Y</code> 年 <code>%M</code> 月 <code>%D</code> 日 <code>%h</code> 时{" "}
                <code>%m</code> 分 <code>%s</code> 秒 <code>%Port</code> 端口{" "}
                <code>%Baud</code> 波特率 <code>%Date</code> 完整时间
              </div>
              <button
                className="mini-btn is-ghost serial-pick"
                title="选择日志保存目录"
                onClick={() => {
                  void (async () => {
                    try {
                      const picked = await openDialog({
                        directory: true,
                        multiple: false,
                        title: "选择日志保存目录",
                      });
                      if (typeof picked !== "string") return;
                      const next = `${picked}\\%Port\\%Y%M%D-%h%m%s.log`;
                      setLog({ ...log, template: next, enabled: true });
                      await applyLog({ ...log, template: next, enabled: true });
                    } catch (e) {
                      showToast(`选择目录失败：${String(e)}`);
                    }
                  })();
                }}
              >
                浏览…
              </button>
            </div>
            <div className="serial-tokens is-muted">
              可填绝对路径（如 <code>D:\serial\%Port\%Y%M%D.log</code>），
              也可填相对 <code>data/</code> 的路径
            </div>
          </div>

          <label className="set-row">
            <div className="set-text">
              <span className="set-label">日志存为 HEX</span>
              <span className="set-hint">开启后每块数据写成一行十六进制</span>
            </div>
            <input
              type="checkbox"
              className="set-check"
              checked={log.hex}
              onChange={(e) => void applyLog({ ...log, hex: e.target.checked })}
            />
          </label>

          <div className="set-row">
            <div className="set-text">
              <span className="set-label">日志文件夹</span>
              <span className="set-hint">打开当前会话日志所在目录</span>
            </div>
            <button
              className="mini-btn is-ghost"
              onClick={() =>
                void ipc
                  .serialRevealLog(session.key)
                  .catch((e) => showToast(`无法打开日志目录：${String(e)}`))
              }
            >
              打开
            </button>
          </div>
        </div>

        <div className="modal-foot">
          <span className="set-hint">
            {session.alive ? "连接参数变更会重新打开串口" : "串口当前未打开"}
          </span>
          <span className="serial-foot-actions">
            {!session.alive && (
              <button className="mini-btn is-ghost" onClick={() => void resumeSerial(session.key)}>
                重新打开
              </button>
            )}
            <button className="mini-btn" onClick={() => void apply()}>
              应用
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
