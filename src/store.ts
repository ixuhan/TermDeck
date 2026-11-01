import { create } from "zustand";
import { ipc, type PersistedWorkspace } from "./ipc";
import { ui } from "./focusBus";
import type {
  InputMode,
  Preset,
  PresetItem,
  QuickItem,
  Session,
  Settings,
  ShellProfile,
} from "./types";
import { DEFAULT_SETTINGS } from "./types";

const uid = () =>
  globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : `id_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

const DEFAULT_PRESETS: Record<string, Preset> = {
  embedded_arm: {
    name: "嵌入式构建套件",
    description: "ARM 固件编译与烧录",
    items: [
      { label: "编译全部", command: "ninja -C build all", autoExecute: true },
      { label: "清理构建", command: "ninja -C build clean", autoExecute: true },
      { label: "固件烧录", command: "pyocd flash -t stm32f407vg build/app.bin", autoExecute: false },
    ],
  },
  devops: {
    name: "通用运维",
    description: "容器与集群常用操作",
    items: [
      { label: "查看容器", command: "docker ps --format 'table {{.Names}}\\t{{.Status}}'", autoExecute: true },
      { label: "集群 Pods", command: "kubectl get pods -A", autoExecute: true },
      { label: "查看日志", command: "docker logs -f --tail 100 ", autoExecute: false },
    ],
  },
};

const DEFAULT_QUICK: PresetItem[] = [
  { label: "Git 状态", command: "git status -s", autoExecute: true },
  { label: "拉取主干", command: "git checkout main && git pull --rebase", autoExecute: true },
  { label: "查看分支日志", command: "git log --oneline -20", autoExecute: false },
];

export interface Layout {
  leftWidth: number;
  rightWidth: number;
  rightCollapsed: boolean;
}

interface Store {
  ready: boolean;
  sessions: Session[];
  activeKey: string | null;
  mode: InputMode;
  manualLock: boolean;
  settingsOpen: boolean;
  layout: Layout;
  presets: Record<string, Preset>;
  settings: Settings;
  lastError: string | null;
  toast: string | null;
  dataDir: string;

  boot: () => Promise<void>;
  createSession: (profile?: ShellProfile) => Promise<void>;
  closeSession: (key: string) => Promise<void>;
  activate: (key: string) => void;
  renameSession: (key: string, title: string) => void;
  reorderSessions: (from: number, to: number) => void;
  setCwd: (key: string, cwd: string) => void;
  markExit: (key: string, code: number) => void;
  restartSession: (key: string) => Promise<void>;
  ensureSpawned: (key: string) => Promise<void>;

  setMode: (mode: InputMode) => void;
  toggleManualLock: () => void;
  setSettingsOpen: (open: boolean) => void;
  fillCommand: (text: string) => void;

  addQuick: (key: string) => void;
  updateQuick: (key: string, itemId: string, patch: Partial<QuickItem>) => void;
  removeQuick: (key: string, itemId: string) => void;
  moveQuick: (key: string, itemId: string, dir: -1 | 1) => void;
  applyPreset: (key: string, presetKey: string) => void;
  savePreset: (name: string) => void;
  exportQuickCommands: () => Promise<string | null>;
  importQuickCommands: (fileName: string) => Promise<string | null>;
  listExports: () => Promise<string[]>;

  setLayout: (patch: Partial<Layout>) => void;
  setSettings: (patch: Partial<Settings>) => void;
  recordCommand: (sessionKey: string, command: string, cwd: string | null) => void;
  clearError: () => void;
  showToast: (msg: string) => void;
  persistNow: () => Promise<void>;
}

let saveTimer: number | undefined;
let toastTimer: number | undefined;
let booted = false;
let availableShells: Array<{ name: string; executable: string; args: string[] }> = [];

const defaultProfile = (): ShellProfile => {
  const first = availableShells[0];
  if (first) {
    return { name: first.name, executable: first.executable, args: first.args, cwd: null, env: {} };
  }
  return {
    name: "命令提示符",
    executable: "C:\\Windows\\System32\\cmd.exe",
    args: [],
    cwd: null,
    env: {},
  };
};

/** Deep copy so a session never shares objects with the preset or another session. */
const toQuickItems = (items: PresetItem[]): QuickItem[] =>
  items.map((i) => ({ id: uid(), label: i.label, command: i.command, autoExecute: i.autoExecute }));

export const useStore = create<Store>((set, get) => {
  const schedule = () => {
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void get().persistNow(), 600);
  };

  /** Spawn the PTY for a session record that exists but has no runtime yet. */
  const spawn = async (session: Session): Promise<Session> => {
    const profile: ShellProfile = {
      ...session.profile,
      cwd: session.cwd || session.profile.cwd || null,
    };
    const { id } = await ipc.createSession(profile, 120, 30);
    return { ...session, ptyId: id, spawned: true, alive: true, exitCode: null };
  };

  return {
    ready: false,
    sessions: [],
    activeKey: null,
    mode: "input",
    manualLock: false,
    settingsOpen: false,
    layout: { leftWidth: 240, rightWidth: 280, rightCollapsed: false },
    presets: DEFAULT_PRESETS,
    settings: DEFAULT_SETTINGS,
    lastError: null,
    toast: null,
    dataDir: "",

    async boot() {
      if (booted) return;
      booted = true;

      const [saved, loadedPresets, loadedSettings, dir] = await Promise.all([
        ipc.workspaceLoad(),
        ipc.presetsLoad(),
        ipc.settingsLoad(),
        ipc.dataDir().catch(() => ""),
      ]);
      const presets = loadedPresets ?? DEFAULT_PRESETS;
      const settings: Settings = loadedSettings
        ? { ...DEFAULT_SETTINGS, ...(loadedSettings as Partial<Settings>) }
        : DEFAULT_SETTINGS;

      set({ presets, settings, dataDir: dir });

      if (saved && saved.sessions.length > 0) {
        const sessions: Session[] = saved.sessions.map((s) => ({
          key: s.id || uid(),
          ptyId: null,
          title: s.title,
          profile: {
            name: s.shell_profile.name,
            executable: s.shell_profile.executable,
            args: s.shell_profile.args ?? [],
            cwd: s.shell_profile.cwd,
            env: s.shell_profile.env ?? {},
          },
          cwd: s.shell_profile.cwd ?? "",
          spawned: false,
          alive: false,
          exitCode: null,
          quickItems: s.quick_shortcuts.map((q) => ({
            id: q.id || uid(),
            label: q.label,
            command: q.command,
            autoExecute: q.auto_execute,
          })),
        }));

        const activeKey =
          sessions.find((x) => x.key === saved.active_session_id)?.key ?? sessions[0].key;

        set({
          sessions,
          activeKey,
          layout: {
            leftWidth: saved.window?.left_sidebar_width ?? 240,
            rightWidth: saved.window?.right_sidebar_width ?? 280,
            rightCollapsed: saved.window?.right_sidebar_collapsed ?? false,
          },
          ready: true,
        });

        // Restore only what the user is looking at; the rest boot on demand.
        if (settings.lazySpawn) {
          await get().ensureSpawned(activeKey);
        } else {
          for (const s of sessions) await get().ensureSpawned(s.key);
        }
        return;
      }

      const detected = await ipc.detectShells().catch(() => []);
      availableShells = detected.map((d) => ({
        name: d.name,
        executable: d.executable,
        args: d.args,
      }));
      const picks = detected.slice(0, 2);
      if (picks.length === 0) {
        availableShells = [
          { name: "命令提示符", executable: "C:\\Windows\\System32\\cmd.exe", args: [] },
        ];
        picks.push({
          name: "命令提示符",
          executable: "C:\\Windows\\System32\\cmd.exe",
          args: [],
          kind: "cmd",
        });
      }
      for (const p of picks) {
        await get().createSession({
          name: p.name,
          executable: p.executable,
          args: p.args,
          cwd: null,
          env: {},
        });
      }
      set({ ready: true });
    },

    async createSession(profile) {
      const p = profile ?? defaultProfile();
      const draft: Session = {
        key: uid(),
        ptyId: null,
        title: p.name,
        profile: p,
        cwd: p.cwd ?? "",
        spawned: false,
        alive: false,
        exitCode: null,
        quickItems: toQuickItems(DEFAULT_QUICK),
      };
      set((s) => ({ sessions: [...s.sessions, draft], activeKey: draft.key }));
      try {
        const spawned = await spawn(draft);
        set((s) => ({
          sessions: s.sessions.map((x) => (x.key === draft.key ? spawned : x)),
        }));
      } catch (err) {
        set({ lastError: `创建会话失败：${String(err)}` });
      }
      schedule();
    },

    async ensureSpawned(key) {
      const session = get().sessions.find((x) => x.key === key);
      if (!session || session.spawned) return;
      try {
        const spawned = await spawn(session);
        set((s) => ({
          sessions: s.sessions.map((x) => (x.key === key ? spawned : x)),
        }));
      } catch (err) {
        set({ lastError: `启动会话失败：${String(err)}` });
      }
    },

    async closeSession(key) {
      const session = get().sessions.find((x) => x.key === key);
      if (session?.ptyId) await ipc.killSession(session.ptyId).catch(() => undefined);
      set((s) => {
        const sessions = s.sessions.filter((x) => x.key !== key);
        const activeKey =
          s.activeKey === key ? (sessions[sessions.length - 1]?.key ?? null) : s.activeKey;
        return { sessions, activeKey };
      });
      schedule();
    },

    activate(key) {
      const state = get();
      // Keep the pass-through state when the user locked it manually; otherwise
      // every session switch used to silently drop back to input mode (#8).
      set({
        activeKey: key,
        mode: state.manualLock ? "passthrough" : "input",
      });
      void get().ensureSpawned(key);
      schedule();
    },

    renameSession(key, title) {
      set((s) => ({
        sessions: s.sessions.map((x) => (x.key === key ? { ...x, title } : x)),
      }));
      schedule();
    },

    reorderSessions(from, to) {
      set((s) => {
        const list = [...s.sessions];
        const [moved] = list.splice(from, 1);
        list.splice(to, 0, moved);
        return { sessions: list };
      });
      schedule();
    },

    setCwd(key, cwd) {
      if (!cwd) return;
      set((s) => ({
        sessions: s.sessions.map((x) =>
          x.key === key ? { ...x, cwd, profile: { ...x.profile, cwd } } : x,
        ),
      }));
      // Persist so the next launch reopens in the same directory (#10).
      schedule();
    },

    markExit(key, code) {
      set((s) => ({
        sessions: s.sessions.map((x) =>
          x.key === key ? { ...x, alive: false, exitCode: code, ptyId: null } : x,
        ),
      }));
    },

    async restartSession(key) {
      const session = get().sessions.find((x) => x.key === key);
      if (!session) return;
      if (session.ptyId) await ipc.killSession(session.ptyId).catch(() => undefined);
      const draft = { ...session, spawned: false, ptyId: null };
      try {
        const spawned = await spawn(draft);
        set((s) => ({
          sessions: s.sessions.map((x) => (x.key === key ? spawned : x)),
        }));
      } catch (err) {
        set({ lastError: `重启会话失败：${String(err)}` });
      }
      schedule();
    },

    setMode(mode) {
      set({ mode });
    },

    toggleManualLock() {
      set((s) => ({
        manualLock: !s.manualLock,
        mode: s.manualLock ? "input" : "passthrough",
      }));
    },

    setSettingsOpen(open) {
      set({ settingsOpen: open });
    },

    fillCommand(text) {
      // Filling always means "I want to edit this", so leave pass-through and
      // release the manual lock, otherwise the bar stays hidden (#9).
      set({ mode: "input", manualLock: false });
      ui.fillCommand(text);
    },

    addQuick(key) {
      set((s) => ({
        sessions: s.sessions.map((x) =>
          x.key === key
            ? {
                ...x,
                quickItems: [
                  ...x.quickItems,
                  { id: uid(), label: "新指令", command: "", autoExecute: true },
                ],
              }
            : x,
        ),
      }));
      schedule();
    },

    updateQuick(key, itemId, patch) {
      set((s) => ({
        sessions: s.sessions.map((x) =>
          x.key === key
            ? {
                ...x,
                quickItems: x.quickItems.map((q) => (q.id === itemId ? { ...q, ...patch } : q)),
              }
            : x,
        ),
      }));
      schedule();
    },

    removeQuick(key, itemId) {
      set((s) => ({
        sessions: s.sessions.map((x) =>
          x.key === key ? { ...x, quickItems: x.quickItems.filter((q) => q.id !== itemId) } : x,
        ),
      }));
      schedule();
    },

    moveQuick(key, itemId, dir) {
      set((s) => ({
        sessions: s.sessions.map((x) => {
          if (x.key !== key) return x;
          const list = [...x.quickItems];
          const i = list.findIndex((q) => q.id === itemId);
          const j = i + dir;
          if (i < 0 || j < 0 || j >= list.length) return x;
          [list[i], list[j]] = [list[j], list[i]];
          return { ...x, quickItems: list };
        }),
      }));
      schedule();
    },

    applyPreset(key, presetKey) {
      const preset = get().presets[presetKey];
      if (!preset) return;
      // Every session gets its own deep copy with fresh ids, so editing one
      // session can never leak into another or back into the template (#5).
      const clone = toQuickItems(preset.items);
      set((s) => ({
        sessions: s.sessions.map((x) => (x.key === key ? { ...x, quickItems: clone } : x)),
      }));
      schedule();
    },

    savePreset(name) {
      const active = get().sessions.find((x) => x.key === get().activeKey);
      if (!active || !name.trim()) return;
      const key = name.trim().toLowerCase().replace(/\s+/g, "_");
      set((s) => ({
        presets: {
          ...s.presets,
          [key]: {
            name: name.trim(),
            items: active.quickItems.map((q) => ({
              label: q.label,
              command: q.command,
              autoExecute: q.autoExecute,
            })),
          },
        },
      }));
      void ipc.presetsSave(get().presets);
    },

    async listExports() {
      return ipc.listQuickCommandExports().catch(() => []);
    },

    async exportQuickCommands() {
      const active = get().sessions.find((x) => x.key === get().activeKey);
      if (!active) {
        set({ lastError: "请先选择一个会话再导出指令集" });
        return null;
      }
      const payload = {
        version: "1.0.0",
        kind: "termdeck.quick-commands",
        exportedAt: Date.now(),
        sessionTitle: active.title,
        commands: active.quickItems.map((q) => ({
          label: q.label,
          command: q.command,
          auto_execute: q.autoExecute,
        })),
      };
      try {
        const path = await ipc.exportQuickCommands(JSON.stringify(payload, null, 2));
        return path;
      } catch (e) {
        set({ lastError: `导出失败：${String(e)}` });
        return null;
      }
    },

    async importQuickCommands(fileName) {
      const active = get().sessions.find((x) => x.key === get().activeKey);
      if (!active) {
        set({ lastError: "请先选择一个会话再导入指令集" });
        return null;
      }
      try {
        const raw = await ipc.importQuickCommands(fileName);
        const parsed = JSON.parse(raw) as {
          commands?: Array<{ label?: string; command?: string; auto_execute?: boolean }>;
          items?: Array<{ label?: string; command?: string; autoExecute?: boolean }>;
        };
        const list = parsed.commands ?? parsed.items ?? [];
        if (!Array.isArray(list) || list.length === 0) return "文件里没有可导入的指令";
        const items: QuickItem[] = list
          .filter((i) => typeof i.command === "string" && i.command.trim() !== "")
          .map((i) => ({
            id: uid(),
            label: (i.label || "未命名").trim(),
            command: (i.command as string).trim(),
            autoExecute: Boolean(
              (i as { auto_execute?: boolean }).auto_execute ??
                (i as { autoExecute?: boolean }).autoExecute,
            ),
          }));
        if (items.length === 0) return "文件中没有有效指令";
        // Import replaces only the active session's list.
        set((s) => ({
          sessions: s.sessions.map((x) =>
            x.key === active.key ? { ...x, quickItems: items } : x,
          ),
        }));
        schedule();
        return null;
      } catch (e) {
        return `导入失败：${String(e)}`;
      }
    },

    setLayout(patch) {
      set((s) => ({ layout: { ...s.layout, ...patch } }));
      schedule();
    },

    setSettings(patch) {
      set((s) => ({ settings: { ...s.settings, ...patch } }));
      void ipc.settingsSave({ ...get().settings }).catch(() => undefined);
      schedule();
    },

    recordCommand(sessionKey, command, cwd) {
      const { settings } = get();
      void ipc.historyAdd(sessionKey, command, cwd, settings.historyLimit, settings.maskSecrets);
    },

    clearError() {
      set({ lastError: null });
    },

    showToast(msg) {
      window.clearTimeout(toastTimer);
      set({ toast: msg });
      toastTimer = window.setTimeout(() => set({ toast: null }), 2600);
    },

    async persistNow() {
      const s = get();
      const state: PersistedWorkspace = {
        version: "1.1.0",
        window: {
          width: window.innerWidth,
          height: window.innerHeight,
          is_maximized: false,
          left_sidebar_width: s.layout.leftWidth,
          right_sidebar_width: s.layout.rightWidth,
          right_sidebar_collapsed: s.layout.rightCollapsed,
        },
        active_session_id: s.activeKey,
        sessions: s.sessions.map((x) => ({
          id: x.key,
          title: x.title,
          shell_profile: {
            name: x.profile.name,
            executable: x.profile.executable,
            args: x.profile.args,
            cwd: x.cwd || x.profile.cwd || null,
            env: x.profile.env ?? {},
          },
          quick_shortcuts: x.quickItems.map((q) => ({
            id: q.id,
            label: q.label,
            command: q.command,
            auto_execute: q.autoExecute,
          })),
        })),
        global_presets: s.presets,
      };
      await ipc.workspaceSave(state).catch((e) => set({ lastError: String(e) }));
    },
  };
});

// Dev-only introspection hook for the automated UI suite.
if (import.meta.env.DEV) {
  (window as unknown as { __tdStore?: typeof useStore }).__tdStore = useStore;
}

export const useActiveSession = (): Session | undefined => {
  const sessions = useStore((s) => s.sessions);
  const activeKey = useStore((s) => s.activeKey);
  return sessions.find((s) => s.key === activeKey);
};
