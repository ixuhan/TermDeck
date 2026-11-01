import { chromium } from "playwright";
import { spawn, execSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const EXE = path.resolve("src-tauri/target/release/termdeck.exe");
const DATA = path.join(path.dirname(EXE), "data");
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

function launch() {
  const child = spawn(EXE, [], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222" },
  });
  child.unref();
  return child;
}

async function connect() {
  await waitForCdp();
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages()[0];
  page.on("dialog", (d) => d.accept());
  await page.waitForSelector(".cmd-input", { timeout: 25000 });
  await wait(1800);
  return { browser, page };
}

async function run(page, text) {
  const input = page.locator(".cmd-input").first();
  await input.click();
  await input.fill("");
  await input.type(text, { delay: 12 });
  await page.keyboard.press("Enter");
  await wait(1100);
}

async function recall(page) {
  const input = page.locator(".cmd-input").first();
  await input.click();
  await input.fill("");
  await page.keyboard.press("ArrowUp");
  await wait(600);
  const v = await input.inputValue();
  await page.keyboard.press("Escape");
  await input.fill("");
  return v;
}

// ---------------------------------------------------------------- pass 1
// The data dir is wiped by the caller: the sandbox intercepts fs.rmSync here.
if (fs.existsSync(DATA)) console.log("note: existing data dir will be reused");

console.log("step: launch#1");
let child = launch();
let pid = child.pid;
let { browser, page } = await connect();
console.log("step: connected#1");

// Boot activates the last created session, so pin session 0 explicitly.
await page.locator(".session-item").nth(0).click();
await wait(1500);
await run(page, "echo persist-A");
console.log("step: A done");
await page.locator(".session-item").nth(1).click();
await wait(1400);
await run(page, "echo persist-B");
console.log("step: B done");
await browser.close();

execSync(`taskkill /PID ${pid}`, { stdio: "ignore" });
console.log("step: closed#1");
await wait(6000);

// ---------------------------------------------------------------- pass 2
console.log("step: launch#2");
child = launch();
pid = child.pid;
({ browser, page } = await connect());
console.log("step: connected#2");

await page.locator(".session-item").nth(0).click();
await wait(1500);
const a = await recall(page);
ok("历史跨重启保留（会话 1）", a === "echo persist-A", `[${a}]`);

await page.locator(".session-item").nth(1).click();
await wait(1500);
const b = await recall(page);
ok("历史跨重启保留（会话 2）", b === "echo persist-B", `[${b}]`);

// clear button: scoped to session 2 only
await page.locator(".cmd-clear").click();
await wait(900);
await page.screenshot({ path: "shots/h03-after-clear.png" });
const afterClear = await recall(page);
ok("清除后本会话历史为空", afterClear === "", `[${afterClear}]`);

await page.locator(".session-item").nth(0).click();
await wait(1500);
const otherStill = await recall(page);
ok("其他会话历史不受影响", otherStill === "echo persist-A", `[${otherStill}]`);

await page.locator(".session-item").nth(1).click();
await wait(1200);
await page.screenshot({ path: "shots/h04-cleared-session.png" });
await browser.close();

execSync(`taskkill /PID ${pid}`, { stdio: "ignore" });
await wait(5000);

console.log(out.join("\n"));
console.log(
  `\n==== ${out.filter((l) => l.startsWith("PASS")).length} passed, ${out.filter((l) => l.startsWith("FAIL")).length} failed ====`,
);
