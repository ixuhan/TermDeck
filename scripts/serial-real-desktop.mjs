/**
 * Real serial session against an actual port.
 *
 * Uses COM1 (motherboard UART, always present, nothing attached) so the open /
 * pause / resume path runs against the real driver instead of the mock.
 */
import { chromium } from "playwright";
import { spawn, execSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const EXE = path.resolve("src-tauri/target/release/termdeck.exe");
const PORT = "COM1";
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

// The app restores sessions on boot and reopens their ports; a leftover serial
// session from a previous run would hold COM1 and make this run fail.
try {
  fs.unlinkSync(path.resolve("src-tauri/target/release/data/workspace_state.json"));
} catch {
  /* first run */
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

try {
  await waitForCdp();
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages()[0];
  page.on("pageerror", (e) => out.push(`[pageerror] ${e.message}`));
  await page.waitForSelector(".rail-ports", { timeout: 25000 });
  await wait(2500);

  const ports = await page.locator(".port-item").allInnerTexts();
  out.push(`INFO ports: ${JSON.stringify(ports)}`);
  ok("端口列表包含 COM1", ports.some((p) => p.includes(PORT)), `${ports.length} 个端口`);

  const row = page.locator(".port-item", { hasText: PORT }).first();
  await row.hover();
  await row.locator(".port-open").click();
  await wait(2500);

  const item = page.locator(".session-item").last();
  // Sessions start disconnected; connect explicitly.
  await item.hover();
  await item.locator(".serial-actions button").nth(0).click();
  await wait(2500);
  const name = (await item.locator(".serial-port-name").innerText()).trim();
  const meta = (await item.locator(".session-meta").innerText()).trim();
  out.push(`INFO session: ${name} / ${meta}`);
  ok("会话已创建", name === PORT, name);
  ok("真实端口打开成功", meta.includes("已连接"), meta);
  ok(
    "连接后终端已渲染",
    (await page.locator(".term-pane.is-active .term-surface").count()) === 1,
  );
  ok(
    "连接后占位层消失",
    (await page.locator(".term-pane.is-active .lazy-pane").count()) === 0,
  );

  // Status must reflect the driver, not just local state.
  const status = await page.evaluate((key) =>
    window.__TAURI_INTERNALS__.invoke("serial_status", { sessionKey: key }),
    await item.getAttribute("data-key"),
  );
  out.push(`INFO serial_status: ${JSON.stringify(status)}`);
  ok("后端报告端口已打开", status?.open === true, JSON.stringify(status));

  // Pause must actually close the handle.
  await item.hover();
  await item.locator(".serial-actions button").nth(0).click();
  await wait(1200);
  const paused = await page.evaluate((key) =>
    window.__TAURI_INTERNALS__.invoke("serial_status", { sessionKey: key }),
    await item.getAttribute("data-key"),
  );
  out.push(`INFO paused status: ${JSON.stringify(paused)}`);
  ok("暂停后端口已关闭", paused?.open === false && paused?.paused === true, JSON.stringify(paused));

  // Resume re-opens it.
  await item.hover();
  await item.locator(".serial-actions button").nth(0).click();
  await wait(2000);
  const resumed = await page.evaluate((key) =>
    window.__TAURI_INTERNALS__.invoke("serial_status", { sessionKey: key }),
    await item.getAttribute("data-key"),
  );
  out.push(`INFO resumed status: ${JSON.stringify(resumed)}`);
  ok("继续后端口重新打开", resumed?.open === true, JSON.stringify(resumed));

  const metaAfter = (await item.locator(".session-meta").innerText()).trim();
  ok("界面状态同步", metaAfter.includes("已连接"), metaAfter);
  await page.screenshot({ path: "shots/sr04-real.png" });

  // Writing to a real port with nothing attached must not throw.
  const sent = await page.evaluate(
    async (key) => {
      try {
        await window.__TAURI_INTERNALS__.invoke("serial_write_bytes", {
          sessionKey: key,
          bytes: [0x41, 0x42, 0x43],
        });
        return "ok";
      } catch (e) {
        return String(e);
      }
    },
    await item.getAttribute("data-key"),
  );
  ok("向真实端口写入不报错", sent === "ok", sent);

  // ---- log file ------------------------------------------------------------
  const key = await item.getAttribute("data-key");
  const logPath = await page.evaluate(async (k) => {
    const view = { hex: false, crAsNewline: true, localEcho: false, sendNewline: "\r\n" };
    const log = { enabled: true, template: "logs/%Port/%Y%M%D-%h%m%s.log", hex: false };
    await window.__TAURI_INTERNALS__.invoke("serial_pause", { sessionKey: k });
    await window.__TAURI_INTERNALS__.invoke("serial_update", {
      sessionKey: k,
      view,
      log,
      config: null,
    });
    await window.__TAURI_INTERNALS__.invoke("serial_resume", { sessionKey: k });
    const st = await window.__TAURI_INTERNALS__.invoke("serial_status", { sessionKey: k });
    return st?.logPath ?? null;
  }, key);
  out.push(`INFO log path: ${logPath}`);
  ok("日志路径已按模板生成", !!logPath && logPath.includes("logs") && logPath.includes(PORT), String(logPath));
  await wait(800);
  ok("日志文件已创建", !!logPath && fs.existsSync(logPath), String(logPath));
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
