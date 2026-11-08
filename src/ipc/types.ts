import type {
  DetectedShell,
  DirListing,
  HistoryItem,
  InstallKind,
  Preset,
  SerialConfig,
  SerialLogConfig,
  SerialPort,
  SerialState,
  SerialView,
  ShellProfile,
  UpdateInfo,
} from "../types";

export interface SerialStatus {
  open: boolean;
  paused: boolean;
  alive: boolean;
  logPath: string | null;
}

export interface PersistedWorkspace {
  version: string;
  window: {
    width: number;
    height: number;
    x?: number;
    y?: number;
    is_maximized: boolean;
    left_sidebar_width: number;
    right_sidebar_width: number;
    right_sidebar_collapsed: boolean;
    right_dir_height?: number;
    left_ports_height?: number;
  };
  active_session_id: string | null;
  sessions: Array<{
    id: string;
    title: string;
    /** Absent in workspaces written before serial sessions existed. */
    kind?: "pty" | "serial";
    serial?: SerialState | null;
    shell_profile: {
      name: string;
      executable: string;
      args: string[];
      cwd: string | null;
      env: Record<string, string>;
    };
    quick_shortcuts: Array<{
      id: string;
      label: string;
      command: string;
      auto_execute: boolean;
    }>;
    directory_panel?: {
      is_visible: boolean;
      mode: "dynamic" | "fixed";
      fixed_path: string | null;
      current_path: string;
    };
  }>;
  global_presets: Record<string, Preset>;
}

/** Single contract implemented by both the Tauri backend adapter and the
 *  browser mock, so UI code never branches on the host. */
export interface Ipc {
  readonly isMock: boolean;
  detectShells(): Promise<DetectedShell[]>;
  createSession(
    profile: ShellProfile,
    cols: number,
    rows: number,
  ): Promise<{ id: string; cwd?: string }>;
  attachSession(sessionId: string): Promise<string>;
  writePty(sessionId: string, data: string): Promise<void>;
  resizePty(sessionId: string, cols: number, rows: number): Promise<void>;
  killSession(sessionId: string): Promise<void>;
  onPtyData(cb: (p: { sessionId: string; data: string }) => void): Promise<() => void>;
  onPtyExit(cb: (p: { sessionId: string; code: number }) => void): Promise<() => void>;

  historyAdd(
    sessionId: string,
    command: string,
    cwd: string | null,
    maxEntries: number,
    mask: boolean,
  ): Promise<void>;
  historyPrefix(sessionId: string, prefix: string): Promise<string | null>;
  historySearch(sessionId: string, query: string, limit: number): Promise<HistoryItem[]>;
  /** Commands of one session ordered by recency, for ↑/↓ browsing. */
  historyRecent(sessionId: string, limit: number): Promise<string[]>;
  historyClear(sessionId: string): Promise<void>;

  workspaceLoad(): Promise<PersistedWorkspace | null>;
  workspaceSave(state: PersistedWorkspace): Promise<void>;
  presetsLoad(): Promise<Record<string, Preset> | null>;
  presetsSave(presets: Record<string, Preset>): Promise<void>;

  settingsLoad(): Promise<Record<string, unknown> | null>;
  settingsSave(settings: Record<string, unknown>): Promise<void>;

  /** One-shot directory read; no watchers are installed on the Rust side. */
  readDirectory(path: string): Promise<DirListing>;
  openPath(path: string): Promise<void>;

  /**
   * Asks the update endpoint whether a newer version exists.
   * `null` means either "already current" or "this runtime cannot update"
   * (browser preview), so callers do not need to special-case errors.
   */
  checkUpdate(): Promise<UpdateInfo | null>;

  /**
   * Downloads and installs the update found by `checkUpdate`, then relaunches.
   * `onProgress(doneBytes, totalBytes)` is called while downloading; total is 0
   * when the server does not report a content length.
   */
  installUpdate(onProgress: (done: number, total: number) => void): Promise<void>;

  /**
   * Persists the ANSI-serialized terminal buffer so the screen can be repainted
   * after a restart. Display-only: the replay is never fed back as input.
   */
  scrollbackSave(sessionKey: string, data: string): Promise<void>;
  scrollbackLoad(sessionKey: string): Promise<string | null>;
  scrollbackClear(sessionKey: string): Promise<void>;

  /**
   * Pops the real Windows Explorer context menu for `path` at the given client
   * coordinates. Resolves once the menu is dismissed.
   */
  showContextMenu(path: string, x: number, y: number): Promise<void>;

  /** Opens (or reopens) the serial port for a serial session. */
  serialOpen(
    sessionKey: string,
    config: SerialConfig,
    view: SerialView,
    log: SerialLogConfig,
  ): Promise<void>;

  /** Closes the port so other software can claim it; data arriving while paused is lost. */
  serialPause(sessionKey: string): Promise<void>;
  serialResume(sessionKey: string): Promise<void>;

  serialStatus(sessionKey: string): Promise<SerialStatus>;
  /** Display/log changes apply immediately; `config` is stored for the next open. */
  serialUpdate(
    sessionKey: string,
    view: SerialView,
    log: SerialLogConfig,
    config?: SerialConfig,
  ): Promise<void>;

  /** Sends raw bytes (hex input is decoded on the frontend). */
  serialWriteBytes(sessionKey: string, bytes: number[]): Promise<void>;

  /** Opens the folder containing this session's log file. */
  serialRevealLog(sessionKey: string): Promise<void>;

  /** Read-only COM port listing; no port is opened on the backend side. */
  listSerialPorts(): Promise<SerialPort[]>;

  /** Portable builds keep their data next to the exe and must not self-update. */
  installKind(): Promise<InstallKind>;

  dataDir(): Promise<string>;
  openDataDir(): Promise<void>;
  /** Returns the exported file name (the file lands in `data/exports/`). */
  exportQuickCommands(json: string): Promise<string>;
  listQuickCommandExports(): Promise<string[]>;
  importQuickCommands(name: string): Promise<string>;
}
