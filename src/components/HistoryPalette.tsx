import type { HistoryItem } from "../types";

function relTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return `${Math.floor(d / 30)} 个月前`;
}

export function HistoryPalette({
  items,
  index,
  onHover,
  onPick,
}: {
  items: HistoryItem[];
  index: number;
  onHover: (i: number) => void;
  onPick: (i: number) => void;
}) {
  return (
    <div className="palette" role="listbox" aria-label="历史命令检索">
      <div className="palette-head">
        <span>当前会话历史</span>
        <span className="palette-hint">↑↓ 选择 · Enter 执行 · Tab 填入 · Esc 取消</span>
      </div>
      {items.length === 0 ? (
        <div className="palette-empty">没有匹配的历史命令</div>
      ) : (
        <div className="palette-list">
          {items.map((item, i) => (
            <div
              key={`${item.command}-${i}`}
              role="option"
              aria-selected={i === index}
              className={`palette-item ${i === index ? "is-active" : ""}`}
              onMouseEnter={() => onHover(i)}
              onMouseDown={(e) => {
                e.preventDefault();
                onPick(i);
              }}
            >
              <code className="palette-cmd">{item.command}</code>
              <span className="palette-meta">
                {item.executionCount > 1 && <em>×{item.executionCount}</em>}
                <span>{relTime(item.executedAt)}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
