import { chromium } from "playwright";
import fs from "node:fs";

const OUT = "shots";
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--no-proxy-server", "--proxy-bypass-list=*"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const logs = [];
page.on("console", (m) => {
  if (m.type() === "error" || m.type() === "warning") logs.push(`[${m.type()}] ${m.text()}`);
});
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));

const ok = (name, cond, extra = "") =>
  logs.push(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);

await page.goto("http://localhost:1420/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForSelector(".cmd-input", { timeout: 20000 });
await page.waitForTimeout(900);

const input = page.locator(".cmd-input").first();

// --- 1. Ghost text -----------------------------------------------------------
await input.click();
await input.type("git ch", { delay: 50 });
await page.waitForTimeout(400);
const ghost = (await page.locator(".ghost").first().textContent()) ?? "";
ok("ghost-text", ghost === "eckout main && git pull --rebase", ghost);
await page.screenshot({ path: `${OUT}/02-ghost.png` });

// --- 2. Tab adopts -----------------------------------------------------------
await page.keyboard.press("Tab");
await page.waitForTimeout(120);
const adopted = await input.inputValue();
ok("tab-adopt", adopted === "git checkout main && git pull --rebase", adopted);

// --- 3. Execute reaches the PTY and lands in history -------------------------
// The xterm surface may be canvas/WebGL backed, so DOM text is not a reliable
// signal. Round-tripping through the history store proves the write path.
await page.keyboard.press("Enter");
await page.waitForTimeout(600);
await page.keyboard.press("Control+r");
await page.waitForTimeout(350);
const top = (await page.locator(".palette-cmd").first().innerText()).trim();
ok("command-recorded", top === "git checkout main && git pull --rebase", top);
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
await input.fill("");
await page.waitForTimeout(120);
await page.screenshot({ path: `${OUT}/04-executed.png` });

// --- 4. History palette ------------------------------------------------------
await input.type("git", { delay: 30 });
await page.waitForTimeout(120);
await page.keyboard.press("Control+r");
await page.waitForTimeout(350);
const paletteCount = await page.locator(".palette-item").count();
ok("palette-filters", paletteCount > 0, `${paletteCount} items`);
await page.screenshot({ path: `${OUT}/05-palette.png` });

// --- 5. Esc restores ---------------------------------------------------------
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
ok("palette-esc-restores", (await input.inputValue()) === "git", await input.inputValue());

// --- 6. Palette Enter executes ----------------------------------------------
await input.fill("");
await page.keyboard.press("Control+r");
await page.waitForTimeout(300);
await page.keyboard.press("ArrowDown");
await page.keyboard.press("Enter");
await page.waitForTimeout(400);
ok("palette-enter-runs", (await input.inputValue()) === "");

// --- 7. TUI passthrough ------------------------------------------------------
await input.type("vim", { delay: 30 });
await page.keyboard.press("Enter");
await page.waitForTimeout(700);
const modeChip = (await page.locator(".mode-chip").first().textContent()) ?? "";
const collapsed = await page.locator(".cmdbar-wrap.is-collapsed").count();
ok("passthrough-entered", modeChip.includes("直通") && collapsed === 1, modeChip.trim());
await page.screenshot({ path: `${OUT}/06-passthrough.png` });

await page.keyboard.press("q");
await page.waitForTimeout(700);
const modeBack = (await page.locator(".mode-chip").first().textContent()) ?? "";
ok("passthrough-exited", modeBack.includes("输入框"), modeBack.trim());
await page.screenshot({ path: `${OUT}/07-restored.png` });

// --- 8. Quick panel fill mode ------------------------------------------------
const fillBtn = page.locator(".quick-card.is-fill .quick-main").first();
if (await fillBtn.count()) {
  await fillBtn.click();
  await page.waitForTimeout(200);
  const filled = await input.inputValue();
  ok("quick-fill", filled.length > 0, filled);
  await page.screenshot({ path: `${OUT}/08-quick-fill.png` });
  await input.fill("");
}

// --- 9. Quick panel execute mode --------------------------------------------
const runBtn = page.locator(".quick-card:not(.is-fill) .quick-main").first();
if (await runBtn.count()) {
  await runBtn.click();
  await page.waitForTimeout(400);
  ok("quick-execute", (await input.inputValue()) === "");
}

// --- 10. Secret masking ------------------------------------------------------
await input.click();
await input.type("app --password=hunter2 --token abc", { delay: 10 });
await page.keyboard.press("Enter");
await page.waitForTimeout(400);
await input.type("pass", { delay: 30 });
await page.waitForTimeout(120);
await page.keyboard.press("Control+r");
await page.waitForTimeout(350);
const paletteText = (await page.locator(".palette").innerText()).replace(/\s+/g, " ");
ok("secret-masked", /--password=\*\*\*/.test(paletteText), paletteText.slice(0, 80));
await page.keyboard.press("Escape");
await page.waitForTimeout(150);
await input.fill("");

// --- 11. Settings panel ------------------------------------------------------
await page.locator(".status-gear").click();
await page.waitForTimeout(300);
const modalRows = await page.locator(".set-row").count();
ok("settings-open", modalRows >= 5, `${modalRows} rows`);
await page.screenshot({ path: `${OUT}/09-settings.png` });

// toggle ghost text off, verify persistence in localStorage
await page.locator(".set-check").first().uncheck();
await page.waitForTimeout(400);
const stored = await page.evaluate(() => localStorage.getItem("termdeck.settings"));
ok("settings-persisted", (stored ?? "").includes("ghostText"), stored ?? "");
await page.locator(".set-check").first().check();
await page.locator(".modal-foot .mini-btn").click();
await page.waitForTimeout(200);

// --- 12. Session isolated history -------------------------------------------
const sessions = await page.locator(".session-item").count();
ok("sessions-present", sessions >= 2, `${sessions} sessions`);

// --- 13. Rename + reload restore --------------------------------------------
await page.locator(".session-item").first().dblclick();
const rename = page.locator(".session-rename");
if (await rename.count()) {
  await rename.fill("验收会话");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(900);
}
await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(1500);
const titles = await page.locator(".session-title").allInnerTexts();
ok("workspace-restored", titles.includes("验收会话"), titles.join(" | "));
await page.screenshot({ path: `${OUT}/10-restored-workspace.png` });

const fails = logs.filter((l) => l.startsWith("FAIL") || l.startsWith("[pageerror]"));
fs.writeFileSync(`${OUT}/console.log`, logs.join("\n"), "utf8");
console.log(logs.join("\n"));
console.log(`\n==== ${logs.filter((l) => l.startsWith("PASS")).length} passed, ${fails.length} failed ====`);

await browser.close();
process.exit(fails.length ? 1 : 0);
