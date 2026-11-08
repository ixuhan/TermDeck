/**
 * Serial session defaults:
 *   1. creating a session must NOT open the port (it resets USB-serial boards)
 *   2. enabling "save to file" makes the right-hand directory panel follow the
 *      log folder
 *   3. the fixed-directory mode offers a folder picker
 */
import { chromium } from "playwright";

const out = [];
const ok = (name, cond, extra = "") =>
  out.push(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--no-proxy-server", "--proxy-bypass-list=*"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => out.push(`PAGEERROR ${e.message}`));

try {
  await page.goto("http://localhost:1420/", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector(".cmd-input", { timeout: 25000 });
  await page.waitForTimeout(1500);

  const row = page.locator(".port-item").first();
  await row.hover();
  await row.locator(".port-open").click();
  await page.waitForTimeout(1200);

  const item = page.locator(".session-item").last();
  const meta = (await item.locator(".session-meta").innerText()).trim();
  out.push(`INFO meta after create: ${meta}`);
  ok("创建后不自动连接", meta.includes("未连接"), meta);

  // The terminal pane must offer "connect" rather than pretend to be running.
  const pane = page.locator(".term-pane.is-active");
  const connectBtn = pane.locator("button", { hasText: "连接串口" });
  ok("终端提示连接串口", (await connectBtn.count()) === 1);

  await item.hover();
  await item.locator(".serial-actions button").nth(0).click();
  await page.waitForTimeout(800);
  const connected = (await item.locator(".session-meta").innerText()).trim();
  out.push(`INFO meta after connect: ${connected}`);
  ok("点▶后连接成功", connected.includes("已连接"), connected);

  // The pane must switch from the placeholder to a real terminal surface.
  ok("连接后显示终端", (await page.locator(".term-pane.is-active .term-surface").count()) === 1);
  ok("连接后占位层消失", (await page.locator(".term-pane.is-active .lazy-pane").count()) === 0);

  // ---- logging -> directory panel follows ----------------------------------
  ok("连接前无目录面板", (await page.locator(".dir-panel").count()) === 0);

  await item.hover();
  await item.locator(".serial-actions button").last().click();
  await page.waitForSelector(".modal-serial", { timeout: 5000 });
  await page.locator(".modal-serial .set-row", { hasText: "保存接收数据到文件" })
    .locator(".set-check")
    .check();
  await page.waitForTimeout(400);
  await page.locator(".modal-foot .mini-btn", { hasText: "应用" }).click();
  await page.waitForTimeout(1200);

  const dirPanel = page.locator(".dir-panel");
  ok("开启日志后目录面板出现", (await dirPanel.count()) === 1);
  const crumbs = await page.locator(".dir-path").innerText().catch(() => "");
  out.push(`INFO dir path: ${crumbs.replace(/\n/g, " ")}`);
  ok("目录跟随到日志目录", crumbs.includes("mock") && crumbs.includes("logs"), crumbs);
  ok("处于锁定状态", (await page.locator(".dir-fixed-badge").count()) === 1);
  await page.screenshot({ path: "shots/sr05-follow-dir.png" });

  // ---- fixed mode has a folder picker --------------------------------------
  const picker = page.locator('.dir-panel .dir-actions button[title="选择固定目录"]');
  ok("固定模式有选择目录按钮", (await picker.count()) === 1);

  await page.locator(".dir-panel .dir-mode button", { hasText: "跟随" }).click();
  await page.waitForTimeout(400);
  ok(
    "切换跟随模式后按钮隐藏",
    (await page.locator('.dir-panel .dir-actions button[title="选择固定目录"]').count()) === 0,
  );
} finally {
  console.log(out.join("\n"));
  const fails = out.filter((l) => l.startsWith("FAIL"));
  console.log(`\n==== ${out.filter((l) => l.startsWith("PASS")).length} passed, ${fails.length} failed ====`);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
}
