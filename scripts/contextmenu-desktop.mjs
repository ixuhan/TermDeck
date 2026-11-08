/**
 * Right-clicking an entry in the file panel must open the real Explorer menu.
 *
 * The menu is a Win32 popup owned by the shell (class #32768), not DOM, so it is
 * detected by enumerating windows through enum_menu.py and counting items. A
 * hand-rolled menu would have a fixed item count; the shell menu on this machine
 * carries extras like "打开方式" and any installed shell extensions.
 */
import { chromium } from "playwright";
import { spawn, execSync } from "node:child_process";
import http from "node:http";
import path from "node:path";

const EXE = path.resolve("src-tauri/target/release/termdeck.exe");
const PY = path.resolve("scripts/enum_menu.py");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const ok = (name, cond, extra = "") =>
  out.push(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);

const menus = (extra = "") => {
  const raw = execSync(`python "${PY}" ${extra}`, { encoding: "utf8" }).trim();
  return JSON.parse(raw || "[]");
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
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222" },
});
child.unref();

try {
  await waitForCdp();
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages()[0];
  page.on("pageerror", (e) => out.push(`[pageerror] ${e.message}`));
  await page.waitForSelector(".dir-panel", { timeout: 25000 });
  await wait(2500);

  ok("右键前没有弹出菜单", menus().length === 0);

  // Pick a real entry (skip ".." which is the first row).
  const rows = page.locator(".dir-row:not(.is-up)");
  const count = await rows.count();
  out.push(`INFO directory rows: ${count}`);
  ok("目录面板有条目", count > 0, `${count} 项`);

  await rows.first().click({ button: "right" });
  await wait(1200);

  const shown = menus();
  out.push(`INFO menu windows: ${JSON.stringify(shown)}`);
  ok("右键弹出了原生菜单", shown.length === 1, JSON.stringify(shown));
  if (shown.length === 1) {
    // A populated shell menu is a tall list, not an empty strip.
    const { w, h } = shown[0];
    ok("菜单有实际内容（尺寸合理）", w > 80 && h > 120, `${w}x${h}`);
  }

  // Dismiss with Escape so the app is left in a clean state.
  menus("--close");
  await wait(800);
  ok("Esc 后菜单关闭", menus().length === 0);

  // The window must still be responsive afterwards.
  const alive = await page.evaluate(() => document.querySelectorAll(".dir-row").length);
  ok("关闭菜单后界面仍可交互", alive > 0, `${alive} 行`);

  await page.screenshot({ path: "shots/ctx01-after-close.png" });
} finally {
  console.log(out.join("\n"));
  const fails = out.filter((l) => l.startsWith("FAIL"));
  console.log(`\n==== ${out.filter((l) => l.startsWith("PASS")).length} passed, ${fails.length} failed ====`);
  try {
    menus("--close");
  } catch {
    /* nothing to dismiss */
  }
  try {
    execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
  } catch {
    /* already gone */
  }
  process.exit(fails.length ? 1 : 0);
}
