import { chromium } from "playwright";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const EXE = "F:\\TermDeck\\src-tauri\\target\\release\\termdeck.exe";
const DATA = path.join(process.env.APPDATA, "as.ixuhan.termdeck");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function waitForCdp(timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const pages = JSON.parse(await getJson("http://127.0.0.1:9222/json"));
      if (pages.length) return pages;
    } catch {
      /* keep polling */
    }
    await wait(400);
  }
  throw new Error("CDP did not come up");
}

function launch() {
  const child = spawn(EXE, [], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222" },
  });
  child.unref();
  return child;
}

function killTree(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

const out = [];

// ---------- pass 1: fresh boot ----------
let child = launch();
let browser;
try {
  await waitForCdp();
  browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages()[0];
  await page.waitForSelector(".cmd-input", { timeout: 20000 });
  await wait(2000);

  // Rename the first session so restoration is observable.
  await page.locator(".session-item").first().dblclick();
  const box = page.locator(".session-rename");
  await box.fill("验收-构建环境");
  await page.keyboard.press("Enter");
  await wait(1200);

  out.push(`PASS1_SESSIONS=${await page.locator(".session-item").count()}`);
  await browser.close();
  browser = null;
} catch (e) {
  out.push(`PASS1_ERROR=${e.message}`);
}
killTree(child);
await wait(2500);

const wsFile = path.join(DATA, "workspace_state.json");
if (fs.existsSync(wsFile)) {
  const ws = JSON.parse(fs.readFileSync(wsFile, "utf8"));
  out.push(`SAVED_SESSIONS=${ws.sessions.length}`);
  out.push(`SAVED_TITLES=${ws.sessions.map((s) => s.title).join(" | ")}`);
  out.push(`SAVED_QUICK=${ws.sessions[0]?.quick_shortcuts?.length ?? 0}`);
} else {
  out.push("SAVED_FILE=missing");
}

// ---------- pass 2: restore ----------
child = launch();
try {
  await waitForCdp();
  browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages()[0];
  await page.waitForSelector(".cmd-input", { timeout: 20000 });
  await wait(2500);

  const titles = await page.locator(".session-title").allInnerTexts();
  out.push(`RESTORED_TITLES=${titles.join(" | ")}`);
  out.push(`RESTORED_HAS_RENAMED=${titles.includes("验收-构建环境")}`);
  out.push(`RESTORED_QUICK=${await page.locator(".quick-card").count()}`);
  await page.screenshot({ path: "shots/app-restored.png" });
  await browser.close();
} catch (e) {
  out.push(`PASS2_ERROR=${e.message}`);
}
killTree(child);

const log = fs.existsSync(path.join(DATA, "termdeck.log"))
  ? fs.readFileSync(path.join(DATA, "termdeck.log"), "utf8")
  : "";
out.push(`LOG_HIT_RESTORE=${log.includes("workspace_load -> hit")}`);

console.log(out.join("\n"));
