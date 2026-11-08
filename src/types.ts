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
export type SessionKind = "pty" | "serial";

export interface SerialConfig {
  port: string;
  baud: number;
  dataBits: number;
  stopBits: number;
  parity: "none" | "odd" | "even";
  flow: "none" | "rtscts" | "xonxoff";
  /** Some boards reset when DTR is asserted. */
  dtr: boolean;
  rts: boolean;
}

export type SendNewline = "\r\n" | "\r" | "\n" | "";

export interface SerialView {
  /** Render incoming bytes as a hex dump. */
  hex: boolean;
  /** Treat a lone \r as a line break (and a lone \n as \r\n). */
  crAsNewline: boolean;
  localEcho: boolean;
  /** Appended to every send. Most firmware expects CR or CRLF. */
  sendNewline: SendNewline;
}

export interface SerialLogConfig {
  enabled: boolean;
  /** %Y %M %D %h %m %s %Port %Baud %Date */
  template: string;
  hex: boolean;
}

export interface SerialState {
  config: SerialConfig;
  view: SerialView;
  log: SerialLogConfig;
  /** Port is closed while paused, so other software can use it. */
  paused: boolean;
}

export const DEFAULT_SERIAL_VIEW: SerialView = {
  hex: false,
  crAsNewline: true,
  localEcho: false,
  sendNewline: "\r\n",
};

export const DEFAULT_SERIAL_LOG: SerialLogConfig = {
  enabled: false,
  template: "logs/%Port/%Y%M%D-%h%m%s.log",
  hex: false,
};

export const COMMON_BAUDS = [
  1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600,
];

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
  /** Absent on records restored from older workspaces. */
  kind?: SessionKind;
  serial?: SerialState | null;
}

/** One entry from the read-only serial port list. */
export interface SerialPort {
  name: string;
  kind: "usb" | "pci" | "bluetooth" | "unknown";
  label: string;
  vid: number | null;
  pid: number | null;
}

export interface UpdateInfo {
  version: string;
  notes: string | null;
  date: string | null;
}

/** Where the running binary lives: a normal install or the portable folder. */
export type InstallKind = "installed" | "portable";

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
  /** Repaint the previous screen contents when a session is (re)started. */
  restoreScrollback: boolean;
  /** Poll the serial port list every second while the panel is open. */
  serialAutoRefresh: boolean;
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
  restoreScrollback: true,
  serialAutoRefresh: false,
};
