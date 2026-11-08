/**
 * Regression: clicking a serial session (or switching to it) must NOT open the
 * port; only an explicit double-click or the connect (▶) button connects.
 *
 * Previously `activate()` called `ensureSpawned()` for every session, and for
 * serial sessions that meant `resumeSerial()` — so merely selecting the item
 * silently pulled DTR and reset the board.
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

  // ---- create a serial session (starts disconnected) ----------------------
  const firstPort = page.locator(".port-item").first();
  await firstPort.hover();
  await firstPort.locator(".port-open").click();
  await page.waitForTimeout(900);

  // A serial item is one carrying the `.serial-title` marker.
  const serialItem = page.locator(".session-item:has(.serial-title)");
  const portName = (await serialItem.locator(".serial-port-name").innerText()).trim();
  ok("串口会话已创建", /^COM\d+$/.test(portName), portName);

  const meta = () => serialItem.locator(".session-meta").innerText();

  // It is already active (creation sets activeKey), so first switch away to a
  // shell, then click back to the serial item to test activation.
  // Create a shell session to have a second item to switch to.
  await page.locator(".rail-add-wrap .icon-btn").click();
  await page.waitForTimeout(400);
  const profileCount = await page.locator(".profile-item").count();
  if (profileCount > 0) {
    await page.locator(".profile-item").first().click();
    await page.waitForTimeout(900);
  }

  // ---- click (single) on the serial item: must NOT connect ----------------
  await serialItem.click();
  await page.waitForTimeout(700);
  const afterClick = (await meta()).trim();
  ok("单击切换后保持未连接", afterClick.includes("未连接"), afterClick);

  // Confirm it actually became the active session (switch happened).
  const active = await serialItem.getAttribute("data-active");
  ok("单击后成为活动会话", active === "1", String(active));

  // ---- double-click: must connect -----------------------------------------
  await serialItem.dblclick();
  await page.waitForTimeout(1200);
  const afterDbl = (await meta()).trim();
  ok("双击后连接成功", afterDbl.includes("已连接"), afterDbl);

  // ---- switch away and back via single click again (already connected) ----
  const shellItem = page.locator(".session-item:not(:has(.serial-title))").first();
  if ((await shellItem.count()) > 0) {
    await shellItem.click();
    await page.waitForTimeout(400);
    await serialItem.click();
    await page.waitForTimeout(700);
    const stillConnected = (await meta()).trim();
    ok("已连接时单击切换保持连接", stillConnected.includes("已连接"), stillConnected);
  }

  await page.screenshot({ path: "shots/sr06-click-noautoconnect.png" });
} finally {
  console.log(out.join("\n"));
  const fails = out.filter((l) => l.startsWith("FAIL"));
  console.log(`\n==== ${out.filter((l) => l.startsWith("PASS")).length} passed, ${fails.length} failed ====`);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
}
