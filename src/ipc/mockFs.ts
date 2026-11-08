import type { DirListing } from "../types";

/**
 * Tiny in-memory filesystem for the browser preview so the directory panel can
 * be exercised without Rust. Paths are normalised to forward slashes for
 * lookup, which keeps the table readable regardless of the separator used by
 * the caller.
 */
const BS = "\\";

interface Node {
  name: string;
  isDir: boolean;
  size?: number;
}

const VFS: Record<string, Node[]> = {
  "c:/projects/termdeck": [
    { name: "src", isDir: true },
    { name: "src-tauri", isDir: true },
    { name: "docs", isDir: true },
    { name: "scripts", isDir: true },
    { name: "package.json", isDir: false, size: 812 },
    { name: "README.md", isDir: false, size: 9420 },
    { name: "vite.config.ts", isDir: false, size: 731 },
    { name: "tsconfig.json", isDir: false, size: 604 },
  ],
  "c:/projects/termdeck/src": [
    { name: "components", isDir: true },
    { name: "ipc", isDir: true },
    { name: "App.tsx", isDir: false, size: 5820 },
    { name: "main.tsx", isDir: false, size: 468 },
    { name: "store.ts", isDir: false, size: 19840 },
    { name: "styles.css", isDir: false, size: 21450 },
    { name: "types.ts", isDir: false, size: 2380 },
  ],
  "c:/projects/termdeck/src/components": [
    { name: "CommandBar.tsx", isDir: false, size: 16220 },
    { name: "DirectoryPanel.tsx", isDir: false, size: 9210 },
    { name: "LeftRail.tsx", isDir: false, size: 7640 },
    { name: "QuickPanel.tsx", isDir: false, size: 11030 },
    { name: "TerminalView.tsx", isDir: false, size: 8150 },
  ],
  "c:/projects/termdeck/docs": [
    { name: "images", isDir: true },
    { name: "BUILDING.md", isDir: false, size: 9120 },
    { name: "CHANGELOG.md", isDir: false, size: 4310 },
    { name: "RELEASE.md", isDir: false, size: 6310 },
    { name: "SRS.md", isDir: false, size: 41200 },
  ],
  "c:/projects/termdeck/docs/images": [
    { name: "hero.png", isDir: false, size: 53058 },
    { name: "history-palette.png", isDir: false, size: 65728 },
    { name: "settings.png", isDir: false, size: 116460 },
  ],
  "c:/users/dev": [
    { name: "Desktop", isDir: true },
    { name: "Documents", isDir: true },
    { name: "Downloads", isDir: true },
    { name: "AppData", isDir: true },
  ],
};

const FALLBACK: Node[] = [
  { name: "Documents", isDir: true },
  { name: "Downloads", isDir: true },
  { name: "notes.txt", isDir: false, size: 128 },
];

const lookupKey = (path: string) => path.split(BS).join("/").toLowerCase();

function trimTrailing(path: string): string {
  let key = path.trim();
  while (key.length > 3 && (key.endsWith(BS) || key.endsWith("/"))) key = key.slice(0, -1);
  return key;
}

export function parentPath(path: string): string | null {
  const key = trimTrailing(path);
  const idx = Math.max(key.lastIndexOf(BS), key.lastIndexOf("/"));
  if (idx < 0) return null;
  const head = key.slice(0, idx);
  if (/^[A-Za-z]:$/.test(head)) return head + BS;
  return head || null;
}

export function mockListing(rawPath: string): DirListing {
  const key = trimTrailing(rawPath);
  const nodes = VFS[lookupKey(key)] ?? FALLBACK;
  const sep = key.includes(BS) ? BS : "/";
  const base = key.endsWith(sep) ? key : key + sep;

  // Deterministic times: the first node is newest, so "by mtime" deliberately
  // differs from "by name" and the sort controls can be asserted in tests.
  const baseTime = Date.UTC(2026, 10, 8, 10, 0, 0);
  const entries = nodes
    .map((n, i) => ({
      name: n.name,
      isDir: n.isDir,
      size: n.size ?? 0,
      mtime: baseTime + (nodes.length - i) * 3_600_000,
      path: base + n.name,
    }))
    .sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));

  return {
    path: key,
    parent: parentPath(key),
    entries,
    truncated: false,
    corrected: false,
  };
}
