import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type {
  DetectedShell,
  DirListing,
  HistoryItem,
  InstallKind,
  Preset,
  SerialConfig,
  SerialLogConfig,
  SerialPort,
  SerialView,
  ShellProfile,
  UpdateInfo,
} from "../types";
import type { Ipc, PersistedWorkspace, SerialStatus } from "./types";

export function createTauriIpc(): Ipc {
  // Held between checkUpdate and installUpdate: the plugin hands out an
  // Update handle that carries the resolved download URL and signature.
  let pending: Update | null = null;

  return {
    isMock: false,

    detectShells: () => invoke<DetectedShell[]>("detect_shells"),

    createSession: (profile: ShellProfile, cols: number, rows: number) =>
      invoke<{ id: string; cwd?: string }>("create_session", { profile, cols, rows }),

    attachSession: (sessionId) => invoke<string>("pty_attach", { sessionId }),

    writePty: (sessionId, data) => invoke("write_pty", { sessionId, data }),

    resizePty: (sessionId, cols, rows) => invoke("resize_pty", { sessionId, cols, rows }),

    killSession: (sessionId) => invoke("kill_session", { sessionId }),

    onPtyData: async (cb) => {
      return await listen<{ sessionId: string; data: string }>("pty:data", (e) => cb(e.payload));
    },

    onPtyExit: async (cb) => {
      return await listen<{ sessionId: string; code: number }>("pty:exit", (e) => cb(e.payload));
    },

    historyAdd: (sessionId, command, cwd, maxEntries, mask) =>
      invoke("history_add", { sessionId, command, cwd, maxEntries, mask }),

    historyPrefix: (sessionId, prefix) =>
      invoke<string | null>("history_prefix", { sessionId, prefix }),

    historySearch: (sessionId, query, limit) =>
      invoke<HistoryItem[]>("history_search", { sessionId, query, limit }),

    historyRecent: (sessionId, limit) => invoke<string[]>("history_recent", { sessionId, limit }),

    historyClear: (sessionId) => invoke("history_clear", { sessionId }),

    workspaceLoad: async () => {
      const raw = await invoke<string | null>("workspace_load");
      if (!raw) return null;
      try {
        return JSON.parse(raw) as PersistedWorkspace;
      } catch {
        return null;
      }
    },

    workspaceSave: (state) => invoke("workspace_save", { json: JSON.stringify(state, null, 2) }),

    presetsLoad: async () => {
      const raw = await invoke<string | null>("presets_load");
      if (!raw) return null;
      try {
        return JSON.parse(raw) as Record<string, Preset>;
      } catch {
        return null;
      }
    },

    presetsSave: (presets) => invoke("presets_save", { json: JSON.stringify(presets, null, 2) }),

    settingsLoad: async () => {
      const raw = await invoke<string | null>("settings_load");
      if (!raw) return null;
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return null;
      }
    },

    settingsSave: (settings) => invoke("settings_save", { json: JSON.stringify(settings, null, 2) }),

    readDirectory: (path) => invoke<DirListing>("read_directory", { path }),

    openPath: (path) => invoke("open_path", { path }),

    checkUpdate: async () => {
      const update = await check();
      pending = update;
      if (!update) return null;
      return {
        version: update.version,
        notes: update.body ?? null,
        date: update.date ?? null,
      };
    },

    installUpdate: async (onProgress) => {
      if (!pending) throw new Error("没有待安装的更新，请先检查更新");
      let total = 0;
      let done = 0;
      await pending.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
        } else if (event.event === "Progress") {
          done += event.data.chunkLength;
          onProgress(done, total);
        }
      });
      await relaunch();
    },

    scrollbackSave: (sessionKey, data) =>
      invoke("scrollback_save", { sessionKey, data }),

    scrollbackLoad: (sessionKey) =>
      invoke<string | null>("scrollback_load", { sessionKey }),

    scrollbackClear: (sessionKey) => invoke("scrollback_clear", { sessionKey }),

    listSerialPorts: () => invoke<SerialPort[]>("list_serial_ports"),

    serialRegister: (sessionKey, config, view, log) =>
      invoke("serial_register", { sessionKey, config, view, log }),

    serialOpen: (sessionKey, config, view, log) =>
      invoke("serial_open", { sessionKey, config, view, log }),

    serialPause: (sessionKey) => invoke("serial_pause", { sessionKey }),

    serialResume: (sessionKey) => invoke("serial_resume", { sessionKey }),

    serialStatus: (sessionKey) => invoke<SerialStatus>("serial_status", { sessionKey }),

    serialUpdate: (sessionKey, view, log, config) =>
      invoke("serial_update", { sessionKey, view, log, config }),

    serialWriteBytes: (sessionKey, bytes) =>
      invoke("serial_write_bytes", { sessionKey, bytes }),

    serialRevealLog: (sessionKey) => invoke("serial_reveal_log", { sessionKey }),

    setLineTimestamps: (enabled) => invoke("set_line_timestamps", { enabled }),

    showContextMenu: (path, x, y) => invoke("show_context_menu", { path, x, y }),

    installKind: () => invoke<InstallKind>("install_kind"),

    dataDir: () => invoke<string>("data_dir"),
    openDataDir: () => invoke("open_data_dir"),
    exportQuickCommands: (json) => invoke<string>("export_quick_commands", { json }),
    listQuickCommandExports: () => invoke<string[]>("list_quick_command_exports"),
    importQuickCommands: (name) => invoke<string>("import_quick_commands", { name }),
  };
}
