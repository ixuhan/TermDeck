/**
 * End-to-end: per-line timestamps must also land in the serial log file.
 *
 * A Python peer writes several lines to COM7 of the virtual pair; the app reads
 * them on COM2 and appends to a real log file. We then read that file from disk
 * and assert the plain-text `[HH:MM:SS] ` prefixes, blank-line handling and
 * that toggling the global switch takes effect while the port stays open.
 *
 * The window is created hidden (TERMDECK_TEST_HIDDEN) — no UI window appears.
 */
import { chromium } from "playwright";
import { spawn, execFileSync, execSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const EXE = path.resolve("src-tauri/target/release/termdeck.exe");
const DATA = path.resolve("src-tauri/target/release/data");
const SETTINGS = path.join(DATA, "settings.json");
const LOG_DIR = path.resolve("src-tauri/target/release/data/stamp-logs");
// Contains %h%m%s on purpose: a status call that re-renders this template
// would produce a different filename every second (and a different day after
// midnight). The reported path must stay pinned to the open file handle.
const LOG_TEMPLATE = path.join(LOG_DIR, "%Port", "%Y%M%D-%h%m%s.log");
let logFile = "";
const APP_PORT = "COM2";
const PEER_PORT = "COM7";
const STAMP = /^\[\d{2}:\d{2}:\d{2}\]\s/;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const ok = (name, cond, extra = "") =>
  out.push(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent: false }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(body));
    });
    req.on("error", reject);
    req.setTimeout(2000, () => req.destroy(new Error("timeout")));
  });
}

async function waitForCdp(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const pages = JSON.parse(await getJson("http://127.0.0.1:9222/json"));
      if (pages.length && pages[0].webSocketDebuggerUrl) return;
    } catch {
      /* keep polling */
    }
    await wait(400);
  }
  throw new Error("CDP did not come up");
}

const peerWrite = (text) =>
  execFileSync("python", ["scripts/serial_peer.py", "write", PEER_PORT, text], {
    encoding: "utf8",
    timeout: 15000,
  });

// The peer port may be held by a serial monitor. Skip instead of faking a pass.
try {
  peerWrite("");
} catch {
  console.log(`SKIP ${PEER_PORT} 被其他程序占用，跳过日志时间戳端到端测试`);
  console.log("==== 0 passed, 0 failed (skipped) ====");
  process.exit(0);
}

try {
  execSync("taskkill /IM termdeck.exe /F", { stdio: "ignore" });
} catch {
  /* nothing running */
}
await wait(2000);

fs.mkdirSync(DATA, { recursive: true });
try {
  fs.unlinkSync(path.join(DATA, "workspace_state.json"));
} catch {
  /* first run */
}
fs.rmSync(LOG_DIR, { recursive: true, force: true });
const originalSettings = fs.existsSync(SETTINGS) ? fs.readFileSync(SETTINGS, "utf8") : null;
const settings = originalSettings ? JSON.parse(originalSettings) : {};
settings.webgl = false;
settings.lineTimestamps = true;
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));

const child = spawn(EXE, [], {
  detached: true,
  stdio: "ignore",
  env: {
    ...process.env,
    TERMDECK_TEST_HIDDEN: "1",
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
      "--remote-debugging-port=9222 --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling",
  },
});
child.unref();

const readLog = () =>
  logFile && fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
/** Non-empty lines, with the stamp prefix stripped for checking content. */
const contentLines = (text) =>
  text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "");

