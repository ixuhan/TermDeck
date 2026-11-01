import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DetectedShell, DirListing, HistoryItem, Preset, ShellProfile } from "../types";
import type { Ipc, PersistedWorkspace } from "./types";

export function createTauriIpc(): Ipc {
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

    dataDir: () => invoke<string>("data_dir"),
    openDataDir: () => invoke("open_data_dir"),
    exportQuickCommands: (json) => invoke<string>("export_quick_commands", { json }),
    listQuickCommandExports: () => invoke<string[]>("list_quick_command_exports"),
    importQuickCommands: (name) => invoke<string>("import_quick_commands", { name }),
  };
}
