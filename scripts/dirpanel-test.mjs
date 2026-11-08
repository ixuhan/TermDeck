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

// ---- 3. 手动进入子目录（单击只选中，双击才进入）-----------------------------
const beforeClick = await crumbs();
await page.locator(".dir-row", { hasText: "images" }).first().click();
await wait(500);
ok("#3a 单击文件夹只选中不进入", (await crumbs()) === beforeClick, await crumbs());
await page.locator(".dir-row", { hasText: "images" }).first().dblclick();
await wait(800);
ok("#3 双击文件夹进入", (await crumbs()).endsWith("images"), await crumbs());
await page.locator(".dir-row.is-up").first().dblclick();
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
await page.locator(".dir-row", { hasText: "src" }).first().dblclick();
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

// ---- 9. 排序方式 -----------------------------------------------------------
// Assertions are relative to whatever directory the panel currently shows, so
// they hold for both the mock VFS and the real backend.
const entries = async () =>
  page.locator(".dir-row:not(.is-up)").evaluateAll((rows) =>
    rows.map((r) => ({
      name: r.querySelector(".dir-name")?.textContent?.trim() ?? "",
      isDir: !!r.querySelector(".dir-icon.is-dir"),
      meta: r.querySelector(".dir-size")?.textContent?.trim() ?? "",
    })),
  );
const fileNames = async () => (await entries()).filter((e) => !e.isDir).map((e) => e.name);
const ext = (n) => {
  const i = n.lastIndexOf(".");
  return i > 0 ? n.slice(i).toLowerCase() : "";
};
const parseSize = (t) => {
  const m = /^([\d.]+)\s*(B|KB|MB)$/.exec(t);
  if (!m) return 0;
  const n = Number(m[1]);
  return m[2] === "MB" ? n * 1048576 : m[2] === "KB" ? n * 1024 : n;
};

const select = page.locator(".dir-sort-select");
ok("#9a 排序控件存在", (await select.count()) === 1);
ok("#9b 默认按名称升序", (await select.inputValue()) === "name" && (await page.locator(".dir-sort-dir").innerText()) === "↑");
const byName = await fileNames();
const nameSorted = [...byName].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
ok("#9c 名称升序", byName.join(",") === nameSorted.join(","), byName.join(","));

await select.selectOption("mtime");
await wait(500);
const byTime = await fileNames();
ok("#9d 按修改时间改变顺序", byTime.length > 1 && byTime.join(",") !== byName.join(","), byTime.join(","));
const timeCells = (await entries()).filter((e) => !e.isDir).map((e) => e.meta);
ok("#9e 时间列显示修改时间", timeCells.every((t) => /^\d{2}-\d{2} \d{2}:\d{2}$/.test(t)), timeCells.join("|"));

await page.locator(".dir-sort-dir").click();
await wait(500);
const timeDesc = await fileNames();
ok("#9f 降序反转", timeDesc.join(",") === [...byTime].reverse().join(","), timeDesc.join(","));
const foldersFirst = await entries();
ok("#9g 文件夹始终在前", foldersFirst.findIndex((e) => !e.isDir) > foldersFirst.filter((e) => e.isDir).length - 1);

await page.locator(".dir-sort-dir").click(); // back to ascending
await select.selectOption("size");
await wait(500);
const sizes = (await entries()).filter((e) => !e.isDir).map((e) => parseSize(e.meta));
ok("#9h 按大小升序", sizes.every((v, i) => i === 0 || sizes[i - 1] <= v), sizes.join(","));

await select.selectOption("type");
await wait(500);
const byType = await fileNames();
const exts = byType.map(ext);
ok("#9i 按类型分组", exts.every((v, i) => i === 0 || exts[i - 1] <= v), exts.join(","));

// Sorting choice is a persisted setting.
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".dir-sort-select", { timeout: 20000 });
await wait(900);
ok("#9j 排序方式持久化", (await page.locator(".dir-sort-select").inputValue()) === "type");

// ---- 10. 自动刷新 ----------------------------------------------------------
const refreshMode = page.locator(".dir-sortbar .dir-mode");
ok("#10a 刷新方式控件存在", (await refreshMode.count()) === 1);
const manualBtn = refreshMode.locator("button", { hasText: "手动" });
const autoBtn = refreshMode.locator("button", { hasText: "1s" });
ok("#10b 默认手动", (await manualBtn.getAttribute("class"))?.includes("is-on") === true);
ok("#10c 手动时不显示状态行", (await page.locator(".dir-live").count()) === 0);

await autoBtn.click();
await wait(500);
const live1 = await page.locator(".dir-live").innerText();
ok("#10d 1s 模式显示状态行", /每秒刷新/.test(live1), live1);
await wait(2400);
const live2 = await page.locator(".dir-live").innerText();
ok("#10e 刷新时间随轮询推进", live1 !== live2, `${live1} -> ${live2}`);

// The choice is a persisted setting, just like the sort key.
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".dir-sortbar .dir-mode", { timeout: 20000 });
await wait(1000);
ok("#10f 1s 模式持久化", (await page.locator(".dir-sortbar .dir-mode button", { hasText: "1s" }).getAttribute("class"))?.includes("is-on") === true);
ok("#10g 重启后状态行仍在", (await page.locator(".dir-live").count()) === 1);

await page.locator(".dir-sortbar .dir-mode button", { hasText: "手动" }).click();
await wait(400);
ok("#10h 切回手动后状态行消失", (await page.locator(".dir-live").count()) === 0);

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
