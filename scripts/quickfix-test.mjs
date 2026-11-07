/**
 * Two fixes verified here:
 *   1. Ctrl+R opens the history palette; pressing it again must close it and
 *      must NOT let the webview reload (that falls through to the browser's
 *      own reload accelerator).
 *   2. Exporting quick commands must report a short file name, not a full
 *      absolute path that wraps into a black block over the panel footer.
 */
import { chromium } from "playwright";

const OUT = "shots";
const logs = [];
const ok = (name, pass, detail = "") =>
  logs.push(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`);

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--no-proxy-server", "--proxy-bypass-list=*"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => logs.push(`PAGEERROR ${e.message}`));

let navigations = 0;
page.on("framenavigated", (f) => {
  if (f === page.mainFrame()) navigations++;
});

await page.goto("http://localhost:1420/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".cmd-input", { timeout: 20000 });
await page.waitForTimeout(1200);

// Record Ctrl+R presses that nobody cancelled (those are the ones that reload).
await page.evaluate(() => {
  window.__unhandledReload = 0;
  window.addEventListener("keydown", (e) => {
    const hit = (e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "r") || e.key === "F5";
    if (!hit) return;
    setTimeout(() => {
      if (!e.defaultPrevented) window.__unhandledReload++;
    }, 0);
  });
});

const navBefore = navigations;
const input = page.locator(".cmd-input").first();
await input.click();
await input.fill("echo ctrl-r-probe");
await page.waitForTimeout(200);

// ---- first Ctrl+R: palette opens -------------------------------------------
await page.keyboard.press("Control+r");
await page.waitForTimeout(500);
ok("#1a 首次 Ctrl+R 打开历史浮层", (await page.locator(".palette").count()) === 1);

// ---- second Ctrl+R: palette closes, no reload -------------------------------
await page.keyboard.press("Control+r");
await page.waitForTimeout(600);
ok("#1b 再按 Ctrl+R 关闭浮层", (await page.locator(".palette").count()) === 0);
ok("#1c 未触发页面导航", navigations === navBefore, `navigations ${navBefore} -> ${navigations}`);
const unhandled = await page.evaluate(() => window.__unhandledReload);
ok("#1d Ctrl+R 默认行为被阻止", unhandled === 0, `unhandled=${unhandled}`);
const restored = await input.inputValue();
ok("#1e 关闭后恢复原输入", restored === "echo ctrl-r-probe", restored);
await page.screenshot({ path: `${OUT}/fx01-ctrlr.png` });

// ---- F5 must not reload either ---------------------------------------------
await page.keyboard.press("F5");
await page.waitForTimeout(500);
ok("#1f F5 不刷新", navigations === navBefore, `navigations=${navigations}`);

// ---- export toast ----------------------------------------------------------
await input.fill("");
await page.locator(".link-btn", { hasText: "导出指令集" }).click();
await page.waitForSelector(".toast", { timeout: 5000 });
const toast = (await page.locator(".toast").innerText()).trim();
logs.push(`INFO toast: ${toast}`);
ok("#2a 提示含文件名", /quick-commands-\d+\.json/.test(toast), toast);
ok("#2b 提示不含绝对路径", !/[A-Za-z]:\\|\/f\/|\/home\//i.test(toast), toast);
ok("#2c 不再出现悬浮黑条", (await page.locator(".quick-notice").count()) === 0);
await page.screenshot({ path: `${OUT}/fx02-export-toast.png` });

console.log(logs.join("\n"));
const fails = logs.filter((l) => l.startsWith("FAIL"));
console.log(`\n==== ${logs.filter((l) => l.startsWith("PASS")).length} passed, ${fails.length} failed ====`);
await browser.close();
process.exit(fails.length ? 1 : 0);
