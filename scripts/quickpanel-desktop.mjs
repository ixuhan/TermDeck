/**
 * Real WebView2 check: the quick-command list keeps a fixed height and scrolls
 * internally once it holds more cards than fit, and the footer stays pinned.
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

try {
  await waitForCdp();
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const page = browser.contexts()[0].pages()[0];
  page.on("pageerror", (e) => out.push(`[pageerror] ${e.message}`));
  await page.waitForSelector(".quick-list", { timeout: 25000 });
  await wait(2500);

  // Add enough cards to overflow the panel.
  const add = page.locator(".quick-add");
  for (let i = 0; i < 20; i++) {
    await add.click();
    await wait(90);
  }
  await wait(800);

  const m = await page.evaluate(() => {
    const list = document.querySelector(".quick-list");
    const foot = document.querySelector(".quick-foot");
    const panel = document.querySelector(".quick-panel");
    const body = document.querySelector(".app-body");
    return {
      cards: document.querySelectorAll(".quick-card").length,
      listClient: list.clientHeight,
      listScroll: list.scrollHeight,
      panelBottom: Math.round(panel.getBoundingClientRect().bottom),
      bodyBottom: Math.round(body.getBoundingClientRect().bottom),
      footBottom: Math.round(foot.getBoundingClientRect().bottom),
      win: window.innerHeight,
      doc: document.documentElement.scrollHeight,
      scrollbar: list.offsetWidth - list.clientWidth,
    };
  });
  out.push(`INFO ${JSON.stringify(m)}`);

  ok("指令卡已增加", m.cards >= 20, `${m.cards} 张`);
  ok("列表内可滚动", m.listScroll > m.listClient + 1, `${m.listClient} < ${m.listScroll}`);
  ok("面板未顶出窗口", m.panelBottom <= m.bodyBottom + 1, `panel=${m.panelBottom} body=${m.bodyBottom}`);
  ok("底部按钮可见", m.footBottom <= m.win, `foot=${m.footBottom} win=${m.win}`);
  ok("页面无整体滚动", m.doc <= m.win + 1, `doc=${m.doc}`);

  await page.screenshot({ path: "shots/q-desktop-top.png" });

  await page.evaluate(() => {
    const el = document.querySelector(".quick-list");
    el.scrollTop = el.scrollHeight;
  });
  await wait(500);
  const tail = await page.evaluate(() => {
    const cards = document.querySelectorAll(".quick-card");
    const last = cards[cards.length - 1].getBoundingClientRect();
    const list = document.querySelector(".quick-list").getBoundingClientRect();
    const foot = document.querySelector(".quick-foot").getBoundingClientRect();
    return {
      lastBottom: Math.round(last.bottom),
      listBottom: Math.round(list.bottom),
      footTop: Math.round(foot.top),
      scrollTop: document.querySelector(".quick-list").scrollTop,
    };
  });
  out.push(`INFO tail ${JSON.stringify(tail)}`);
  ok("滚到底能看见最后一条", tail.lastBottom <= tail.listBottom + 2, `${tail.lastBottom} <= ${tail.listBottom}`);
  ok("底部按钮不被遮挡", tail.footTop >= tail.listBottom - 1, `${tail.footTop} >= ${tail.listBottom}`);
  await page.screenshot({ path: "shots/q-desktop-bottom.png" });
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
