/**
 * Real WebView2 check: pressing Ctrl+R twice must open then close the history
 * palette, and must never let the webview reload itself.
 *
 * This differs from the browser suite because Ctrl+R here goes through the
 * webview's own accelerator handling, not just DOM keydown.
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

  let navigations = 0;
  page.on("framenavigated", (f) => {
    if (f === page.mainFrame()) navigations++;
  });

  await page.waitForSelector(".cmd-input", { timeout: 25000 });
  await wait(2500);

  const input = page.locator(".cmd-input").first();
  await input.click();
  await input.fill("echo ctrl-r-desktop");
  await wait(300);

  const before = navigations;

  await page.keyboard.press("Control+r");
  await wait(700);
  const opened = await page.locator(".palette").count();
  ok("首次 Ctrl+R 打开历史浮层", opened === 1, `palette=${opened}`);

  await page.keyboard.press("Control+r");
  await wait(900);
  const stillOpen = await page.locator(".palette").count();
  ok("再按 Ctrl+R 关闭浮层", stillOpen === 0, `palette=${stillOpen}`);
  ok("页面未重载", navigations === before, `navigations ${before} -> ${navigations}`);
  ok("输入框内容仍在", (await input.inputValue()) === "echo ctrl-r-desktop", await input.inputValue());
  ok("会话仍在（未因刷新重建）", (await page.locator(".session-item").count()) >= 1);

  await page.screenshot({ path: "shots/fx03-desktop-ctrlr.png" });
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
