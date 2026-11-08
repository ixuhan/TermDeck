/**
 * Real-app smoke check for the timestamp setting.
 *
 * The window is created hidden (TERMDECK_TEST_HIDDEN), so nothing appears on
 * screen. A hidden WebView2 suspends xterm's renderer, which makes screen text
 * unreliable here — that path is covered by `timestamp-test.mjs` in the dev
 * browser. This suite verifies the setting actually round-trips through the
 * real settings.json / Tauri store.
 */
import { chromium } from "playwright";
import { spawn, execSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const EXE = path.resolve("src-tauri/target/release/termdeck.exe");
const DATA = path.resolve("src-tauri/target/release/data");
const SETTINGS = path.join(DATA, "settings.json");
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

try {
  execSync("taskkill /IM termdeck.exe /F", { stdio: "ignore" });
} catch {
  /* nothing running */
}
await wait(1500);

fs.mkdirSync(DATA, { recursive: true });
const original = fs.existsSync(SETTINGS) ? fs.readFileSync(SETTINGS, "utf8") : null;
const settings = original ? JSON.parse(original) : {};
settings.webgl = false;
settings.lineTimestamps = true;
fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));

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
  await page.waitForSelector(".cmd-input", { timeout: 25000 });
  await wait(1200);

  await page.locator(".status-gear").click();
  await page.waitForSelector(".modal", { timeout: 5000 });
  await wait(300);

  const row = page.locator(".modal .set-row", { hasText: "每行开头显示时间" });
  ok("设置面板有该开关", (await row.count()) === 1);
  ok("settings.json 的值已载入真实应用", await row.locator(".set-check").isChecked());

  // Toggling writes through the real (non-mock) settings_save command.
  await row.locator(".set-check").uncheck();
  await wait(600);
  const onDisk = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  ok("关闭后写回 settings.json", onDisk.lineTimestamps === false, String(onDisk.lineTimestamps));
  await row.locator(".set-check").check();
  await wait(600);
  const restored = JSON.parse(fs.readFileSync(SETTINGS, "utf8"));
  ok("开启后写回 settings.json", restored.lineTimestamps === true, String(restored.lineTimestamps));
} catch (err) {
  out.push(`FAIL 运行异常 :: ${err && err.message ? err.message : String(err)}`);
} finally {
  try {
    execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
  } catch {
    /* already gone */
  }
  await wait(400);
  if (original === null) {
    try {
      fs.unlinkSync(SETTINGS);
    } catch {
      /* nothing to remove */
    }
  } else {
    fs.writeFileSync(SETTINGS, original);
  }
  console.log(out.join("\n"));
  const failed = out.filter((l) => l.startsWith("FAIL")).length;
  console.log(`==== ${out.filter((l) => l.startsWith("PASS")).length} passed, ${failed} failed ====`);
  process.exit(failed ? 1 : 0);
}
