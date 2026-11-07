import { useCallback, useEffect, useState } from "react";
import { ipc } from "../ipc";
import { useStore } from "../store";
import type { SerialPort } from "../types";

const KIND_BADGE: Record<SerialPort["kind"], string> = {
  usb: "USB",
  pci: "PCI",
  bluetooth: "BT",
  unknown: "?",
};

/**
 * Read-only COM port list, modelled on the Device Manager's Ports section.
 *
 * Refreshing is manual by default: enumerating ports is cheap but pointless
 * work when nothing changes, and a 1 Hz timer is opt-in via the checkbox.
 */
export function SerialPortsPanel() {
  const autoRefresh = useStore((s) => s.settings.serialAutoRefresh);
  const setSettings = useStore((s) => s.setSettings);
  const [open, setOpen] = useState(true);
  const [ports, setPorts] = useState<SerialPort[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setBusy(true);
    try {
      const list = await ipc.listSerialPorts();
      setPorts(list);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      if (!silent) setBusy(false);
    }
  }, []);

  // One enumeration on mount so the panel is not blank; after that it only
  // updates when the user asks.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Opt-in polling. Silent so the row does not flicker every second.
  useEffect(() => {
    if (!autoRefresh) return;
    const id = window.setInterval(() => void refresh(true), 1000);
    return () => window.clearInterval(id);
  }, [autoRefresh, refresh]);

  return (
    <div className={`rail-ports ${open ? "is-open" : ""}`}>
      <div className="ports-head">
        <button
          className="ports-toggle"
          onClick={() => setOpen((v) => !v)}
          title={open ? "收起串口列表" : "展开串口列表"}
        >
          <span className="ports-caret">{open ? "▾" : "▸"}</span>
          串口
          <span className="ports-count">{ports.length}</span>
        </button>
        <button
          className={`ports-refresh ${busy ? "is-busy" : ""}`}
          title="刷新串口列表"
          onClick={() => void refresh()}
          disabled={busy}
        >
          ⟳
        </button>
        <label className="ports-auto" title="每秒自动刷新（默认关闭，省电省 CPU）">
          <input
            type="checkbox"
            className="ports-auto-check"
            checked={autoRefresh}
            onChange={(e) => setSettings({ serialAutoRefresh: e.target.checked })}
          />
          1s
        </label>
      </div>

      {open && (
        <div className="ports-list">
          {error && <div className="ports-empty">读取失败：{error}</div>}
          {!error && ports.length === 0 && <div className="ports-empty">未检测到串口</div>}
          {ports.map((p) => (
            <div
              className="port-item"
              key={p.name}
              title={
                p.vid != null && p.pid != null
                  ? `VID_${p.vid.toString(16).toUpperCase().padStart(4, "0")} PID_${p.pid
                      .toString(16)
                      .toUpperCase()
                      .padStart(4, "0")}`
                  : p.label
              }
            >
              <span className="port-name">{p.name}</span>
              <span className="port-label">{p.label}</span>
              <span className={`port-kind is-${p.kind}`}>{KIND_BADGE[p.kind]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
