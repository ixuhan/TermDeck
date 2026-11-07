import { fuzzyScore } from "../fuzzy";
import { maskSecrets } from "../mask";
import { mockListing } from "./mockFs";
import type { DetectedShell, DirListing, HistoryItem, Preset, ShellProfile } from "../types";
import type { Ipc, PersistedWorkspace } from "./types";

/**
 * Browser fallback transport. It emulates a shell well enough to exercise the
 * whole UI: echo, a handful of built-ins, and a fake full-screen editor that
 * really does switch xterm into the alternate screen buffer so the
 * pass-through state machine (FR-INPUT-03) can be verified without Rust.
 */

type DataCb = (p: { sessionId: string; data: string }) => void;
type ExitCb = (p: { sessionId: string; code: number }) => void;

const SEED_COMMANDS = [
  "git status -s",
  "git checkout main && git pull --rebase",
  "git log --oneline -20",
  "git push origin HEAD",
  "ninja -C build all",
  "pyocd flash -t stm32f407vg build/app.bin",
  "cargo build --release",
  "cargo test --workspace",
  "docker compose up -d",
  "kubectl get pods -A",
  "ls -la",
  "pwd",
];

class MockShell {
  private line = "";
  private inAlt = false;
  private cwd: string;

  constructor(
    readonly id: string,
    profile: ShellProfile,
    private emit: (data: string) => void,
  ) {
    this.cwd = profile.cwd || "C:\\Projects\\TermDeck";
    const shellTag = profile.name || "shell";
    this.emit(
      `\x1b[1mTermDeck\x1b[0m \x1b[90m· mock ${shellTag}\x1b[0m\r\n` +
        `\x1b[90m浏览器预览模式：输入 help 查看可用命令，输入 vim 验证直通模式\x1b[0m\r\n`,
    );
    this.prompt();
  }

  private prompt() {
    const short = this.cwd.replace(/^[A-Za-z]:\\Users\\[^\\]+/, "~");
    this.emit(`\r\n\x1b[38;5;33m${short}\x1b[0m \x1b[38;5;208m>\x1b[0m `);
  }

  write(data: string, onExec: (cmd: string) => void) {
    for (const ch of data) {
      if (this.inAlt) {
        this.altKey(ch);
        continue;
      }
      if (ch === "\r" || ch === "\n") {
        const cmd = this.line;
        this.line = "";
        this.emit("\r\n");
        if (cmd.trim()) onExec(cmd.trim());
        this.exec(cmd.trim());
      } else if (ch === "\x7f") {
        if (this.line.length > 0) {
          this.line = this.line.slice(0, -1);
          this.emit("\b \b");
        }
      } else if (ch === "\x03") {
        this.line = "";
        this.emit("^C");
        this.prompt();
      } else if (ch === "\x1b") {
        // swallow escape sequences
      } else if (ch >= " ") {
        this.line += ch;
        this.emit(ch);
      }
    }
  }

  private altKey(ch: string) {
    if (ch === "q" || ch === "\x1b") {
      this.emit("\x1b[?1049l");
      this.inAlt = false;
      this.prompt();
    } else if (ch === "j" || ch === "\x1b[B") {
      this.emit("\x1b[1B");
    }
  }

