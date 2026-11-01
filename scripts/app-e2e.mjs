import { chromium } from "playwright";
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";

const EXE = "F:\\TermDeck\\src-tauri\\target\\release\\termdeck.exe";
const OUT = "shots";
fs.mkdirSync(OUT, { recursive: true });

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
      const body = await getJson("http://127.0.0.1:9222/json");
      const pages = JSON.parse(body);
      if (pages.length > 0) return pages;
    } catch {
      /* not up yet */
    }
    await wait(400);
  }
  throw new Error("CDP did not come up");
}

const child = spawn(EXE, [], {
  detached: true,
  stdio: "ignore",
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222" },
});
child.unref();

const logs = [];
try {
  const pages = await waitForCdp();
  logs.push(`PAGE_URL=${pages[0].url}`);

  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0];

  page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") logs.push(`[console.error] ${m.text()}`);
  });

  await page.waitForSelector(".cmd-input", { timeout: 20000 });
  await wait(2500);
  await page.screenshot({ path: `${OUT}/app-real.png` });

  // Drive the real PowerShell through the command bar.
  const input = page.locator(".cmd-input").first();
  await input.click();
  await input.type("echo termdeck-real-pty-ok", { delay: 35 });
  await page.keyboard.press("Enter");
  await wait(3000);
  await page.screenshot({ path: `${OUT}/app-real-exec.png` });

  const termText = await page.locator(".term-surface").first().innerText();
  logs.push(`PTY_OUTPUT_VISIBLE=${/termdeck-real-pty-ok/.test(termText)}`);

  // Ghost text from the real SQLite history.
  await input.type("echo ter", { delay: 50 });
  await wait(900);
  const ghost = await page.locator(".ghost").first().textContent().catch(() => null);
  logs.push(`REAL_GHOST=[${ghost}]`);
  await page.keyboard.press("Tab");
  await wait(200);
  logs.push(`REAL_ADOPTED=[${await input.inputValue()}]`);
  await input.fill("");

  logs.push(`SESSIONS=${await page.locator(".session-item").count()}`);

  // Settings panel
  await page.locator(".status-gear").click();
  await wait(400);
  logs.push(`SETTINGS_ROWS=${await page.locator(".set-row").count()}`);
  await page.screenshot({ path: `${OUT}/app-real-settings.png` });
  await page.keyboard.press("Escape").catch(() => {});

  await browser.close();
} catch (err) {
  logs.push(`ERROR: ${err.message}`);
} finally {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

console.log(logs.join("\n"));
