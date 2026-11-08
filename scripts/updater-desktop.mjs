/**
 * Real WebView2 check for the updater section: version label is rendered from
 * package.json, and the install kind is resolved by the Rust backend.
 *
 * Network is deliberately not exercised here - the update endpoint lives on
 * github.com and this machine may not reach it. Use the settings panel manually
 * on a machine with GitHub access to verify a real download.
 */
import { chromium } from "playwright";
import { spawn, execSync } from "node:child_process";
import http from "node:http";
import path from "node:path";

const EXE = path.resolve("src-tauri/target/release/termdeck.exe");
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
  await page.waitForSelector(".cmd-input", { timeout: 25000 });
  await wait(2000);

  await page.locator(".status-gear").click();
  await page.waitForSelector(".modal", { timeout: 6000 });
  await wait(600);

  const version = (await page.locator(".set-label", { hasText: "TermDeck v" }).innerText()).trim();
  out.push(`INFO version label: ${version}`);
  ok("版本号已渲染", /^TermDeck v\d+\.\d+\.\d+$/.test(version), version);

  const hint = (await page.locator(".set-hint", { hasText: "便携版" }).count()) > 0
    ? await page.locator(".set-hint", { hasText: "便携版" }).first().innerText()
    : await page.locator(".set-hint", { hasText: "GitHub Releases" }).first().innerText();
  out.push(`INFO install kind hint: ${hint.trim()}`);
  // The dev build lives outside LOCALAPPDATA / Program Files, so the backend
  // must classify it as portable.
  ok("开发构建识别为便携版", hint.includes("便携版"), hint.trim());

  const kind = await page.evaluate(() => window.__TAURI_INTERNALS__?.invoke("install_kind"));
  out.push(`INFO backend install_kind: ${JSON.stringify(kind)}`);
  ok("后端 install_kind 返回 portable", kind === "portable", String(kind));

  await page.locator(".modal-body").evaluate((el) => (el.scrollTop = el.scrollHeight));
  await wait(300);
  await page.screenshot({ path: "shots/up-desktop.png" });
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
