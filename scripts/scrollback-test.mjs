/**
 * End-to-end check for terminal screen restore:
 *   1. run commands so the session has visible output
 *   2. wait for the debounced snapshot to hit disk
 *   3. kill the app (not a clean close - the periodic save must cover it)
 *   4. restart and confirm the old output is repainted above a separator
 *
 * WebGL is disabled for the run so the rendered text can be read from the DOM;
 * with the WebGL renderer the screen lives in a canvas and has no DOM text.
 */
import { chromium } from "playwright";
import { spawn, execSync } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const EXE = path.resolve("src-tauri/target/release/termdeck.exe");
const DATA = path.resolve("src-tauri/target/release/data");
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

function kill(child) {
  try {
    execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: "ignore" });
  } catch {
    /* already gone */
  }
}

let child = launch();
try {
  await waitForCdp();
  let browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  let page = browser.contexts()[0].pages()[0];
  await page.waitForSelector(".cmd-input", { timeout: 25000 });
  await wait(3000);

  // WebGL off so the text lands in the DOM where it can be asserted.
  const settingsFile = path.join(DATA, "settings.json");
  const settings = fs.existsSync(settingsFile)
    ? JSON.parse(fs.readFileSync(settingsFile, "utf8"))
    : {};
  if (settings.webgl !== false) {
    settings.webgl = false;
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
    kill(child);
    await wait(4000);
    child = launch();
    await waitForCdp();
    await wait(1500);
    browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
    page = browser.contexts()[0].pages()[0];
    await page.waitForSelector(".cmd-input", { timeout: 25000 });
    await wait(2500);
  }

  const input = page.locator(".cmd-input").first();
  await input.click();
  for (const marker of ["scr-a", "scr-b", "scr-c"]) {
    await input.fill(`echo scrollback-${marker}`);
    await page.keyboard.press("Enter");
    await wait(900);
  }
  await wait(500);

  const screenBefore = await page.locator(".xterm-rows").innerText().catch(() => "");
  ok("命令输出出现在屏幕上", screenBefore.includes("scrollback-scr-c"), `len=${screenBefore.length}`);

  // The debounce is 3s; give it room before pulling the plug.
  await wait(4200);

  const dir = path.join(DATA, "scrollback");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".ansi")) : [];
  out.push(`INFO snapshot files: ${files.length}`);
  ok("快照已落盘", files.length > 0, `${files.length} 个文件`);

  const body = files.length ? fs.readFileSync(path.join(dir, files[0]), "utf8") : "";
  ok("快照包含最后一条输出", body.includes("scrollback-scr-c"), `bytes=${body.length}`);
  ok("快照包含较早的输出", body.includes("scrollback-scr-a"), "");

  // Hard kill: no clean shutdown hooks, so this also proves the periodic save
  // is enough on its own.
  kill(child);
  await wait(5000);

  child = launch();
  await waitForCdp();
  await wait(2000);
  browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  page = browser.contexts()[0].pages()[0];
  await page.waitForSelector(".cmd-input", { timeout: 25000 });
  await wait(4000);

  const screenAfter = await page.locator(".xterm-rows").innerText().catch(() => "");
  out.push(`INFO restored screen length: ${screenAfter.length}`);
  ok("重启后旧输出仍在", screenAfter.includes("scrollback-scr-c"), "");
  ok("最早的那条也在", screenAfter.includes("scrollback-scr-a"), "");
  ok("有分隔标记", screenAfter.includes("以上为上次会话的输出"), "");
  await page.screenshot({ path: "shots/sc01-restored.png" });

  // The restored text must not be re-recorded as new history.
  const inputAfter = page.locator(".cmd-input").first();
  await inputAfter.click();
  await inputAfter.fill("");
  await page.keyboard.press("ArrowUp");
  await wait(900);
  const recalled = await inputAfter.inputValue();
  ok("历史仍是真实命令", recalled === "echo scrollback-scr-c", recalled);
} finally {
  console.log(out.join("\n"));
  const fails = out.filter((l) => l.startsWith("FAIL"));
  console.log(`\n==== ${out.filter((l) => l.startsWith("PASS")).length} passed, ${fails.length} failed ====`);
  kill(child);
  process.exit(fails.length ? 1 : 0);
}
