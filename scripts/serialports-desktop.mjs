/**
 * Serial port panel:
 *   - lists real COM ports (read-only)
 *   - height is draggable via the same handle the right sidebar uses
 *   - collapses to a header row
 *   - 1 Hz refresh is opt-in and shows a live "last refreshed" line
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

const panelHeight = (page) =>
  page.locator(".rail-ports").evaluate((el) => Math.round(el.getBoundingClientRect().height));

try {
  await waitForCdp();
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages()[0];
  page.on("pageerror", (e) => out.push(`[pageerror] ${e.message}`));
  await page.waitForSelector(".rail-ports", { timeout: 25000 });
  await wait(2500);

  const rows = await page.locator(".port-item").allInnerTexts();
  out.push(`INFO ports: ${JSON.stringify(rows)}`);
  ok("枚举到串口", rows.length > 0, `${rows.length} 条`);
  ok("端口名形如 COMx", rows.every((r) => /^COM\d+/.test(r.trim())), "");
  ok(
    "数量与标题一致",
    String(rows.length) === (await page.locator(".ports-count").innerText()).trim(),
    "",
  );
  ok("默认是手动刷新", (await page.locator(".ports-live").count()) === 0);

  // ---- drag handle ---------------------------------------------------------
  const before = await panelHeight(page);
  const handle = page.locator(".rail .resizer-h").first();
  ok("存在拖拽条", (await handle.count()) === 1);
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2, box.y - 90, { steps: 10 });
  await page.mouse.up();
  await wait(500);
  const after = await panelHeight(page);
  out.push(`INFO height ${before} -> ${after}`);
  ok("向上拖拽变高", after > before + 40, `${before} -> ${after}`);

  // Drag back down and make sure it can shrink too.
  const box2 = await handle.boundingBox();
  await page.mouse.move(box2.x + box2.width / 2, box2.y + box2.height / 2);
  await page.mouse.down();
  await page.mouse.move(box2.x + box2.width / 2, box2.y + 90, { steps: 10 });
  await page.mouse.up();
  await wait(500);
  const shrunk = await panelHeight(page);
  ok("向下拖拽变矮", shrunk < after - 40, `${after} -> ${shrunk}`);

  // ---- collapse ------------------------------------------------------------
  const collapseBtn = page.locator(".rail-ports .dir-actions button").nth(1);
  await collapseBtn.click();
  await wait(500);
  ok("折叠后列表隐藏", (await page.locator(".ports-list").count()) === 0);
  ok("折叠后拖拽条消失", (await page.locator(".rail .resizer-h").count()) === 0);
  const collapsed = await panelHeight(page);
  ok("折叠后只剩标题行", collapsed < 60, `h=${collapsed}`);
  await page.screenshot({ path: "shots/port01-collapsed.png" });

  await collapseBtn.click();
  await wait(600);
  ok("展开后高度还原", Math.abs((await panelHeight(page)) - shrunk) <= 2, "");

  // ---- 1 Hz mode -----------------------------------------------------------
  const oneSec = page.locator(".rail-ports .dir-mode button").nth(1);
  await oneSec.click();
  await wait(1600);
  ok("开启后出现状态行", (await page.locator(".ports-live").count()) === 1);
  const t1 = (await page.locator(".ports-live").innerText()).trim();
  out.push(`INFO live text #1: ${t1}`);
  ok("状态行显示刷新时间", /\d{2}:\d{2}:\d{2}/.test(t1), t1);

  await wait(2200);
  const t2 = (await page.locator(".ports-live").innerText()).trim();
  out.push(`INFO live text #2: ${t2}`);
  ok("时间随时间推进", t1 !== t2, `${t1} -> ${t2}`);
  ok("轮询期间列表稳定", (await page.locator(".port-item").count()) === rows.length, "");

  const manual = page.locator(".rail-ports .dir-mode button").nth(0);
  await manual.click();
  await wait(600);
  ok("切回手动后状态行消失", (await page.locator(".ports-live").count()) === 0);

  await page.screenshot({ path: "shots/port02-list.png" });
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
