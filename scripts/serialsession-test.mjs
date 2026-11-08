/**
 * Serial session UI, exercised against the browser mock.
 *
 * Covers the parts that live in the frontend: creating a session from the port
 * list, switching baud from the inline pill, opening the settings dialog, and
 * pause/resume state. Real port I/O is covered by the Rust tests and by opening
 * an actual port in the desktop suite.
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

  // ---- create from the port panel -----------------------------------------
  const before = await page.locator(".session-item").count();
  const firstPort = page.locator(".port-item").first();
  await firstPort.hover();
  await firstPort.locator(".port-open").click();
  await page.waitForTimeout(900);

  const after = await page.locator(".session-item").count();
  out.push(`INFO sessions ${before} -> ${after}`);
  ok("从串口面板新建会话", after === before + 1, `${before} -> ${after}`);

  const item = page.locator(".session-item").last();
  const portName = (await item.locator(".serial-port-name").innerText()).trim();
  const baud = (await item.locator(".serial-baud-pill").innerText()).trim();
  out.push(`INFO header: ${portName} / ${baud}`);
  ok("显示端口名", /^COM\d+$/.test(portName), portName);
  ok("外层显示波特率", baud === "115200", baud);
  const meta = (await item.locator(".session-meta").innerText()).trim();
  out.push(`INFO meta: ${meta}`);
  ok("显示帧格式与状态", meta.includes("8N1") && meta.includes("已连接"), meta);
  await page.screenshot({ path: "shots/sr01-session.png" });

  // ---- baud pill menu ------------------------------------------------------
  await item.locator(".serial-baud-pill").click();
  await page.waitForTimeout(400);
  ok("点击胶囊弹出波特率菜单", (await page.locator(".baud-menu").count()) === 1);
  const options = await page.locator(".baud-menu button").allInnerTexts();
  out.push(`INFO baud options: ${options.length}`);
  ok("菜单含常用波特率", options.includes("9600") && options.includes("921600"), "");

  await page.locator(".baud-menu button", { hasText: "9600" }).first().click();
  await page.waitForTimeout(700);
  const baud2 = (await item.locator(".serial-baud-pill").innerText()).trim();
  ok("切换波特率生效", baud2 === "9600", baud2);
  const title = (await page.evaluate(() => document.title)).trim();
  out.push(`INFO window title: ${title}`);

  // ---- settings dialog -----------------------------------------------------
  await item.hover();
  await item.locator(".serial-actions button").nth(1).click();
  await page.waitForSelector(".modal-serial", { timeout: 5000 });
  await page.waitForTimeout(500);
  const groups = await page.locator(".modal-serial .set-group-title").allInnerTexts();
  out.push(`INFO groups: ${JSON.stringify(groups)}`);
  ok("弹窗含连接/显示/记录三组", groups.length >= 3, groups.join(" | "));
  ok("端口下拉存在", (await page.locator(".serial-select").count()) === 1);
  ok("日志模板输入存在", (await page.locator(".serial-input").count()) === 1);
  const template = await page.locator(".serial-input").inputValue();
  out.push(`INFO log template: ${template}`);
  ok("日志模板默认带占位符", template.includes("%Port") && template.includes("%Y"), template);
  await page.screenshot({ path: "shots/sr02-dialog.png" });

  // toggle hex inside the dialog and make sure it persists to the session
  const hexRow = page.locator(".modal-serial .set-row", { hasText: "HEX 显示" });
  await hexRow.locator(".set-check").check();
  await page.waitForTimeout(400);
  await page.locator(".modal-foot .mini-btn", { hasText: "应用" }).click();
  await page.waitForTimeout(600);
  ok("应用后弹窗关闭", (await page.locator(".modal-serial").count()) === 0);

  // ---- log folder shortcut appears only when logging is on ------------------
  await item.hover();
  const actionsBefore = await item.locator(".serial-actions button").count();
  await item.locator(".serial-actions button").last().click();
  await page.waitForSelector(".modal-serial", { timeout: 5000 });
  await page.waitForTimeout(300);
  const logRow = page.locator(".modal-serial .set-row", { hasText: "保存接收数据到文件" });
  await logRow.locator(".set-check").check();
  await page.waitForTimeout(400);
  await page.locator(".modal-foot .mini-btn", { hasText: "应用" }).click();
  await page.waitForTimeout(600);
  await item.hover();
  const actionsAfter = await item.locator(".serial-actions button").count();
  out.push(`INFO actions ${actionsBefore} -> ${actionsAfter}`);
  ok("开启日志后出现文件夹快捷按钮", actionsAfter === actionsBefore + 1, `${actionsBefore} -> ${actionsAfter}`);
  const logBtn = item.locator('.serial-actions button[title="打开日志文件夹"]');
  ok("按钮语义为打开日志文件夹", (await logBtn.count()) === 1, String(await logBtn.count()));

  // ---- pause / resume ------------------------------------------------------
  await item.hover();
  await item.locator(".serial-actions button").nth(0).click();
  await page.waitForTimeout(600);
  const pausedMeta = (await item.locator(".session-meta").innerText()).trim();
  ok("暂停后状态更新", pausedMeta.includes("暂停"), pausedMeta);
  await page.screenshot({ path: "shots/sr03-paused.png" });

  await item.hover();
  await item.locator(".serial-actions button").nth(0).click();
  await page.waitForTimeout(600);
  const resumedMeta = (await item.locator(".session-meta").innerText()).trim();
  ok("继续后恢复连接", resumedMeta.includes("已连接"), resumedMeta);

  // ---- send ----------------------------------------------------------------
  // Hex mode is on now, so this exercises the hex parser rather than text.
  const input = page.locator(".cmd-input").first();
  await input.click();
  await input.fill("41 42 43");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  ok("HEX 发送后输入框清空", (await input.inputValue()) === "");

  // Invalid hex must be rejected with a toast instead of sending garbage.
  await input.fill("ZZ");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  const toast = await page.locator(".toast").innerText().catch(() => "");
  ok("非法 HEX 被拒绝", toast.includes("HEX"), toast);
  ok("非法输入保留在输入框", (await input.inputValue()) === "ZZ");
} finally {
  console.log(out.join("\n"));
  const fails = out.filter((l) => l.startsWith("FAIL"));
  console.log(`\n==== ${out.filter((l) => l.startsWith("PASS")).length} passed, ${fails.length} failed ====`);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
}