try {
  await waitForCdp();
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages()[0];
  page.on("pageerror", (e) => out.push(`[pageerror] ${e.message}`));
  await page.waitForSelector(".rail-ports", { timeout: 25000 });
  await wait(2500);

  // Create the session from the port list, then configure logging *before*
  // connecting (sessions start disconnected by design).
  const row = page.locator(".port-item", { hasText: APP_PORT }).first();
  await row.hover();
  await row.locator(".port-open").click();
  await wait(1800);

  const item = page.locator(".session-item").last();
  const key = await item.getAttribute("data-key");
  ok("串口会话已创建", !!key, String(key));

  const status = await page.evaluate(
    async ([k, file]) => {
      const cfg = {
        port: "COM2",
        baud: 115200,
        dataBits: 8,
        stopBits: 1,
        parity: "none",
        flow: "none",
        dtr: true,
        rts: true,
      };
      const view = { hex: false, crAsNewline: true, localEcho: false, sendNewline: "\r\n" };
      const log = { enabled: true, template: file, hex: false };
      await window.__TAURI_INTERNALS__.invoke("serial_update", {
        sessionKey: k,
        view,
        log,
        config: cfg,
      });
      await window.__TAURI_INTERNALS__.invoke("serial_resume", { sessionKey: k });
      return await window.__TAURI_INTERNALS__.invoke("serial_status", { sessionKey: k });
    },
    [key, LOG_TEMPLATE],
  );
  out.push(`INFO status: ${JSON.stringify(status)}`);
  ok("端口已打开", status?.open === true, JSON.stringify(status));
  logFile = status?.logPath ?? "";
  ok("日志路径已解析", !!logFile, logFile);
  ok("报告的路径指向实际文件", !!logFile && fs.existsSync(logFile), logFile);

  // The template contains %s: a naive status() would re-render it and return a
  // different (nonexistent) filename on this second call.
  await wait(1300);
  const status2 = await page.evaluate(
    async (k) => window.__TAURI_INTERNALS__.invoke("serial_status", { sessionKey: k }),
    key,
  );
  ok(
    "打开时日志路径不随时间漂移",
    status2?.logPath === status?.logPath,
    `${status?.logPath} -> ${status2?.logPath}`,
  );
  await wait(300);

  // ---- timestamps ON -------------------------------------------------------
  peerWrite("LINE-A\r\n\r\n  indented\r\nLINE-B\r\n");
  await wait(1600);
  const on = readLog();
  out.push(`INFO log(on): ${JSON.stringify(on)}`);
  ok("日志文件已生成", on.length > 0, `${on.length} bytes`);
  const onLines = contentLines(on);
  ok("A/B 内容都在", on.includes("LINE-A") && on.includes("LINE-B"));
  ok("每个非空行都有时间戳", onLines.length >= 3 && onLines.every((l) => STAMP.test(l)), onLines.join(" | "));
  ok("缩进内容时间戳在行首", onLines.some((l) => /^\[\d{2}:\d{2}:\d{2}\]\s\s+indented/.test(l)), onLines.join(" | "));
  ok("空行没有时间戳", !/\[\d{2}:\d{2}:\d{2}\]\s*\r?\n\r?\n/.test(on.split("LINE-A")[1]?.slice(0, 60) ?? ""));
  ok("日志里没有 ANSI 转义", !on.includes("\x1b"));
  ok("同一天不插入日期锚点", !on.includes("日期变更"), on.slice(0, 120));

  // ---- toggle OFF while the port stays open --------------------------------
  await page.evaluate(async () => {
    await window.__TAURI_INTERNALS__.invoke("set_line_timestamps", { enabled: false });
  });
  await wait(300);
  peerWrite("PLAIN-C\r\n");
  await wait(1400);
  const off = readLog();
  const plain = contentLines(off).filter((l) => l.includes("PLAIN-C"));
  ok("关闭后新行不再带时间戳", plain.length === 1 && !STAMP.test(plain[0]), plain.join(" | "));

  // ---- toggle ON again -----------------------------------------------------
  await page.evaluate(async () => {
    await window.__TAURI_INTERNALS__.invoke("set_line_timestamps", { enabled: true });
  });
  await wait(300);
  peerWrite("BACK-D\r\n");
  await wait(1400);
  const again = readLog();
  const back = contentLines(again).filter((l) => l.includes("BACK-D"));
  ok("重新开启后立即恢复", back.length === 1 && STAMP.test(back[0]), back.join(" | "));
} catch (err) {
  out.push(`FAIL 运行异常 :: ${err && err.message ? err.message : String(err)}`);
} finally {
  try {
    execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
  } catch {
    /* already gone */
  }
  await wait(400);
  if (originalSettings === null) {
    try {
      fs.unlinkSync(SETTINGS);
    } catch {
      /* nothing to remove */
    }
  } else {
    fs.writeFileSync(SETTINGS, originalSettings);
  }
  console.log(out.join("\n"));
  const failed = out.filter((l) => l.startsWith("FAIL")).length;
  console.log(`==== ${out.filter((l) => l.startsWith("PASS")).length} passed, ${failed} failed ====`);
  process.exit(failed ? 1 : 0);
}
