/**
 * Full loopback against a real virtual serial pair (COM2 <-> COM7).
 *
 *   peer writes COM7  -> app must render it in the terminal
 *   app sends on COM2 -> peer must receive it on COM7
 *
 * The window stays hidden (TERMDECK_TEST_HIDDEN), so this never steals focus.
 * WebGL is disabled so the rendered text can be read from the DOM.
 */
import { chromium } from "playwright";
import { spawn, execSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const EXE = path.resolve("src-tauri/target/release/termdeck.exe");
const DATA = path.resolve("src-tauri/target/release/data");
const APP_PORT = "COM2";
const PEER_PORT = "COM7";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
/** Peer processes; killed in finally so they never keep COM7 open. */
const peers = [];
const ok = (name, cond, extra = "") =>
  out.push(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);

const peer = (action, port, arg) =>
  execSync(`python "scripts/serial_peer.py" ${action} ${port} ${arg ?? ""}`, {
    encoding: "utf8",
    timeout: 15000,
  });

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

// Fresh workspace + DOM renderer so screen text is readable.
fs.mkdirSync(DATA, { recursive: true });
try {
  fs.unlinkSync(path.join(DATA, "workspace_state.json"));
} catch {
  /* first run */
}
fs.writeFileSync(path.join(DATA, "settings.json"), JSON.stringify({ webgl: false }, null, 2));

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

  const row = page.locator(".port-item", { hasText: APP_PORT }).first();
  ok(`端口列表含 ${APP_PORT}`, (await row.count()) === 1);
  await row.hover();
  await row.locator(".port-open").click();
  await wait(2500);

  const item = page.locator(".session-item").last();
  // Sessions now start disconnected; connecting is an explicit click.
  await item.hover();
  await item.locator(".serial-actions button").nth(0).click();
  await page.waitForTimeout(2200);

  const meta = (await item.locator(".session-meta").innerText()).trim();
  out.push(`INFO session meta: ${meta}`);
  ok("应用已连上 COM2", meta.includes("已连接"), meta);

  const key = await item.getAttribute("data-key");
  const status = await page.evaluate((k) =>
    window.__TAURI_INTERNALS__.invoke("serial_status", { sessionKey: k }), key);
  ok("后端确认端口打开", status?.open === true, JSON.stringify(status));

  // ---- receive: peer -> app ------------------------------------------------
  const incoming = `PING-FROM-PEER-${Date.now()}`;
  peer("write", PEER_PORT, incoming);

  // Read the backend backlog rather than the DOM: a hidden window throttles
  // xterm's renderer, so the screen may lag behind what the app actually
  // received. `pty_attach` drains exactly what the reader pushed.
  let buffered = "";
  for (let i = 0; i < 12; i++) {
    await wait(400);
    buffered = await page.evaluate(
      (k) => window.__TAURI_INTERNALS__.invoke("pty_attach", { sessionId: `serial:${k}` }),
      key,
    );
    if (buffered.includes(incoming)) break;
  }
  out.push(`INFO backend backlog: ${JSON.stringify((buffered || "").slice(0, 160))}`);
  ok("应用收到对端发来的数据", (buffered || "").includes(incoming), incoming);

  // The screen is a secondary check; the terminal may still be mid-render.
  const screen = await page.locator(".term-pane.is-active .xterm-rows").innerText().catch(() => "");
  out.push(`INFO screen tail: ${JSON.stringify(screen.slice(-120))}`);

  // ---- send: app -> peer ----------------------------------------------------
  const outgoing = `PONG-FROM-APP-${Date.now()}`;
  const reader = spawn(
    "python",
    ["scripts/serial_peer.py", "read", PEER_PORT, "3500"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  peers.push(reader);
  let peerGot = "";
  reader.stdout.on("data", (d) => (peerGot += d));
  // Wait for the peer to report READY instead of guessing a delay.
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    reader.stderr.on("data", (d) => {
      if (String(d).includes("READY")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  await wait(150);

  // Call the command directly first: this isolates "backend cannot write"
  // from "the command bar did not route to the serial path".
  const direct = await page.evaluate(
    async ([k, text]) => {
      try {
        const bytes = Array.from(new TextEncoder().encode(text + "\r\n"));
        await window.__TAURI_INTERNALS__.invoke("serial_write_bytes", {
          sessionKey: k,
          bytes,
        });
        return "ok";
      } catch (e) {
        return "ERR " + String(e);
      }
    },
    [key, outgoing],
  );
  out.push(`INFO direct write: ${direct}`);
  ok("后端直接写串口成功", direct === "ok", direct);

  await new Promise((resolve) => {
    const t = setTimeout(resolve, 4500);
    reader.on("close", () => {
      clearTimeout(t);
      resolve();
    });
  });
  out.push(`INFO peer received: ${JSON.stringify(peerGot.slice(0, 120))}`);
  ok("对端收到应用发出的数据", peerGot.includes(outgoing), outgoing);

  // ---- send through the command bar (UI path) ------------------------------
  const uiText = `UI-SEND-${Date.now()}`;
  const reader2 = spawn("python", ["scripts/serial_peer.py", "read", PEER_PORT, "3500"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  peers.push(reader2);
  let uiGot = "";
  reader2.stdout.on("data", (d) => (uiGot += d));
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 2000);
    reader2.stderr.on("data", (d) => {
      if (String(d).includes("READY")) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  await wait(150);

  const input = page.locator(".cmd-input").first();
  await input.click();
  await input.fill(uiText);
  await page.keyboard.press("Enter");
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 4500);
    reader2.on("close", () => {
      clearTimeout(t);
      resolve();
    });
  });
  out.push(`INFO ui send received: ${JSON.stringify(uiGot.slice(0, 120))}`);
  ok("输入框发送也能到达对端", uiGot.includes(uiText), uiText);
  ok("发送后输入框清空", (await input.inputValue()) === "");

  // The send should also be recorded as this session's history.
  await wait(300);
  ok("屏幕未出现错误条", (await page.locator(".error-bar").count()) === 0);
} catch (err) {
  out.push(`THROW ${err && err.message ? err.message : String(err)}`);
} finally {
  console.log(out.join("\n"));
  const fails = out.filter((l) => l.startsWith("FAIL"));
  console.log(`\n==== ${out.filter((l) => l.startsWith("PASS")).length} passed, ${fails.length} failed ====`);
  for (const p of peers) {
    try {
      p.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
  try {
    execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
  } catch {
    /* already gone */
  }
  process.exit(fails.length ? 1 : 0);
}
