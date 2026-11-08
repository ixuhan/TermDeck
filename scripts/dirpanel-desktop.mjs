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
  await page.waitForSelector(".dir-panel", { timeout: 25000 });
  await wait(2500);

  const crumbs = async () =>
    (await page.locator(".dir-crumb").allInnerTexts()).map((s) => s.trim()).join("\\");
  const rows = async () => (await page.locator(".dir-name").allInnerTexts()).map((s) => s.trim());

  const first = await crumbs();
  const firstRows = await rows();
  ok("真实目录已读取", first.length > 2, first);
  ok("列出真实文件", firstRows.includes("package.json") || firstRows.includes("src"), firstRows.join(","));

  // Follow a real `cd` through the whole chain: shell → cwd tracking → panel.
  const input = page.locator(".cmd-input").first();
  await input.click();
  await input.type("cd C:\\Windows", { delay: 20 });
  await page.keyboard.press("Enter");
  await wait(2500);
  const afterCd = await crumbs();
  const afterRows = await rows();
  ok("动态模式跟随真实 cd", /windows$/i.test(afterCd), afterCd);
  ok("刷新出 Windows 目录内容", afterRows.some((r) => /system32/i.test(r)), afterRows.slice(0, 6).join(","));

  // open_path validation: bogus path must be rejected without side effects.
  const res = await page.evaluate(async () => {
    try {
      await window.__TAURI_INTERNALS__.invoke("open_path", { path: "C:\\definitely-not-here-xyz" });
      return "resolved";
    } catch (e) {
      return String(e);
    }
  });
  ok("open_path 校验非法路径", /不存在|not/i.test(res), res);

  await page.screenshot({ path: "shots/dir-desktop.png" });
  await browser.close();
} catch (e) {
  out.push(`ERROR ${e.message}`);
} finally {
  try {
    execSync(`taskkill /PID ${child.pid}`, { stdio: "ignore" });
  } catch {
    /* ignore */
  }
  await wait(3000);
  try {
    execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
  } catch {
    /* ignore */
  }
}

console.log(out.join("\n"));
console.log(`\n==== ${out.filter((l) => l.startsWith("PASS")).length} passed, ${out.filter((l) => l.startsWith("FAIL")).length} failed ====`);
