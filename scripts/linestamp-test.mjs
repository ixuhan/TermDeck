/**
 * Unit tests for the line timestamper.
 *
 * The module is TypeScript with no runtime deps, so esbuild (already installed
 * as a vite dep) bundles it into a temp ESM file that node can import.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const OUT = path.resolve(".cache/linestamp.mjs");
mkdirSync(path.dirname(OUT), { recursive: true });
execFileSync("npx", ["esbuild", "src/linestamp.ts", "--format=esm", "--outfile=" + OUT], {
  stdio: "ignore",
  shell: true,
});

const { LineStamper, makeStamp } = await import(`file://${OUT.replace(/\\/g, "/")}`);

const S = "<T> ";
const logs = [];

function eq(name, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    logs.push(`PASS ${name}`);
  } else {
    logs.push(`FAIL ${name}\n    got      ${a}\n    expected ${e}`);
  }
}

/** Feeds several chunks through one stamper, as separate reads would arrive. */
function feed(chunks, stamp = S) {
  const st = new LineStamper();
  return chunks.map((c) => st.process(c, stamp)).join("");
}

// ---- basic line starts ------------------------------------------------------
eq("首块内容加时间", feed(["hello"]), "<T> hello");
eq("多行逐行加", feed(["a\nb\nc"]), "<T> a\n<T> b\n<T> c");

// ---- a line split across reads ---------------------------------------------
eq("跨块续行不重复加", feed(["abc", "def\n"]), "<T> abcdef\n");
eq("换行在块尾，下一块开头加", feed(["abc\n", "def"]), "<T> abc\n<T> def");
eq("换行拆在两个块之间", feed(["abc\r", "\ndef"]), "<T> abc\r\n<T> def");

// ---- CRLF / lone CR ---------------------------------------------------------
eq("CRLF 只加一次", feed(["a\r\nb"]), "<T> a\r\n<T> b");
eq("单独 CR 视为重绘，不加", feed(["a\r", "b"]), "<T> a\rb");
eq("行首 CR 重绘不加", feed(["\rprogress 10%"]), "\rprogress 10%");
eq("重绘后再换行恢复加", feed(["\rprogress", " 100%\r\ndone"]), "\rprogress 100%\r\n<T> done");

// ---- blank lines ------------------------------------------------------------
eq("空行不加", feed(["a\n\nb"]), "<T> a\n\n<T> b");
eq("连续空行不加", feed(["a\n\n\n\nb"]), "<T> a\n\n\n\n<T> b");
eq("块首空行不加", feed(["\nhello"]), "\n<T> hello");

// ---- disabled (empty stamp) still tracks state ------------------------------
eq("关闭时不改内容", feed(["a\nb"], ""), "a\nb");
{
  // Turning the setting on mid-stream must not stamp in the middle of a line.
  const st = new LineStamper();
  const before = st.process("abc", "");
  const after = st.process("def", S);
  eq("关闭→开启不在行中插时间", before + after, "abcdef");
  const next = st.process("\nxyz", S);
  eq("关闭→开启后下一行正常加", next, "\n<T> xyz");
}

// ---- escapes are not mistaken for content -----------------------------------
eq("行首颜色码不影响加时间", feed(["\x1b[32mok\x1b[0m"]), "<T> \x1b[32mok\x1b[0m");

// ---- markMidLine ------------------------------------------------------------
{
  const st = new LineStamper();
  st.process("a\n", S);
  st.markMidLine();
  eq("标记行中后不加", st.process("abc", S), "abc");
  eq("标记后换行恢复", st.process("\nx", S), "\n<T> x");
}

// ---- lines with no real content (PSReadLine repaints, clears, pad rows) -----
eq("纯空白行不加", feed(["a\n   \nb"]), "<T> a\n   \n<T> b");
eq("制表符行不加", feed(["\t\t\nX"]), "\t\t\n<T> X");
eq("纯转义序列行不加", feed(["\x1b[2K\x1b[0m\nX"]), "\x1b[2K\x1b[0m\n<T> X");
eq("转义后用 CR 重绘不加", feed(["\x1b[2K\rprompt >"]), "\x1b[2K\rprompt >");
eq("缩进内容时间戳仍在行首", feed(["  indented"]), "<T>   indented");
eq("颜色码后缩进仍加", feed(["\x1b[32m  hi"]), "<T> \x1b[32m  hi");
{
  // Whitespace split across reads: the decision must wait for the next chunk.
  const st = new LineStamper();
  const a = st.process("  ", S);
  const b = st.process("\nX", S);
  eq("跨块空白行不加", a + b, "  \n<T> X");
}
{
  const st = new LineStamper();
  const a = st.process("  ", S);
  const b = st.process("hi", S);
  eq("跨块缩进后正常加", a + b, "<T>   hi");
}
{
  // OSC sequences can span reads and contain text that looks printable.
  const st = new LineStamper();
  const a = st.process("\x1b]0;title", S);
  const b = st.process("\x07\nreal", S);
  eq("跨块 OSC 不算内容", a + b, "\x1b]0;title\x07\n<T> real");
}

// ---- a lone control sequence must pass through, never be held --------------
{
  // ConPTY's cursor-position query arrives as a single chunk and the shell
  // waits for the answer before printing anything else. If the stamper holds
  // it (no printable char yet), the terminal never sees it and never answers.
  const st = new LineStamper();
  eq("孤立 CSI 查询立即透传", st.process("\x1b[6n", S), "\x1b[6n");
  eq("查询后内容正常加时间", st.process("PS> ", S), "<T> PS> ");
}
{
  // Same for a lone OSC title sequence.
  const st = new LineStamper();
  eq("孤立 OSC 立即透传", st.process("\x1b]0;x\x07", S), "\x1b]0;x\x07");
}

// ---- stamp format -----------------------------------------------------------
{
  const stamp = makeStamp(new Date(2026, 10, 8, 9, 5, 7));
  eq("时间格式", stamp.replace(/\x1b\[[0-9;]*m/g, ""), "[09:05:07] ");
  eq("只调暗不改色", /\x1b\[2m/.test(stamp) && /\x1b\[22m/.test(stamp), true);
}

console.log(logs.join("\n"));
const failed = logs.filter((l) => l.startsWith("FAIL")).length;
console.log(`==== ${logs.length - failed} passed, ${failed} failed ====`);
process.exit(failed ? 1 : 0);
