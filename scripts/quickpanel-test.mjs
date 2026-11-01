/**
 * Right sidebar quick-command list: with many entries the panel must keep a
 * fixed height (bounded by the window) and scroll internally, instead of being
 * stretched by its content and pushing the footer off-screen.
 */
import { chromium } from "playwright";

const OUT = "shots";
const logs = [];
const ok = (name, pass, detail = "") => {
  logs.push(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`);
};

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--no-proxy-server", "--proxy-bypass-list=*"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on("pageerror", (e) => logs.push(`PAGEERROR ${e.message}`));

await page.goto("http://localhost:1420/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".quick-list", { timeout: 20000 });
await page.waitForTimeout(1200);

// 24 extra commands, enough to overflow any reasonable panel height.
await page.evaluate(() => {
  const st = window.__tdStore.getState();
  const key = st.activeKey;
  for (let i = 0; i < 24; i++) {
    st.addQuick(key);
    const s = window.__tdStore.getState();
    const sess = s.sessions.find((x) => x.key === key);
    const last = sess.quickItems[sess.quickItems.length - 1];
    s.updateQuick(key, last.id, { label: `批量指令 ${i + 1}`, command: `echo no-${i + 1}` });
  }
});
await page.waitForTimeout(900);

const metrics = await page.evaluate(() => {
  const panel = document.querySelector(".quick-panel");
  const list = document.querySelector(".quick-list");
  const foot = document.querySelector(".quick-foot");
  const body = document.querySelector(".app-body");
  const p = panel.getBoundingClientRect();
  const f = foot.getBoundingClientRect();
  const b = body.getBoundingClientRect();
  return {
    count: document.querySelectorAll(".quick-card").length,
    panelTop: Math.round(p.top),
    panelBottom: Math.round(p.bottom),
    bodyBottom: Math.round(b.bottom),
    footBottom: Math.round(f.bottom),
    listClientH: list.clientHeight,
    listScrollH: list.scrollHeight,
    canScroll: list.scrollHeight > list.clientHeight + 1,
    overflowY: getComputedStyle(list).overflowY,
    docScrollH: document.documentElement.scrollHeight,
    winH: window.innerHeight,
  };
});
logs.push(`INFO ${JSON.stringify(metrics)}`);

ok("指令已加载 24+ 条", metrics.count >= 24, `${metrics.count} 条`);
ok("列表高度被约束（内容高于可视区）", metrics.canScroll, `${metrics.listClientH} < ${metrics.listScrollH}`);
ok("面板未超出窗口底部", metrics.panelBottom <= metrics.bodyBottom + 1, `panelBottom=${metrics.panelBottom} bodyBottom=${metrics.bodyBottom}`);
ok("底部按钮仍在视口内", metrics.footBottom <= metrics.winH, `footBottom=${metrics.footBottom} win=${metrics.winH}`);
ok("页面本身不被撑高", metrics.docScrollH <= metrics.winH + 1, `doc=${metrics.docScrollH}`);
await page.screenshot({ path: `${OUT}/q01-many-commands.png` });

// Wheel-scroll inside the list and confirm it actually moves.
const list = page.locator(".quick-list");
const before = await list.evaluate((el) => el.scrollTop);
await list.hover();
await page.mouse.wheel(0, 600);
await page.waitForTimeout(400);
const after = await list.evaluate((el) => el.scrollTop);
ok("列表可滚动", after > before, `${before} -> ${after}`);
await page.screenshot({ path: `${OUT}/q02-scrolled.png` });

// Scroll to the very bottom: the last card must be reachable and the footer
// must stay pinned.
await list.evaluate((el) => {
  el.scrollTop = el.scrollHeight;
});
await page.waitForTimeout(400);
const tail = await page.evaluate(() => {
  const cards = document.querySelectorAll(".quick-card");
  const last = cards[cards.length - 1].getBoundingClientRect();
  const list = document.querySelector(".quick-list").getBoundingClientRect();
  const foot = document.querySelector(".quick-foot").getBoundingClientRect();
  return {
    lastBottom: Math.round(last.bottom),
    listBottom: Math.round(list.bottom),
    footTop: Math.round(foot.top),
    footBottom: Math.round(foot.bottom),
  };
});
logs.push(`INFO tail ${JSON.stringify(tail)}`);
ok("滚到底能看到最后一条", tail.lastBottom <= tail.listBottom + 2, `last=${tail.lastBottom} listEnd=${tail.listBottom}`);
ok("底部按钮不被列表遮挡", tail.footTop >= tail.listBottom - 1, `footTop=${tail.footTop} listEnd=${tail.listBottom}`);
await page.screenshot({ path: `${OUT}/q03-bottom.png` });

// Directory panel still gets its own fixed slice.
const split = await page.evaluate(() => {
  const p = document.querySelector(".quick-panel").getBoundingClientRect();
  const d = document.querySelector(".dir-panel");
  return { panelH: Math.round(p.height), dirH: d ? Math.round(d.getBoundingClientRect().height) : null };
});
logs.push(`INFO split ${JSON.stringify(split)}`);
ok("快捷指令区与目录面板共存", split.dirH !== null && split.panelH > 120, JSON.stringify(split));

console.log(logs.join("\n"));
const fails = logs.filter((l) => l.startsWith("FAIL"));
console.log(`\n==== ${logs.filter((l) => l.startsWith("PASS")).length} passed, ${fails.length} failed ====`);
await browser.close();
process.exit(fails.length ? 1 : 0);
