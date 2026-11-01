import { chromium } from "playwright";
import fs from "node:fs";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--no-proxy-server", "--proxy-bypass-list=*"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const logs = [];
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
const ok = (name, cond, extra = "") =>
  logs.push(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);
const wait = (ms) => page.waitForTimeout(ms);

await page.goto("http://localhost:1420/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".dir-panel", { timeout: 20000 });
await wait(1200);

const crumbs = async () =>
  (await page.locator(".dir-crumb").allInnerTexts()).map((s) => s.trim()).join("\\");
const rows = async () => (await page.locator(".dir-name").allInnerTexts()).map((s) => s.trim());

// ---- 1. 默认展示当前终端目录 ----------------------------------------------
ok("#1 面板默认可见", (await page.locator(".dir-panel").count()) === 1);
const crumb0 = await crumbs();
ok("#1b 面包屑为当前目录", crumb0.endsWith("TermDeck"), crumb0);
const rows0 = await rows();
ok("#1c 列出目录内容", rows0.includes("src") && rows0.includes("package.json"), rows0.join(","));

// ---- 2. 动态模式跟随 cd ----------------------------------------------------
const input = page.locator(".cmd-input").first();
await input.click();
await input.type("cd docs", { delay: 20 });
await page.keyboard.press("Enter");
await wait(1000);
const crumb1 = await crumbs();
ok("#2 动态模式跟随 cd", crumb1.endsWith("docs"), crumb1);
const rows1 = await rows();
ok("#2b 内容已刷新", rows1.includes("BUILDING.md"), rows1.join(","));

// ---- 3. 手动进入子目录 -----------------------------------------------------
await page.locator(".dir-row", { hasText: "images" }).first().click();
await wait(800);
ok("#3 单击文件夹进入", (await crumbs()).endsWith("images"));
await page.locator(".dir-row.is-up").first().click();
await wait(800);
ok("#3b 返回上一级", (await crumbs()).endsWith("docs"));

// ---- 4. 固定模式不跟随 -----------------------------------------------------
await page.locator(".dir-mode button", { hasText: "固定" }).click();
await wait(300);
ok("#4 显示已锁定标记", (await page.locator(".dir-fixed-badge").count()) === 1);
await input.click();
await input.type("cd ..", { delay: 20 });
await page.keyboard.press("Enter");
await wait(1000);
ok("#4b 固定模式不跟随 cd", (await crumbs()).endsWith("docs"), await crumbs());

// ---- 5. 切回跟随立即同步 ---------------------------------------------------
await page.locator(".dir-mode button", { hasText: "跟随" }).click();
await wait(900);
ok("#5 切回跟随即同步", (await crumbs()).endsWith("TermDeck"), await crumbs());

// ---- 6. 折叠与展开 ---------------------------------------------------------
await page.locator(".dir-actions button[title='收起面板']").click();
await wait(400);
ok("#6 折叠后不渲染列表", (await page.locator(".dir-panel").count()) === 0);
ok("#6b 出现展开入口", (await page.locator(".dir-tab").count()) === 1);
await page.locator(".dir-tab").click();
await wait(800);
ok("#6c 重新展开", (await page.locator(".dir-panel").count()) === 1);

// ---- 7. 会话隔离 -----------------------------------------------------------
// Give the active session a different browse path, then confirm the other
// session is unaffected.
await page.locator(".dir-row", { hasText: "src" }).first().click();
await wait(900);
const pathA = await crumbs();
await page.locator(".session-item").nth(0).click();
await wait(1000);
const pathB = await crumbs();
ok("#7 会话浏览路径互不影响", pathA.endsWith("src") && pathB.endsWith("TermDeck"), `${pathA} | ${pathB}`);

const modes = await page.evaluate(() => {
  const s = window.__tdStore.getState();
  return s.sessions.map((x) => ({ title: x.title, mode: x.dir.mode, path: x.dir.currentPath }));
});
logs.push(`INFO ${JSON.stringify(modes)}`);

// Switch back: the first session remembers where it was.
await page.locator(".session-item").nth(1).click();
await wait(900);
ok("#7b 切回后保持各自路径", (await crumbs()).endsWith("src"), await crumbs());

// ---- 8. 冷启动还原：固定路径 + 模式 ---------------------------------------
// Spec only requires visible / mode / fixedPath to survive a restart; dynamic
// mode is expected to re-sync to the shell CWD.
await page.locator(".dir-mode button", { hasText: "固定" }).click();
await wait(400);
const lockedBefore = await crumbs();
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".dir-panel", { timeout: 20000 });
await wait(1800);
const lockedAfter = await crumbs();
const restored = await page.evaluate(() => {
  const s = window.__tdStore.getState();
  const a = s.sessions.find((x) => x.key === s.activeKey);
  return { visible: a.dir.visible, mode: a.dir.mode, fixed: a.dir.fixedPath };
});
ok("#8 固定路径冷启动还原", lockedAfter === lockedBefore && lockedAfter.endsWith("src"), `${lockedBefore} -> ${lockedAfter}`);
ok("#8b 模式与显隐还原", restored.mode === "fixed" && restored.visible === true, JSON.stringify(restored));

// Back to follow mode for the screenshot.
await page.locator(".dir-mode button", { hasText: "跟随" }).click();
await wait(700);

await page.screenshot({ path: "shots/dir02.png" });

const fails = logs.filter((l) => l.startsWith("FAIL") || l.startsWith("[pageerror]"));
console.log(logs.join("\n"));
console.log(`\n==== ${logs.filter((l) => l.startsWith("PASS")).length} passed, ${fails.length} failed ====`);
fs.writeFileSync("shots/dirpanel.log", logs.join("\n"), "utf8");
await browser.close();
process.exit(fails.length ? 1 : 0);
