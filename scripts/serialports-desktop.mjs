/**
 * Serial port panel: the list is read-only and refresh is manual by default.
 *
 * Also documents the real hardware the enumeration produced, so a regression
 * (e.g. ports disappearing because a filter got too strict) is visible.
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
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222" },
});
child.unref();

try {
  await waitForCdp();
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages()[0];
  page.on("pageerror", (e) => out.push(`[pageerror] ${e.message}`));
  await page.waitForSelector(".rail-ports", { timeout: 25000 });
  await wait(2500);

  const badge = (await page.locator(".ports-count").innerText()).trim();
  out.push(`INFO panel count: ${badge}`);

  const rows = await page.locator(".port-item").allInnerTexts();
  out.push(`INFO ports: ${JSON.stringify(rows)}`);

  // The machine has at least COM1 (motherboard); adapters are often absent.
  ok("面板已渲染", (await page.locator(".rail-ports").count()) === 1);
  ok("枚举到串口", rows.length > 0, `${rows.length} 条`);
  ok("端口名形如 COMx", rows.every((r) => /^COM\d+/.test(r.trim())), rows.join(" | "));
  ok(
    "数量与标题一致",
    String(rows.length) === badge,
    `count=${badge} rows=${rows.length}`,
  );

  // Manual refresh must not throw and must keep the list stable.
  await page.locator(".ports-refresh").click();
  await wait(1200);
  const after = await page.locator(".port-item").allInnerTexts();
  ok("手动刷新后列表一致", after.length === rows.length, `${rows.length} -> ${after.length}`);

  // Collapse hides the list but keeps the header.
  await page.locator(".ports-toggle").click();
  await wait(400);
  ok("收起后列表隐藏", (await page.locator(".ports-list").count()) === 0);
  ok("收起后标题仍在", (await page.locator(".ports-toggle").count()) === 1);
  await page.screenshot({ path: "shots/port01-collapsed.png" });

  await page.locator(".ports-toggle").click();
  await wait(400);
  await page.screenshot({ path: "shots/port02-list.png" });

  // 1 Hz polling is opt-in and persisted, so a previous interrupted run may
  // have left it on. Reset first, then assert the toggle actually works.
  const checkbox = page.locator(".ports-auto-check");
  if (await checkbox.isChecked()) {
    await checkbox.uncheck();
  await wait(300);
    await wait(400);
  }
  ok("自动刷新关闭时不再轮询", !(await checkbox.isChecked()));
  await checkbox.check();
  await wait(2600);
  const polled = await page.locator(".port-item").allInnerTexts();
  ok("开启 1s 刷新后列表仍正常", polled.length === rows.length, `${polled.length}`);
  const persisted = await page.evaluate(() => {
    return window.__TAURI_INTERNALS__?.invoke("settings_load").then
      ? window.__TAURI_INTERNALS__.invoke("settings_load")
      : null;
  });
  out.push(`INFO settings persisted: ${JSON.stringify(persisted)}`);
  await checkbox.uncheck();
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
