import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ipc } from "../ipc";
import { trackCwd } from "../cwd";
import { parseHexInput } from "../hex";
import { ui } from "../focusBus";
import { useStore } from "../store";
import type { HistoryItem, Session } from "../types";
import { HistoryPalette } from "./HistoryPalette";

export function CommandBar({ session }: { session: Session }) {
  const [value, setValue] = useState("");
  const [ghost, setGhost] = useState("");
  const [ghostPos, setGhostPos] = useState({ left: 0, top: 0 });
  const [caretAtEnd, setCaretAtEnd] = useState(true);
  const [paletteOpen, setPaletteOpenState] = useState(false);
  const [paletteItems, setPaletteItems] = useState<HistoryItem[]>([]);
  const [paletteIndex, setPaletteIndex] = useState(0);
  // ↑/↓ browsing: null means "not browsing", so the draft line is safe.
  const [histIndex, setHistIndex] = useState<number | null>(null);

  const taRef = useRef<HTMLTextAreaElement>(null);
  const endMarkRef = useRef<HTMLSpanElement>(null);
  const seqRef = useRef(0);
  const backupRef = useRef("");
  const histListRef = useRef<string[]>([]);
  const histDraftRef = useRef("");
  const histLoadingRef = useRef(false);
  // Only consumed when the rendered value actually matches the text we intended
  // to place the caret in; otherwise a leftover entry would yank the caret back
  // while the user is already typing.
  const pendingCaret = useRef<{ text: string; pos: number } | null>(null);

  const mode = useStore((s) => s.mode);
  const settings = useStore((s) => s.settings);
  const setMode = useStore((s) => s.setMode);
  const recordCommand = useStore((s) => s.recordCommand);
  const showToast = useStore((s) => s.showToast);

  const setPaletteOpen = useCallback(
    (open: boolean) => {
      setPaletteOpenState(open);
      setMode(open ? "palette" : "input");
    },
    [setMode],
  );

  /** Write to whichever PTY currently backs this session, spawning it if needed. */
  const writeToPty = useCallback(
    async (data: string) => {
      const state = useStore.getState();
      let pid = state.sessions.find((s) => s.key === session.key)?.ptyId;
      if (!pid) {
        await state.ensureSpawned(session.key);
        pid = useStore.getState().sessions.find((s) => s.key === session.key)?.ptyId;
      }
      if (pid) await ipc.writePty(pid, data);
    },
    [session.key],
  );

  const syncCaret = useCallback(() => {
    const ta = taRef.current;
    if (!ta) return;
    setCaretAtEnd(ta.selectionStart === ta.value.length && ta.selectionEnd === ta.value.length);
  }, []);

  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = `${Math.min(Math.max(ta.scrollHeight, 26), 132)}px`;
  }, [value]);

  useLayoutEffect(() => {
    const pending = pendingCaret.current;
    if (!pending) return;
    const ta = taRef.current;
    if (ta && ta.value === pending.text) {
      ta.selectionStart = pending.pos;
      ta.selectionEnd = pending.pos;
      setCaretAtEnd(true);
    }
    pendingCaret.current = null;
  }, [value]);

  const applyValue = useCallback((next: string) => {
    setValue(next);
    pendingCaret.current = { text: next, pos: next.length };
  }, []);

  // ------------------------------------------------------------ ghost queries
  useEffect(() => {
    if (!settings.ghostText || !caretAtEnd || value.trim() === "" || paletteOpen) {
      setGhost("");
      return;
    }
    const seq = ++seqRef.current;
    const timer = window.setTimeout(() => {
      void ipc.historyPrefix(session.key, value).then((hit) => {
        if (seqRef.current !== seq) return;
        if (hit && hit !== value && hit.startsWith(value)) setGhost(hit.slice(value.length));
        else setGhost("");
      });
    }, settings.ghostDebounceMs);
    return () => window.clearTimeout(timer);
  }, [value, caretAtEnd, session.key, settings.ghostText, settings.ghostDebounceMs, paletteOpen]);

  useLayoutEffect(() => {
    const mark = endMarkRef.current;
    if (mark) setGhostPos({ left: mark.offsetLeft, top: mark.offsetTop });
  }, [value, ghost]);

  /**
   * Shell-style history browsing. ↑ walks back through the session's commands
   * (newest first), ↓ walks forward, and stepping past the newest restores
   * whatever was typed before browsing started.
   */
  const navigateHistory = useCallback(
    // dir = 1 walks to older entries, dir = -1 walks back towards the draft.
    async (dir: 1 | -1) => {
      if (histIndex === null) {
        if (dir === -1 || histLoadingRef.current) return;
        histLoadingRef.current = true;
        try {
          const list = await ipc.historyRecent(session.key, 100);
          if (list.length === 0) return;
          histListRef.current = list;
          histDraftRef.current = value;
          setHistIndex(0);
          applyValue(list[0]);
        } finally {
          histLoadingRef.current = false;
        }
        return;
      }
      const next = histIndex + dir;
      if (next < 0) {
        // Walked past the newest entry: restore whatever the user had typed.
        setHistIndex(null);
        applyValue(histDraftRef.current);
        return;
      }
      if (next >= histListRef.current.length) return;
      setHistIndex(next);
      applyValue(histListRef.current[next]);
    },
    [histIndex, session.key, value, applyValue],
  );

  useEffect(() => {
    ui.focusCommand = () => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = ta.value.length;
    };
    ui.fillCommand = (text: string) => {
      applyValue(text);
      setGhost("");
      requestAnimationFrame(() => taRef.current?.focus());
    };
  }, [applyValue]);

  useEffect(() => {
    if (mode === "input") ui.focusCommand();
  }, [mode, session.key]);

  useEffect(() => {
    setValue("");
    setGhost("");
    setPaletteOpenState(false);
    setHistIndex(null);
  }, [session.key]);

  // ---------------------------------------------------------------- submitting
  const submit = useCallback(() => {
    const raw = value;

    // A serial session has no shell: Enter sends bytes, not a command line.
    // Read the live session, not the one captured by this callback: the session
    // object gains `kind`/`serial` after creation while its key stays the same.
    const live = useStore.getState().sessions.find((x) => x.key === session.key);
    if (live?.kind === "serial" && live.serial) {
      const serial = live.serial;
      const text = raw;
      void (async () => {
        try {
          let bytes: number[] | null = serial.view.hex
            ? parseHexInput(text)
            : Array.from(new TextEncoder().encode(text));
          if (bytes === null) {
            useStore.getState().showToast("HEX 输入无效：只允许 0-9 A-F 与空格");
            return;
          }
          bytes = bytes.concat(Array.from(new TextEncoder().encode(serial.view.sendNewline)));
          await ipc.serialWriteBytes(session.key, bytes);
          // Clear first: if recording history throws, the text is already gone
          // and the user is not left staring at a payload that was sent.
          setValue("");
          setGhost("");
          setCaretAtEnd(true);
          setHistIndex(null);
          histDraftRef.current = "";
          if (text.trim() !== "") {
            // Kept as the session's send history, so ↑ can resend.
            recordCommand(session.key, text, null);
          }
        } catch (e) {
          useStore.getState().showToast(`发送失败：${String(e)}`);
        }
      })();
      return;
    }

    if (raw.trim() === "") {
      void writeToPty("\r");
      setValue("");
      setGhost("");
      return;
    }
    const norm = raw.replace(/\r\n/g, "\n");
    if (norm.split("\n").length > 20 && !window.confirm("将一次发送多行命令，确认执行？")) return;

    void writeToPty(norm.replace(/\n/g, "\r") + "\r");
    recordCommand(session.key, norm, session.cwd || null);
    // Persist directory changes so the next launch reopens in the same place.
    const nextCwd = trackCwd(session.cwd, norm);
    if (nextCwd) useStore.getState().setCwd(session.key, nextCwd);
    setValue("");
    setGhost("");
    setCaretAtEnd(true);
    setHistIndex(null);
    histDraftRef.current = "";
  }, [value, session.key, session.cwd, recordCommand, writeToPty]);

  // ------------------------------------------------------------------ palette
  const openPalette = useCallback(async () => {
    backupRef.current = value;
    const items = await ipc.historySearch(session.key, value, 60);
    setPaletteItems(items);
    setPaletteIndex(0);
    setPaletteOpen(true);
  }, [session.key, value, setPaletteOpen]);

  useEffect(() => {
    if (!paletteOpen) return;
    const seq = ++seqRef.current;
    const t = window.setTimeout(() => {
      void ipc.historySearch(session.key, value, 60).then((items) => {
        if (seqRef.current !== seq) return;
        setPaletteItems(items);
        setPaletteIndex(0);
      });
    }, 40);
    return () => window.clearTimeout(t);
  }, [value, paletteOpen, session.key]);

  const pick = useCallback(
    (execute: boolean) => {
      const item = paletteItems[paletteIndex];
      if (!item) return;
      if (execute) {
        void writeToPty(item.command + "\r");
        recordCommand(session.key, item.command, session.cwd || null);
        setValue("");
        setGhost("");
      } else {
        applyValue(item.command);
      }
      setPaletteOpen(false);
      requestAnimationFrame(() => taRef.current?.focus());
    },
    [
      paletteItems,
      paletteIndex,
      session.key,
      session.cwd,
      recordCommand,
      setPaletteOpen,
      applyValue,
      writeToPty,
    ],
  );

  // ------------------------------------------------------------------- keys
  const adopt = settings.adoptKeys;

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const composing = e.nativeEvent.isComposing || (e.nativeEvent as KeyboardEvent).keyCode === 229;

    if (paletteOpen) {
      // Ctrl+R while the palette is open must not fall through to the webview,
      // which would reload the whole app. Treat it as "close and restore".
      if (e.key === "r" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        applyValue(backupRef.current);
        setPaletteOpen(false);
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setPaletteIndex((i) => Math.min(i + 1, paletteItems.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setPaletteIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        pick(true);
      } else if (e.key === "Tab") {
        e.preventDefault();
        pick(false);
      } else if (e.key === "Escape") {
        e.preventDefault();
        applyValue(backupRef.current);
        setPaletteOpen(false);
      }
      return;
    }

    if (e.key === "Enter" && !e.shiftKey) {
      if (composing) return; // IME confirmation must not submit (E01)
      e.preventDefault();
      submit();
      return;
    }

    if (e.key === "r" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void openPalette();
      return;
    }

    // Bare ↑/↓ browses this session's history. ↑ still adopts ghost text first
    // when the user has enabled that in settings and a prediction is showing.
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      const ghostTakesUp =
        e.key === "ArrowUp" && ghost !== "" && adopt.arrowUp && histIndex === null;
      if (!ghostTakesUp) {
        e.preventDefault();
        void navigateHistory(e.key === "ArrowUp" ? 1 : -1);
        return;
      }
    }

    if (ghost) {
      const fullAdopt =
        (e.key === "Tab" && adopt.tab) ||
        (e.key === "ArrowRight" && !e.ctrlKey && caretAtEnd && adopt.arrowRight) ||
        (e.key === "ArrowUp" && adopt.arrowUp);

      if (fullAdopt) {
        e.preventDefault();
        applyValue(value + ghost);
        setGhost("");
        return;
      }
      if (e.key === "ArrowRight" && e.ctrlKey && adopt.ctrlArrowRight) {
        e.preventDefault();
        const m = /^\s*\S+\s*/.exec(ghost);
        const chunk = m ? m[0] : ghost;
        applyValue(value + chunk);
        setGhost(ghost.slice(chunk.length));
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setGhost("");
        return;
      }
    }
  };

  /**
   * Clears the history of *this* session only. Explicit confirmation because
   * it is irreversible, and the prompt names the session so the scope is clear.
   */
  const clearHistory = useCallback(async () => {
    const ok = window.confirm(
      `清空「${session.title}」的命令历史？\n\n` +
        "只影响当前会话，其他会话的历史不受影响。\n此操作不可撤销，清空后 Ghost Text 与历史检索都不再有记录。",
    );
    if (!ok) return;
    try {
      await ipc.historyClear(session.key);
      histListRef.current = [];
      histDraftRef.current = "";
      setHistIndex(null);
      setGhost("");
      showToast("已清空当前会话的命令历史");
    } catch (e) {
      showToast(`清空失败：${String(e)}`);
    }
  }, [session.key, session.title, showToast]);

  const collapsed = mode === "passthrough";

  return (
    <div className={`cmdbar-wrap ${collapsed ? "is-collapsed" : ""}`}>
      {paletteOpen && (
        <HistoryPalette
          items={paletteItems}
          index={paletteIndex}
          onHover={setPaletteIndex}
          onPick={(i) => {
            const item = paletteItems[i];
            if (!item) return;
            void writeToPty(item.command + "\r");
            recordCommand(session.key, item.command, session.cwd || null);
            setValue("");
            setPaletteOpen(false);
          }}
        />
      )}

      <div className="cmdbar">
        <div className="cmd-row">
          <button
            className="cmd-history"
            title="历史命令列表 (Ctrl+R)"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void openPalette()}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
              <path
                d="M8 3.2v4.4l3 1.8M8 1.6a6.4 6.4 0 1 0 4.9 2.3M12.9 1.6v2.9h-2.9"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
          <span className="cmd-prompt" aria-hidden>
            ›
          </span>
          <div className="cmd-field">
            <textarea
              ref={taRef}
              className="cmd-input"
              rows={1}
              spellCheck={false}
              autoComplete="off"
              value={value}
              placeholder={
                mode === "passthrough"
                  ? "直通模式：按键直接发送给终端"
                  : "输入命令 · Tab 采纳预测 · Ctrl+R 搜索历史 · Shift+Enter 换行"
              }
              onChange={(e) => {
                setValue(e.target.value);
                setGhost("");
                setHistIndex(null);
                syncCaret();
              }}
              onKeyDown={onKeyDown}
              onKeyUp={syncCaret}
              onClick={syncCaret}
              onSelect={syncCaret}
            />
            {ghost && (
              <span
                className="ghost"
                aria-hidden
                style={{ left: `${ghostPos.left}px`, top: `${ghostPos.top}px` }}
              >
                {ghost}
              </span>
            )}
            <div className="mirror" aria-hidden>
              <span>{value}</span>
              <span ref={endMarkRef} />
            </div>
          </div>
          <button
            className="cmd-send"
            title="执行 (Enter)"
            onClick={() => {
              submit();
              taRef.current?.focus();
            }}
          >
            执行
          </button>
          <button
            className="cmd-clear"
            title="清空本会话历史（需确认，不影响其他会话）"
            onClick={() => {
              void clearHistory();
              taRef.current?.focus();
            }}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
              <path
                d="M2.8 4.3h10.4M6.2 4.3V2.9h3.6v1.4M4.1 4.3l.6 8.3a1 1 0 0 0 1 .9h4.6a1 1 0 0 0 1-.9l.6-8.3M6.6 6.8v4.2M9.4 6.8v4.2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