  private exec(cmd: string) {
    if (!cmd) {
      this.prompt();
      return;
    }
    const [head, ...rest] = cmd.split(/\s+/);
    switch (head) {
      case "help":
        this.emit(
          "可用命令:\r\n" +
            "  help        显示帮助\r\n" +
            "  ls / dir    列出文件\r\n" +
            "  cd <path>   切换目录\r\n" +
            "  pwd         显示当前目录\r\n" +
            "  echo <text> 原样输出\r\n" +
            "  git ...     git 演示输出\r\n" +
            "  vim / htop  进入全屏程序（验证直通模式）\r\n" +
            "  clear       清屏\r\n" +
            "  exit        结束会话\r\n",
        );
        break;
      case "ls":
      case "dir":
        this.emit(
          "build/   docs/   node_modules/   src/   src-tauri/\r\n" +
            "package.json   tsconfig.json   vite.config.ts\r\n",
        );
        break;
      case "pwd":
        this.emit(`${this.cwd}\r\n`);
        break;
      case "cd": {
        const target = rest.join(" ") || ".";
        if (target === "..") {
          const parts = this.cwd.split("\\");
          parts.pop();
          this.cwd = parts.join("\\") || "C:\\";
        } else if (target === "~") {
          this.cwd = "C:\\Users\\dev";
        } else if (target.startsWith("/")) {
          this.cwd = target;
        } else {
          this.cwd = `${this.cwd}\\${target}`;
        }
        break;
      }
      case "echo":
        this.emit(`${rest.join(" ")}\r\n`);
        break;
      case "clear":
        this.emit("\x1b[2J\x1b[H");
        break;
      case "git":
        if (rest[0] === "status") {
          this.emit(" M src/App.tsx\r\n?? src/components/\r\n");
        } else if (rest[0] === "log") {
          this.emit("a7a6648 feat: ghost text\r\n2f19c30 chore: scaffold\r\n");
        } else if (rest[0] === "checkout" || rest[0] === "pull") {
          this.emit("Already up to date.\r\n");
        } else {
          this.emit(`git: '${rest[0] ?? ""}' done\r\n`);
        }
        break;
      case "cargo":
        this.emit("   Compiling termdeck v0.1.0\r\n    Finished release [optimized] target(s)\r\n");
        break;
      case "vim":
      case "vi":
      case "nano":
        this.inAlt = true;
        this.emit("\x1b[?1049h\x1b[2J\x1b[H");
        this.emit("\x1b[90m~\r\n~\r\n~\r\n~\r\n");
        this.emit("\x1b[90m   [ mock editor ]  按 q 退出，验证输入框自动退让\x1b[0m\r\n");
        return;
      case "htop":
        this.inAlt = true;
        this.emit("\x1b[?1049h\x1b[2J\x1b[H");
        this.emit("  CPU[||||||||      32%]   MEM[||||   1.2G/16G]\r\n");
        this.emit("  PID   USER   COMMAND\r\n  1024  dev    node.exe\r\n");
        this.emit("\r\n\x1b[90m   [ mock htop ]  按 q 退出\x1b[0m\r\n");
        return;
      case "exit":
        this.emit("\r\n\x1b[90m[session ended]\x1b[0m\r\n");
        return;
      default:
        this.emit(`'${head}' 不是可识别的命令（mock 模式，输入 help 查看支持列表）\r\n`);
    }
    this.prompt();
  }
}


