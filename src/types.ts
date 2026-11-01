export type ShellKind = "pwsh" | "powershell" | "cmd" | "wsl" | "gitbash" | "custom";

export interface ShellProfile {
  name: string;
  executable: string;
  args: string[];
  cwd?: string | null;
  env: Record<string, string>;
}

export interface DetectedShell {
  name: string;
  executable: string;
  args: string[];
  kind: string;
}

export interface QuickItem {
  id: string;
  label: string;
  command: string;
  autoExecute: boolean;
}

export interface PresetItem {
  label: string;
  command: string;
  autoExecute: boolean;
}

export interface Preset {
  name: string;
  description?: string;
  items: PresetItem[];
}

/**
 * `key` is the stable identity of a session: it survives restarts and owns the
 * history, quick commands and React key. `ptyId` is the ephemeral runtime id of
 * the PTY process and changes every time the shell is (re)spawned.
 */
export interface Session {
  key: string;
  ptyId: string | null;
  title: string;
  profile: ShellProfile;
  cwd: string;
  spawned: boolean;
  alive: boolean;
  exitCode: number | null;
  quickItems: QuickItem[];
  dir: DirPanelState;
}

export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
  path: string;
}

export interface DirListing {
  path: string;
  parent: string | null;
  entries: DirEntry[];
  truncated: boolean;
  /** Backend walked up to an existing ancestor because the path was gone. */
  corrected: boolean;
}

export interface DirPanelState {
  visible: boolean;
  mode: "dynamic" | "fixed";
  fixedPath: string | null;
  currentPath: string;
}

export interface HistoryItem {
  command: string;
  executedAt: number;
  executionCount: number;
  cwd?: string | null;
  score?: number;
}

export interface PtyDataPayload {
  sessionId: string;
  data: string;
}

export interface PtyExitPayload {
  sessionId: string;
  code: number;
}

export type InputMode = "input" | "passthrough" | "palette";

/** Which keys accept the ghost-text prediction. Multiple may be enabled. */
export interface AdoptKeys {
  tab: boolean;
  arrowRight: boolean;
  ctrlArrowRight: boolean;
  arrowUp: boolean;
}

export interface Settings {
  ghostText: boolean;
  ghostDebounceMs: number;
  historyLimit: number;
  autoFocusOnTuiExit: boolean;
  clickTerminalEntersPassthrough: boolean;
  maskSecrets: boolean;
  theme: "light" | "dark";
  adoptKeys: AdoptKeys;
  scrollback: number;
  webgl: boolean;
  /** Only spawn PTYs for sessions the user actually opens (lower memory). */
  lazySpawn: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  ghostText: true,
  ghostDebounceMs: 40,
  historyLimit: 5000,
  autoFocusOnTuiExit: true,
  clickTerminalEntersPassthrough: false,
  maskSecrets: true,
  theme: "light",
  adoptKeys: { tab: true, arrowRight: true, ctrlArrowRight: true, arrowUp: false },
  scrollback: 3000,
  webgl: true,
  lazySpawn: true,
};
