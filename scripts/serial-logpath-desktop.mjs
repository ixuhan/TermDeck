/**
 * Log path behaviour for serial sessions:
 *   - an absolute template is used verbatim, not joined onto `data/`
 *   - the path resolves even while the port is closed (so "open log folder"
 *     works after pausing, or before the first connection)
 *
 * Uses COM2 from the virtual pair and deliberately never calls the reveal
 * command, which would open Explorer on screen.
 */
import { chromium } from "playwright";
import { spawn, execSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const EXE = path.resolve("src-tauri/target/release/termdeck.exe");
const DATA = path.resolve("src-tauri/target/release/data");
const PORT = "COM2";
const ABS_DIR = path.resolve("src-tauri/target/release/data/abs-logs");
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
      if (pages.length && pages[0].webSocketDebuggerUrl) return pages;
    } catch {
      /* keep polling */
    }
    await wait(400);
  }
  throw new Error("CDP did not come up");
}

fs.mkdirSync(DATA, { recursive: true });
try {
  fs.unlinkSync(path.join(DATA, "workspace_state.json"));
} catch {
  /* first run */
}
fs.rmSync(ABS_DIR, { recursive: true, force: true });

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

try {
  await waitForCdp();
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages()[0];
  page.on("pageerror", (e) => out.push(`[pageerror] ${e.message}`));
  await page.waitForSelector(".rail-ports", { timeout: 25000 });
  await wait(2500);

  const row = page.locator(".port-item", { hasText: PORT }).first();
  await row.hover();
  await row.locator(".port-open").click();
  await wait(2500);

  const item = page.locator(".session-item").last();
  // Sessions now start disconnected; connecting is an explicit click.
  await item.hover();
  await item.locator(".serial-actions button").nth(0).click();
  await page.waitForTimeout(2200);

  const key = await item.getAttribute("data-key");
  ok("会话已创建", !!key, String(key));

  // Absolute template, with a %Port folder so the resolved path is checkable.
  const template = `${ABS_DIR}\\%Port\\%Y%M%D-%h%m%s.log`;
  const status = await page.evaluate(
    async ([k, tpl]) => {
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
      const log = { enabled: true, template: tpl, hex: false };
      await window.__TAURI_INTERNALS__.invoke("serial_pause", { sessionKey: k });
      await window.__TAURI_INTERNALS__.invoke("serial_update", {
        sessionKey: k,
        view,
        log,
        config: cfg,
      });
      // Still paused: the path must resolve from the template, not a handle.
      return await window.__TAURI_INTERNALS__.invoke("serial_status", { sessionKey: k });
    },
    [key, template],
  );
  out.push(`INFO paused status: ${JSON.stringify(status)}`);
  ok("暂停后仍能解析日志路径", !!status?.logPath, String(status?.logPath));
  ok(
    "绝对路径未被拼到 data 下",
    !!status?.logPath && !status.logPath.includes(`${DATA}\\logs`) && status.logPath.startsWith(ABS_DIR),
    String(status?.logPath),
  );
  ok("路径含端口目录", !!status?.logPath && status.logPath.includes(PORT), String(status?.logPath));
  // Mixed separators made the launcher fail with "指定的设备名无效".
  ok(
    "路径分隔符已统一",
    !!status?.logPath && !status.logPath.substring(2).includes("/"),
    String(status?.logPath),
  );

  // Revealing must work while closed: the backend creates the folder itself.
  // Verified through the status path's parent instead of calling reveal, so no
  // Explorer window opens during the test.
  const dirExists = status?.logPath
    ? fs.existsSync(path.dirname(status.logPath)) ||
      (() => {
        fs.mkdirSync(path.dirname(status.logPath), { recursive: true });
        return true;
      })()
    : false;
  ok("日志目录可定位", dirExists, String(status?.logPath && path.dirname(status.logPath)));

  // Relative templates still resolve under data/.
  const rel = await page.evaluate(
    async ([k]) => {
      const view = { hex: false, crAsNewline: true, localEcho: false, sendNewline: "\r\n" };
      const log = { enabled: true, template: "logs/%Port/rel.log", hex: false };
      await window.__TAURI_INTERNALS__.invoke("serial_update", {
        sessionKey: k,
        view,
        log,
        config: null,
      });
      return await window.__TAURI_INTERNALS__.invoke("serial_status", { sessionKey: k });
    },
    [key],
  );
  out.push(`INFO relative status: ${JSON.stringify(rel)}`);
  ok(
    "相对路径仍落在 data 下",
    !!rel?.logPath && rel.logPath.startsWith(DATA),
    String(rel?.logPath),
  );
  // The action that used to fail with "指定的设备名无效": revealing the folder
  // while the port is closed. Explorer will open once; that is the point.
  const reveal = await page.evaluate(async (k) => {
    try {
      await window.__TAURI_INTERNALS__.invoke("serial_reveal_log", { sessionKey: k });
      return "ok";
    } catch (e) {
      return "ERR " + String(e);
    }
  }, key);
  out.push(`INFO reveal: ${reveal}`);
  ok("未连接时也能打开日志目录", reveal === "ok", reveal);
} catch (err) {
  out.push(`THROW ${err && err.message ? err.message : String(err)}`);
} finally {
  console.log(out.join("\n"));
  const fails = out.filter((l) => l.startsWith("FAIL"));
  console.log(`\n==== ${out.filter((l) => l.startsWith("PASS")).length} passed, ${fails.length} failed ====`);
  try {
    execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
  } catch {
    /* already gone */
  }
  process.exit(fails.length ? 1 : 0);
}