export function createMockIpc(): Ipc {
  const shells = new Map<string, MockShell>();
  const dataCbs = new Set<DataCb>();
  const exitCbs = new Set<ExitCb>();
  const history = new Map<string, HistoryItem[]>();
  const cwdOf = new Map<string, string>();
  const attached = new Set<string>();
  const pending = new Map<string, string[]>();
  let seq = 0;

  const emitData = (sessionId: string) => (data: string) => {
    if (!attached.has(sessionId)) {
      const arr = pending.get(sessionId) ?? [];
      arr.push(data);
      pending.set(sessionId, arr);
      return;
    }
    for (const cb of dataCbs) cb({ sessionId, data });
  };

  const ensureSeed = (sessionId: string) => {
    if (history.has(sessionId)) return;
    const now = Date.now();
    history.set(
      sessionId,
      SEED_COMMANDS.map((command, i) => ({
        command,
        executedAt: now - i * 3600_000,
        executionCount: Math.max(1, 6 - i),
        cwd: null,
      })),
    );
  };

  return {
    isMock: true,

    async detectShells(): Promise<DetectedShell[]> {
      return [
        { name: "PowerShell 7", executable: "pwsh.exe", args: ["-NoLogo"], kind: "pwsh" },
        { name: "命令提示符", executable: "cmd.exe", args: [], kind: "cmd" },
        { name: "WSL Ubuntu", executable: "wsl.exe", args: ["-d", "Ubuntu-24.04"], kind: "wsl" },
      ];
    },

    async createSession(profile: ShellProfile) {
      const id = `sess_mock_${++seq}`;
      const shell = new MockShell(id, profile, emitData(id));
      shells.set(id, shell);
      cwdOf.set(id, profile.cwd || "C:\\Projects\\TermDeck");
      ensureSeed(id);
      return { id, cwd: profile.cwd || "C:\\Projects\\TermDeck" };
    },

    async attachSession(sessionId) {
      attached.add(sessionId);
      const arr = pending.get(sessionId) ?? [];
      pending.delete(sessionId);
      return arr.join("");
    },

    async writePty(sessionId, data) {
      const shell = shells.get(sessionId);
      shell?.write(data, (cmd) => {
        void this.historyAdd(sessionId, cmd, cwdOf.get(sessionId) ?? null, 5000, false);
      });
    },

    async resizePty() {
      /* no-op in mock */
    },

    async killSession(sessionId) {
      shells.delete(sessionId);
      for (const cb of exitCbs) cb({ sessionId, code: 0 });
    },

    async onPtyData(cb) {
      dataCbs.add(cb);
      return () => dataCbs.delete(cb);
    },

    async onPtyExit(cb) {
      exitCbs.add(cb);
      return () => exitCbs.delete(cb);
    },

    async historyAdd(sessionId, command, cwd, maxEntries, mask) {
      // History is keyed by the stable session key, which survives restarts.
      ensureSeed(sessionId);
      const list = history.get(sessionId) ?? [];
      const raw = command.replace(/[\r\n]+$/, "");
      const cmd = mask ? maskSecrets(raw) : raw;
      if (!cmd.trim()) return;
      const existing = list.find((h) => h.command === cmd);
      if (existing) {
        existing.executionCount += 1;
        existing.executedAt = Date.now();
      } else {
        list.unshift({
          command: cmd,
          executedAt: Date.now(),
          executionCount: 1,
          cwd,
        });
      }
      list.sort((a, b) => b.executedAt - a.executedAt);
      history.set(sessionId, list.slice(0, maxEntries));
    },

    async historyPrefix(sessionId, prefix) {
      ensureSeed(sessionId);
      const list = history.get(sessionId) ?? [];
      const hits = list
        .filter((h) => h.command.startsWith(prefix) && h.command !== prefix)
        .sort((a, b) => b.executionCount - a.executionCount || b.executedAt - a.executedAt);
      return hits[0]?.command ?? null;
    },

    async historySearch(sessionId, query, limit) {
      ensureSeed(sessionId);
      const list = history.get(sessionId) ?? [];
      const scored: HistoryItem[] = [];
      for (const h of list) {
        if (query.trim()) {
          const s = fuzzyScore(query, h.command);
          if (s === null) continue;
          scored.push({ ...h, score: s });
        } else {
          scored.push({ ...h, score: h.executionCount * 4 });
        }
      }
      scored.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.executedAt - a.executedAt);
      return scored.slice(0, limit);
    },

    async historyRecent(sessionId, limit) {
      ensureSeed(sessionId);
      const list = history.get(sessionId) ?? [];
      return [...list]
        .sort((a, b) => b.executedAt - a.executedAt)
        .slice(0, limit)
        .map((h) => h.command);
    },

    async historyClear(sessionId) {
      history.set(sessionId, []);
    },

    async workspaceLoad() {
      const raw = localStorage.getItem("termdeck.workspace");
      if (!raw) return null;
      try {
        return JSON.parse(raw) as PersistedWorkspace;
      } catch {
        return null;
      }
    },

    async workspaceSave(state) {
      localStorage.setItem("termdeck.workspace", JSON.stringify(state));
    },

    async presetsLoad() {
      const raw = localStorage.getItem("termdeck.presets");
      if (!raw) return null;
      try {
        return JSON.parse(raw) as Record<string, Preset>;
      } catch {
        return null;
      }
    },

    async presetsSave(presets) {
      localStorage.setItem("termdeck.presets", JSON.stringify(presets));
    },

    async settingsLoad() {
      const raw = localStorage.getItem("termdeck.settings");
      if (!raw) return null;
      try {
        return JSON.parse(raw) as Record<string, unknown>;
      } catch {
        return null;
      }
    },

    async settingsSave(settings) {
      localStorage.setItem("termdeck.settings", JSON.stringify(settings));
    },

    async readDirectory(path) {
      // Small artificial delay so the loading state is observable.
      await new Promise((r) => setTimeout(r, 60));
      return mockListing(path);
    },

    async openPath(path) {
      console.log("[mock] open with default app:", path);
    },

    async checkUpdate() {
      // Browser preview: pretend a newer version exists so the settings panel
      // can be exercised without a real release endpoint.
      return {
        version: "0.4.0",
        notes: "这是浏览器预览环境，不会真的下载安装。",
        date: new Date().toISOString(),
      };
    },

    async installUpdate() {
      throw new Error("浏览器预览环境不支持自动更新");
    },

    async scrollbackSave(sessionKey, data) {
      if (data) localStorage.setItem(`termdeck.scrollback.${sessionKey}`, data);
      else localStorage.removeItem(`termdeck.scrollback.${sessionKey}`);
    },

    async scrollbackLoad(sessionKey) {
      return localStorage.getItem(`termdeck.scrollback.${sessionKey}`);
    },

    async scrollbackClear(sessionKey) {
      localStorage.removeItem(`termdeck.scrollback.${sessionKey}`);
    },

    async installKind() {
      return "installed" as const;
    },

    async dataDir() {
      return "浏览器预览模式 · 数据存于 localStorage";
    },

    async openDataDir() {
      /* no filesystem in the browser preview */
    },

    async exportQuickCommands(json) {
      const name = `quick-commands-${Date.now()}.json`;
      localStorage.setItem(`termdeck.export.${name}`, json);
      return name;
    },

    async listQuickCommandExports() {
      const names: string[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key?.startsWith("termdeck.export.")) names.push(key.slice("termdeck.export.".length));
      }
      return names.sort().reverse();
    },

    async importQuickCommands(name) {
      const raw = localStorage.getItem(`termdeck.export.${name}`);
      if (!raw) throw new Error(`找不到 ${name}`);
      return raw;
    },
  };
}
