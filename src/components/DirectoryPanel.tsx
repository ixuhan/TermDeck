import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const clock = () =>
  new Date().toLocaleTimeString("zh-CN", {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { ipc } from "../ipc";
import { useStore } from "../store";
import { DIR_SORT_LABELS } from "../types";
import type { DirEntry, DirListing, DirSortKey, Session } from "../types";

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(ms: number): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot).toLocaleLowerCase() : "";
}

/** Folders stay grouped ahead of files (Explorer habit) regardless of the key. */
function sortEntries(entries: DirEntry[], key: DirSortKey, asc: boolean): DirEntry[] {
  const dir = asc ? 1 : -1;
  const byName = (a: DirEntry, b: DirEntry) =>
    a.name.toLocaleLowerCase().localeCompare(b.name.toLocaleLowerCase());
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let c: number;
    switch (key) {
      case "mtime":
        c = a.mtime - b.mtime;
        break;
      case "size":
        c = a.size - b.size;
        break;
      case "type":
        c = extensionOf(a.name).localeCompare(extensionOf(b.name));
        break;
      default:
        c = byName(a, b);
    }
    // Stable, predictable tie-break so switching keys never scrambles equal rows.
    if (c === 0) c = byName(a, b);
    return c * dir;
  });
}

function breadcrumbs(path: string): Array<{ label: string; full: string }> {
  const sep = path.includes("\\") ? "\\" : "/";
  const parts = path.split(/[\\/]/).filter(Boolean);
  const out: Array<{ label: string; full: string }> = [];
  let cur = "";
  for (const p of parts) {
    cur = cur ? (cur.endsWith(sep) ? cur + p : cur + sep + p) : p;
    out.push({ label: p, full: /^[A-Za-z]:$/.test(cur) ? cur + sep : cur });
  }
  return out;
}

const FolderIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
    <path
      d="M1.6 4.4h4.1l1.3 1.7h7.4v7a.9.9 0 0 1-.9.9H2.5a.9.9 0 0 1-.9-.9V4.4Z"
      fill="#e8b84b"
      stroke="#c99a2e"
      strokeWidth="0.8"
      strokeLinejoin="round"
    />
  </svg>
);

const FileIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
    <path
      d="M3.6 1.8h5.3l3.5 3.5v8.9H3.6V1.8Z"
      fill="#ffffff"
      stroke="#9aa4b2"
      strokeWidth="0.9"
      strokeLinejoin="round"
    />
    <path d="M8.9 1.8v3.5h3.5" fill="none" stroke="#9aa4b2" strokeWidth="0.9" />
  </svg>
);

