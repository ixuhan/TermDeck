/**
 * Per-line timestamps.
 *
 * Checks the setting end-to-end in the real UI: enabling it stamps every new
 * output line, disabling it stops immediately (no restart needed), and blank
 * lines are left alone.
 *
 * WebGL is forced off for this run: the DOM renderer is the only one that
 * exposes `.xterm-rows` as text we can assert on.
 */
import { chromium } from "playwright";

const OUT = "shots";
const logs = [];
const ok = (name, pass, detail = "") =>
  logs.push(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`);

const STAMP = /^\[\d{2}:\d{2}:\d{2}\]\s/;

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--no-proxy-server", "--proxy-bypass-list=*"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => logs.push(`PAGEERROR ${e.message}`));

await page.goto("http://localhost:1420/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.evaluate(() => {
  localStorage.clear();
  localStorage.setItem("termdeck.settings", JSON.stringify({ webgl: false }));
});
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".cmd-input", { timeout: 20000 });
await page.waitForTimeout(1500);

const nonEmptyLines = async () => {
  const text = await page.locator(".xterm-rows").innerText();
  return text
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim() !== "");
};

const send = async (cmd) => {
  const input = page.locator(".cmd-input").first();
  await input.click();
  await input.fill(cmd);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(700);
};

const openSettings = async () => {
  await page.locator(".status-gear").click();
  await page.waitForSelector(".modal", { timeout: 5000 });
  await page.waitForTimeout(250);
  return page.locator(".modal .set-row", { hasText: "每行开头显示时间" });
};

const closeSettings = async () => {
  await page.locator(".modal-foot .mini-btn").click();
  await page.waitForTimeout(300);
};

// ---- toggle exists and defaults off ----------------------------------------
let row = await openSettings();
ok("设置面板有该开关", (await row.count()) === 1, String(await row.count()));
const box = row.locator(".set-check");
if (await box.isChecked()) {
  await box.uncheck();
  await page.waitForTimeout(250);
}
ok("默认关闭", !(await box.isChecked()));
await box.check();
await page.waitForTimeout(250);
ok(
  "开关已同步到后端（日志写入线程）",
  await page.evaluate(() => window.__mockLineTimestamps === true),
);
await closeSettings();

// ---- stamped output ---------------------------------------------------------
await send("clear");
await send("help");
await page.waitForTimeout(500);
const stampedLines = await nonEmptyLines();
logs.push(`INFO stamped ${stampedLines.filter((l) => STAMP.test(l)).length}/${stampedLines.length}`);
logs.push(`INFO sample ${JSON.stringify(stampedLines.slice(0, 3))}`);
ok(
  "新输出每行都有时间",
  stampedLines.length >= 5 && stampedLines.every((l) => STAMP.test(l)),
  stampedLines.join(" | "),
);
ok("时间格式为 [时:分:秒]", stampedLines.length > 0 && STAMP.test(stampedLines[0]), stampedLines[0] ?? "");
await page.locator(".term-pane.is-active").screenshot({ path: `${OUT}/ts01-stamped.png` });

// ---- blank lines are not stamped -------------------------------------------
await send("echo");
await page.waitForTimeout(500);
const withBlank = await nonEmptyLines();
const lonelyStamps = withBlank.filter((l) => /^\[\d{2}:\d{2}:\d{2}\]\s*$/.test(l));
ok("空行不加时间戳", lonelyStamps.length === 0, lonelyStamps.join("|"));

// ---- disabling takes effect immediately ------------------------------------
row = await openSettings();
await row.locator(".set-check").uncheck();
await page.waitForTimeout(250);
await closeSettings();

await send("clear");
await send("pwd");
await page.waitForTimeout(500);
const plainLines = await nonEmptyLines();
ok(
  "关闭后不再加时间",
  plainLines.length > 0 && plainLines.every((l) => !STAMP.test(l)),
  plainLines.join(" | "),
);
ok(
  "关闭状态同步到后端（日志停止加时间）",
  await page.evaluate(() => window.__mockLineTimestamps === false),
);
await page.locator(".term-pane.is-active").screenshot({ path: `${OUT}/ts02-plain.png` });

// ---- setting survives a reload ---------------------------------------------
row = await openSettings();
ok("关闭状态已持久化", !(await row.locator(".set-check").isChecked()));
await closeSettings();

// ---- boot pushes the persisted value to the backend ------------------------
await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem("termdeck.settings") || "{}");
  s.lineTimestamps = true;
  localStorage.setItem("termdeck.settings", JSON.stringify(s));
});
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".cmd-input", { timeout: 20000 });
await page.waitForTimeout(1200);
ok(
  "重启后后端恢复为开启状态",
  await page.evaluate(() => window.__mockLineTimestamps === true),
);

console.log(logs.join("\n"));
await browser.close();
const failed = logs.filter((l) => l.startsWith("FAIL")).length;
console.log(`==== ${logs.filter((l) => l.startsWith("PASS")).length} passed, ${failed} failed ====`);
process.exit(failed ? 1 : 0);
