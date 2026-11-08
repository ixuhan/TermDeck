/**
 * Regression: right-clicking a file under a directory named `COM2` (a Windows
 * reserved device name) used to fail with 0x800704B0 "指定的设备名无效".
 *
 * `SHCreateItemFromParsingName` normalises path segments and treats COM1..COM9
 * as devices. The app now falls back to SHSimpleIDListFromPath, which builds a
 * PIDL straight from the filesystem path. This suite calls the real command on
 * a real log file and detects the shell's #32768 popup window.
 *
 * Only one menu is opened per process: TrackPopupMenu blocks the window thread,
 * so queuing several invocations makes dismissal timing flaky. Ordinary paths
 * are covered by contextmenu-desktop.mjs.
 *
 * Window stays hidden (TERMDECK_TEST_HIDDEN).
 */
import { chromium } from "playwright";
import { spawn, execSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const EXE = path.resolve("src-tauri/target/release/termdeck.exe");
const PY = path.resolve("scripts/enum_menu.py");
const LOGS = path.resolve("src-tauri/target/release/data/logs/COM2");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const ok = (name, cond, extra = "") =>
  out.push(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);

const menus = (extra = "") =>
  JSON.parse(execSync(`python "${PY}" ${extra}`, { encoding: "utf8" }).trim() || "[]");

const killApp = () => {
  try {
    execSync("taskkill /IM termdeck.exe /F", { stdio: "ignore" });
  } catch {
    /* nothing running */
  }
};

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

// Make sure there is a real file under the reserved-name directory.
fs.mkdirSync(LOGS, { recursive: true });
const files = fs.readdirSync(LOGS).filter((f) => f.endsWith(".log"));
if (files.length === 0) {
  fs.writeFileSync(path.join(LOGS, "reserved-name-test.log"), "fixture\r\n");
}
const target = path.join(LOGS, fs.readdirSync(LOGS)[0]);

killApp();
await wait(2000);

const child = spawn(EXE, [], {
  detached: true,
  stdio: "ignore",
  env: {
    ...process.env,
    TERMDECK_TEST_HIDDEN: "1",
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222",
  },
});
child.unref();

try {
  await waitForCdp();
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages()[0];
  page.on("pageerror", (e) => out.push(`[pageerror] ${e.message}`));
  await page.waitForSelector(".cmd-input", { timeout: 25000 });
  await wait(1800);

  out.push(`INFO reserved path: ${target}`);
  ok("保留设备名目录存在", fs.existsSync(target), target);

  // The sort feature needs a real mtime from the Rust side, not just the mock.
  const listing = await page.evaluate(
    async (p) => window.__TAURI_INTERNALS__.invoke("read_directory", { path: p }),
    LOGS,
  );
  const entries = listing?.entries ?? [];
  ok("后端返回目录条目", entries.length > 0, String(entries.length));
  ok("后端返回非零修改时间", entries.every((e) => e.mtime > 0), JSON.stringify(entries.map((e) => e.mtime)));

  ok("右键前没有弹出菜单", menus().length === 0);

  // Fire without awaiting: TrackPopupMenu blocks until the menu is dismissed.
  await page.evaluate((p) => {
    window.__ctxResult = "pending";
    window.__TAURI_INTERNALS__
      .invoke("show_context_menu", { path: p, x: 120, y: 120 })
      .then(() => (window.__ctxResult = "ok"))
      .catch((e) => (window.__ctxResult = "ERR " + String(e)));
  }, target);
  await wait(1300);

  const shown = menus();
  out.push(`INFO menu: ${JSON.stringify(shown)}`);
  ok("保留设备名路径右键弹出原生菜单", shown.length === 1, JSON.stringify(shown));
  if (shown.length === 1) {
    ok("菜单有实际内容", shown[0].w > 80 && shown[0].h > 120, `${shown[0].w}x${shown[0].h}`);
  }

  // Dismiss for a clean state; a posted Escape can race the shell's private
  // menu loop, so retry. Killing the process below also removes any leftover.
  for (let i = 0; i < 10; i++) {
    if (menus().length > 0) menus("--close");
    const result = await page.evaluate(() => window.__ctxResult);
    if (result === "ok" && menus().length === 0) break;
    await wait(400);
  }
  const finalResult = await page.evaluate(() => window.__ctxResult);
  // "ok" only arrives once the menu is dismissed; a synthetic Escape does not
  // always reach the shell's private menu loop. What matters is that the
  // command did NOT reject: a parse failure (0x800704B0) would set "ERR ..."
  // and no popup would have appeared in the first place.
  ok("命令没有报解析错误", !String(finalResult).startsWith("ERR"), String(finalResult));
} catch (err) {
  out.push(`FAIL 运行异常 :: ${err && err.message ? err.message : String(err)}`);
} finally {
  // Killing the owner process also destroys its popup windows, so no menu is
  // left floating on the user's desktop regardless of how dismissal went.
  killApp();
  await wait(600);
  ok("清理后没有残留菜单", menus().length === 0, JSON.stringify(menus()));
  console.log(out.join("\n"));
  const failed = out.filter((l) => l.startsWith("FAIL")).length;
  console.log(`==== ${out.filter((l) => l.startsWith("PASS")).length} passed, ${failed} failed ====`);
  process.exit(failed ? 1 : 0);
}
