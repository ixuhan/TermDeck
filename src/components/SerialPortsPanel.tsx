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

const clock = () =>
  new Date().toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

/**
 * Read-only COM port list, modelled on Device Manager's Ports section.
 *
 * Refreshing is manual by default: enumerating costs a few milliseconds but
 * there is nothing to see when the hardware has not changed. The 1 Hz mode is
 * opt-in and shows a live "last refreshed at" line so it is obvious it is on.
 *
 * Layout follows the right sidebar: a horizontal drag handle above the panel,
 * a segmented control, and SVG icon buttons in the header.
 */
export function SerialPortsPanel() {
  const autoRefresh = useStore((s) => s.settings.serialAutoRefresh);
  const setSettings = useStore((s) => s.setSettings);
  const height = useStore((s) => s.layout.portHeight);
  const setLayout = useStore((s) => s.setLayout);
  const createSerialSession = useStore((s) => s.createSerialSession);

  const [open, setOpen] = useState(true);
  const [ports, setPorts] = useState<SerialPort[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastAt, setLastAt] = useState<string | null>(null);

  const refresh = useCallback(async (silent = false) => {
    if (!silent) setBusy(true);
    try {
      const list = await ipc.listSerialPorts();
      setPorts(list);
      setError(null);
      setLastAt(clock());
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

  // Opt-in polling. Silent so the rows do not flicker every second.
  useEffect(() => {
    if (!autoRefresh) return;
    const id = window.setInterval(() => void refresh(true), 1000);
    return () => window.clearInterval(id);
  }, [autoRefresh, refresh]);

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    document.body.classList.add("is-resizing-v");
    const move = (ev: MouseEvent) => {
      const dy = ev.clientY - startY;
      setLayout({ portHeight: Math.min(560, Math.max(96, startH - dy)) });
    };
    const up = () => {
      document.body.classList.remove("is-resizing-v");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <>
      {open && <div className="resizer-h" onMouseDown={startResize} />}

      <section
        className={`rail-ports ${open ? "is-open" : ""}`}
        style={open ? { height } : undefined}
      >
        <div className="ports-head">
          <span className="dir-title">串口</span>
          <span className="ports-count">{ports.length}</span>

          <div className="dir-mode" role="group" aria-label="刷新方式">
            <button
              className={!autoRefresh ? "is-on" : ""}
              title="手动刷新，不轮询"
              onClick={() => setSettings({ serialAutoRefresh: false })}
            >
              手动
            </button>
            <button
              className={autoRefresh ? "is-on" : ""}
              title="每秒刷新一次"
              onClick={() => setSettings({ serialAutoRefresh: true })}
            >
              1s
            </button>
          </div>

          <div className="dir-actions">
            <button
              title="刷新串口列表"
              className={busy ? "is-busy" : ""}
              disabled={busy}
              onClick={() => void refresh()}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
                <path
                  d="M13 8a5 5 0 1 1-1.5-3.5M13 2.2v3.2h-3.2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
            <button
              title={open ? "收起串口列表" : "展开串口列表"}
              onClick={() => setOpen((v) => !v)}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
                <path
                  d={open ? "M3.5 6 8 10.5 12.5 6" : "M3.5 10 8 5.5 12.5 10"}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          </div>
        </div>

        {open && autoRefresh && (
          <div className="ports-live">
            <span className="ports-pulse" />
            {lastAt ? `每秒刷新 · ${lastAt}` : "每秒刷新 · 等待首次结果"}
          </div>
        )}

        {open && (
          <div className="ports-list">
            {error && <div className="ports-empty">读取失败：{error}</div>}
            {!error && ports.length === 0 && <div className="ports-empty">未检测到串口</div>}
            {ports.map((p) => (
              <div
                className="port-item"
                key={p.name}
                onDoubleClick={() =>
                  void createSerialSession({
                    port: p.name,
                    baud: 115200,
                    dataBits: 8,
                    stopBits: 1,
                    parity: "none",
                    flow: "none",
                    dtr: true,
                    rts: true,
                  })
                }
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
                <button
                  className="port-open"
                  title="打开为串口会话"
                  onClick={(e) => {
                    e.stopPropagation();
                    void createSerialSession({
                      port: p.name,
                      baud: 115200,
                      dataBits: 8,
                      stopBits: 1,
                      parity: "none",
                      flow: "none",
                      dtr: true,
                      rts: true,
                    });
                  }}
                >
                  ＋
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
