import { chromium } from "playwright";
import { spawn, execSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const EXE = path.resolve("src-tauri/target/release/termdeck.exe");
const DATA = path.join(path.dirname(EXE), "data");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const out = [];
const ok = (name, cond, extra = "") => out.push(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);

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

const isAlive = (pid) => {
  try {
    const res = execSync(`tasklist /FI "PID eq ${pid}" /NH`, { encoding: "utf8" });
    return res.includes(String(pid));
  } catch {
    return false;
  }
};

function launch() {
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
  return child;
}

async function connect() {
  await waitForCdp();
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages()[0];
  await page.waitForSelector(".cmd-input", { timeout: 25000 });
  await wait(1800);
  return { browser, page };
}

// ---------------------------------------------------------------- pass 1
if (fs.existsSync(DATA)) fs.rmSync(DATA, { recursive: true, force: true });

let child = launch();
let pid = child.pid;
const { browser, page } = await connect();

const input = page.locator(".cmd-input").first();
await input.click();
await input.type("cd C:\\Windows", { delay: 25 });
await page.keyboard.press("Enter");
await wait(1500);
await input.type("echo tdeck-hist-marker", { delay: 20 });
await page.keyboard.press("Enter");
await wait(1800);
await page.screenshot({ path: "shots/d01-before-close.png" });
await browser.close();

// ------------------------------------------------- graceful close (#2)
let killOut = "ok";
try {
  execSync(`taskkill /PID ${pid}`, { encoding: "utf8" });
} catch (e) {
  killOut = "taskkill: " + String(e.message).slice(0, 120);
}
out.push(`INFO ${killOut}`);
await wait(7000);
ok("#2 close button exits the app", !isAlive(pid), `pid=${pid}`);

// ------------------------------------------------- persisted state (#10/#11)
const wsFile = path.join(DATA, "workspace_state.json");
ok("#11 data dir next to exe", fs.existsSync(wsFile), DATA);

let savedCwd = null;
let savedKey = null;
if (fs.existsSync(wsFile)) {
  const ws = JSON.parse(fs.readFileSync(wsFile, "utf8"));
  const active = (ws.sessions ?? []).find((x) => x.id === ws.active_session_id);
  savedCwd = active?.shell_profile?.cwd;
  savedKey = active?.id;
  ok("#10 cwd persisted", /windows/i.test(savedCwd ?? ""), String(savedCwd));
  out.push(`INFO saved sessions=${ws.sessions.length} active=${ws.active_session_id}`);
  ok("#10b active key persisted", typeof ws.active_session_id === "string" && ws.active_session_id.length > 10);
}

// ---------------------------------------------------------------- pass 2
child = launch();
pid = child.pid;
const { browser: b2, page: p2 } = await connect();
const input2 = p2.locator(".cmd-input").first();
await input2.click();
await input2.type("echo tdeck-his", { delay: 30 });
await p2.waitForSelector(".ghost", { timeout: 5000 }).catch(() => null);
const ghost = await p2.locator(".ghost").first().textContent().catch(() => null);
ok("#3 history survives restart", (ghost ?? "").trim() === "t-marker", `ghost=[${ghost}]`);
await p2.screenshot({ path: "shots/d02-restored.png" });
await b2.close();

try {
  execSync(`taskkill /PID ${pid}`, { stdio: "ignore" });
} catch {
  /* ignore */
}
await wait(5000);
ok("#2b second close exits", !isAlive(pid));

const logFile = path.join(DATA, "termdeck.log");
if (fs.existsSync(logFile)) {
  const log = fs.readFileSync(logFile, "utf8");
  const m = /data dir = (.+)/.exec(log);
  out.push(`INFO ${m ? m[1].trim() : "no data dir line"}`);
}

console.log(out.join("\n"));
console.log(`\n==== ${out.filter((l) => l.startsWith("PASS")).length} passed, ${out.filter((l) => l.startsWith("FAIL")).length} failed ====`);