export function DirectoryPanel({ session, active }: { session: Session; active: boolean }) {
  const setDirVisible = useStore((s) => s.setDirVisible);
  const setDirMode = useStore((s) => s.setDirMode);
  const setDirPath = useStore((s) => s.setDirPath);
  const setDirFixedPath = useStore((s) => s.setDirFixedPath);
  const showToast = useStore((s) => s.showToast);
  const height = useStore((s) => s.layout.dirHeight);
  const sortBy = useStore((s) => s.settings.dirSortBy);
  const sortAsc = useStore((s) => s.settings.dirSortAsc);
  const autoRefresh = useStore((s) => s.settings.dirAutoRefresh);
  const setSettings = useStore((s) => s.setSettings);

  const [listing, setListing] = useState<DirListing | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [lastAt, setLastAt] = useState<string | null>(null);

  const seqRef = useRef(0);
  const loadedRef = useRef("");

  // Dynamic mode follows `currentPath`, which `setCwd` rewrites whenever the
  // shell changes directory — so manual browsing sticks until the next `cd`.
  // Fixed mode ignores the shell entirely.
  const target =
    session.dir.mode === "dynamic"
      ? session.dir.currentPath || session.cwd
      : session.dir.currentPath || session.dir.fixedPath || "";

  /** One-shot read. The backend installs no watchers, so this is the only cost. */
  const load = useCallback(
    async (path: string, force = false) => {
      if (!path) return;
      if (!force && loadedRef.current === path) return;
      loadedRef.current = path;
      const seq = ++seqRef.current;
      setLoading(true);
      setError(null);
      try {
        const res = await ipc.readDirectory(path);
        if (seqRef.current !== seq) return;
        setListing(res);
        setLastAt(clock());
        // Backend resolved "." or walked up from a vanished directory; keep the
        // stored path in sync so the breadcrumb and restore are accurate.
        if (res.path !== path) setDirPath(session.key, res.path);
      } catch (e) {
        if (seqRef.current !== seq) return;
        setListing(null);
        setError(String(e));
      } finally {
        if (seqRef.current === seq) setLoading(false);
      }
    },
    [session.key, setDirPath],
  );

  // Load only while this session is in front and the panel is open.
  useEffect(() => {
    if (!session.dir.visible || !active) return;
    // "." lets the backend resolve the process CWD when no path is known yet.
    void load(target || ".");
  }, [target, session.dir.visible, active, load]);

  // Opt-in 1 Hz polling, matching the serial port panel. Only the visible,
  // active panel polls; `force` bypasses the path de-dup so disk changes show
  // up. Silent: an existing listing is kept on screen instead of flashing
  // "读取中…" every second.
  useEffect(() => {
    if (!autoRefresh || !session.dir.visible || !active) return;
    const id = window.setInterval(() => {
      void load(target || ".", true);
    }, 1000);
    return () => window.clearInterval(id);
  }, [autoRefresh, session.dir.visible, active, target, load]);

  // Background / collapsed panels keep nothing rendered and nothing cached.
  useEffect(() => {
    if (!session.dir.visible || !active) {
      loadedRef.current = "";
      setListing(null);
      setError(null);
    }
  }, [session.dir.visible, active]);

  const enterDir = (path: string) => {
    setSelected(null);
    setDirPath(session.key, path);
  };

  const openFile = async (path: string) => {
    try {
      await ipc.openPath(path);
    } catch (e) {
      showToast(`打开失败：${String(e)}`);
    }
  };

  const shownPath = listing?.path ?? target;
  const sep = shownPath.includes("\\") ? "\\" : "/";
  const crumbs = breadcrumbs(shownPath);
  const sortedEntries = useMemo(
    () => sortEntries(listing?.entries ?? [], sortBy, sortAsc),
    [listing, sortBy, sortAsc],
  );

  return (
    <section className="dir-panel" style={{ height }}>
      <div className="dir-head">
        <span className="dir-title">文件目录</span>
        <div className="dir-mode" role="group" aria-label="路径模式">
          <button
            className={session.dir.mode === "dynamic" ? "is-on" : ""}
            title="跟随终端当前目录"
            onClick={() => setDirMode(session.key, "dynamic")}
          >
            跟随
          </button>
          <button
            className={session.dir.mode === "fixed" ? "is-on" : ""}
            title="锁定当前路径，不随终端切换目录"
            onClick={() => setDirMode(session.key, "fixed")}
          >
            固定
          </button>
        </div>
        <div className="dir-actions">
          {session.dir.mode === "fixed" && (
            <button
              title="选择固定目录"
              onClick={() => {
                void (async () => {
                  try {
                    const picked = await openDialog({
                      directory: true,
                      multiple: false,
                      title: "选择要固定的目录",
                    });
                    if (typeof picked !== "string") return;
                    setDirFixedPath(session.key, picked);
                    setDirPath(session.key, picked);
                  } catch (e) {
                    showToast(`选择目录失败：${String(e)}`);
                  }
                })();
              }}
            >
              <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
                <path
                  d="M1.8 4.2h4l1.3 1.6h7.1v6.6H1.8z"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.3"
                  strokeLinejoin="round"
                />
                <path
                  d="M8 8v4M6 10h4"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          )}
          <button title="刷新" onClick={() => void load(target, true)}>
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
            title="在资源管理器中打开"
            onClick={() =>
              shownPath && void ipc.openPath(shownPath).catch((e) => showToast(String(e)))
            }
          >
            <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
              <path
                d="M6.4 3.4H3.3v9.3h9.3V9.6M9.4 3.4h3.2v3.2M12.4 3.6 7.6 8.4"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <button title="收起面板" onClick={() => setDirVisible(session.key, false)}>
            <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
              <path
                d="M3.5 6 8 10.5 12.5 6"
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

      <div className="dir-path" title={shownPath}>
        {crumbs.length === 0 ? (
          <span className="dir-path-empty">（无路径）</span>
        ) : (
          crumbs.map((c, i) => (
            <span key={c.full} className="dir-crumb-wrap">
              <button className="dir-crumb" onClick={() => enterDir(c.full)}>
                {c.label}
              </button>
              {i < crumbs.length - 1 && <span className="dir-crumb-sep">{sep}</span>}
            </span>
          ))
        )}
        {session.dir.mode === "fixed" && <span className="dir-fixed-badge">已锁定</span>}
      </div>

      <div className="dir-sortbar">
        <span className="dir-sort-label">排序</span>
        <select
          className="dir-sort-select"
          aria-label="排序方式"
          value={sortBy}
          onChange={(e) => setSettings({ dirSortBy: e.target.value as DirSortKey })}
        >
          {(Object.keys(DIR_SORT_LABELS) as DirSortKey[]).map((k) => (
            <option key={k} value={k}>
              {DIR_SORT_LABELS[k]}
            </option>
          ))}
        </select>
        <button
          className="dir-sort-dir"
          title={sortAsc ? "当前升序，点击改为降序" : "当前降序，点击改为升序"}
          aria-label={sortAsc ? "改为降序" : "改为升序"}
          onClick={() => setSettings({ dirSortAsc: !sortAsc })}
        >
          {sortAsc ? "↑" : "↓"}
        </button>
        <div className="dir-mode" role="group" aria-label="刷新方式">
          <button
            className={!autoRefresh ? "is-on" : ""}
            title="手动刷新，不轮询"
            onClick={() => setSettings({ dirAutoRefresh: false })}
          >
            手动
          </button>
          <button
            className={autoRefresh ? "is-on" : ""}
            title="每秒重新读取一次目录"
            onClick={() => setSettings({ dirAutoRefresh: true })}
          >
            1s
          </button>
        </div>
        <span className="dir-count">{listing?.entries.length ?? 0} 项</span>
      </div>

      {autoRefresh && (
        <div className="dir-live">
          <span className="dir-pulse" />
          {lastAt ? `每秒刷新 · ${lastAt}` : "每秒刷新 · 等待首次结果"}
        </div>
      )}

      <div className="dir-list">
        {listing?.parent && (
          <div
            className="dir-row is-up"
            onDoubleClick={() => enterDir(listing.parent!)}
          >
            <span className="dir-icon">↑</span>
            <span className="dir-name">..</span>
          </div>
        )}

        {loading && !listing && <div className="dir-hint">读取中…</div>}
        {error && (
          <div className="dir-hint is-error">
            {error}
            <button className="dir-retry" onClick={() => void load(target, true)}>
              重试
            </button>
          </div>
        )}
        {!loading && !error && listing && listing.entries.length === 0 && (
          <div className="dir-hint">空目录</div>
        )}

        {sortedEntries.map((e) => (
          <div
            key={e.path}
            className={`dir-row ${selected === e.path ? "is-selected" : ""}`}
            title={e.path}
            onClick={() => setSelected(e.path)}
            onDoubleClick={() => {
              // Explorer semantics: single click selects, double click opens.
              if (e.isDir) enterDir(e.path);
              else void openFile(e.path);
            }}
            onContextMenu={(ev) => {
              // Hand it to the shell so the menu is the same one Explorer shows,
              // third-party entries included.
              ev.preventDefault();
              setSelected(e.path);
              void ipc
                .showContextMenu(e.path, ev.clientX, ev.clientY)
                .catch((err) => showToast(String(err)));
            }}
          >
            <span className={`dir-icon ${e.isDir ? "is-dir" : "is-file"}`}>
              {e.isDir ? <FolderIcon /> : <FileIcon />}
            </span>
            <span className="dir-name">{e.name}</span>
            {!e.isDir && (
              <span className="dir-size">
                {sortBy === "mtime" ? formatTime(e.mtime) : formatSize(e.size)}
              </span>
            )}
          </div>
        ))}

        {listing?.truncated && <div className="dir-hint">条目过多，仅显示前 3000 项</div>}
      </div>
    </section>
  );
}
