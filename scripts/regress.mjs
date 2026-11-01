import { chromium } from "playwright";
import fs from "node:fs";

const browser = await chromium.launch({
  channel: "msedge",
  headless: true,
  args: ["--no-proxy-server", "--proxy-bypass-list=*"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const logs = [];
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
const ok = (name, cond, extra = "") =>
  logs.push(`${cond ? "PASS" : "FAIL"} ${name}${extra ? " :: " + extra : ""}`);

await page.goto("http://localhost:1420/", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.evaluate(() => localStorage.clear());
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForSelector(".cmd-input", { timeout: 20000 });
await page.waitForTimeout(1200);

const wait = (ms) => page.waitForTimeout(ms);

// ---- #1 new-session menu must stay inside the window ------------------------
await page.locator(".rail-add-wrap .icon-btn").click();
await wait(500);
const menuBox = await page.locator(".profile-menu").boundingBox();
const items = await page.locator(".profile-item").count();
ok("#1 menu in viewport", !!menuBox && menuBox.x >= 0 && items > 0, `x=${menuBox?.x} items=${items}`);
await page.screenshot({ path: "shots/r01-add-menu.png" });
await page.keyboard.press("Escape");
await page.mouse.click(500, 400);
await wait(300);

// ---- #4 history button in the command bar ----------------------------------
await page.locator(".cmd-history").click();
await wait(400);
const paletteOpen = await page.locator(".palette").count();
ok("#4 history button opens list", paletteOpen === 1);
await page.keyboard.press("Escape");
await wait(200);

// ---- #5 preset applies to the active session only --------------------------
const labelsOf = async () => (await page.locator(".quick-label").allInnerTexts()).map((s) => s.trim());

const beforeA = await labelsOf();
await page.locator(".quick-select").selectOption("embedded_arm");
await wait(500);
const afterA = await labelsOf();
ok("#5a preset applied to A", afterA.join("|") !== beforeA.join("|"), afterA.join(" | "));

// Switch to the *other* session (index 0) and confirm it kept its own list.
await page.locator(".session-item").nth(0).click();
await wait(700);
const afterB = await labelsOf();
const selectValue = await page.locator(".quick-select").inputValue();
ok(
  "#5b session B unchanged",
  afterB.join("|") === beforeA.join("|"),
  `B=${afterB.join(" | ")}`,
);
ok("#5c preset dropdown reset on switch", selectValue === "", `select=${selectValue}`);
await page.screenshot({ path: "shots/r05-preset-isolation.png" });

// ---- #6 adopt keys are configurable and multi-select -----------------------
await page.locator(".status-gear").click();
await wait(400);
const adoptChecks = page.locator(".adopt-item .set-check");
ok("#6a adopt options present", (await adoptChecks.count()) === 4);
await adoptChecks.nth(0).uncheck(); // Tab off
await adoptChecks.nth(3).check();   // ArrowUp on
await wait(300);
await page.locator(".modal-foot .mini-btn").click();
await wait(300);

const input = page.locator(".cmd-input").first();
await input.click();
await input.fill("");
await input.type("git ch", { delay: 40 });
await page.waitForSelector(".ghost", { timeout: 4000 }).catch(() => null);
const ghost = await page.locator(".ghost").first().textContent().catch(() => null);
const adoptState = await page.evaluate(() => window.__tdStore.getState().settings.adoptKeys);
ok("#6a2 tab disabled in store", adoptState.tab === false && adoptState.arrowUp === true, JSON.stringify(adoptState));
await page.keyboard.press("Tab");
await wait(200);
const afterTab = await input.inputValue();
ok("#6b Tab disabled", afterTab === "git ch", `ghost=[${ghost}] value=[${afterTab}]`);

await input.click();
await input.type("", { delay: 0 });
await page.keyboard.press("ArrowUp");
await wait(250);
const afterUp = await input.inputValue();
ok("#6c ArrowUp adopts", afterUp === "git checkout main && git pull --rebase", afterUp);

// restore defaults
await page.locator(".status-gear").click();
await wait(300);
await page.locator(".adopt-item .set-check").nth(0).check();
await page.locator(".adopt-item .set-check").nth(3).uncheck();
await page.locator(".modal-foot .mini-btn").click();
await wait(250);
await input.fill("");

// ---- #8 session switch keeps the manual pass-through lock ------------------
await page.locator(".mode-chip").click();
await wait(300);
const lockedChip = (await page.locator(".mode-chip").textContent()) ?? "";
await page.locator(".session-item").nth(0).click();
await wait(600);
const afterSwitch = (await page.locator(".mode-chip").textContent()) ?? "";
ok(
  "#8 lock survives session switch",
  lockedChip.includes("手动锁定") && afterSwitch.includes("手动锁定"),
  `before=${lockedChip.trim()} after=${afterSwitch.trim()}`,
);
await page.screenshot({ path: "shots/r08-locked.png" });

// ---- #9 fill-type command works while locked -------------------------------
const fillCard = page.locator(".quick-card.is-fill .quick-main").first();
if (await fillCard.count()) {
  await fillCard.click();
  await wait(500);
  const chip = (await page.locator(".mode-chip").textContent()) ?? "";
  const val = await input.inputValue();
  ok("#9 fill under lock", val.length > 0 && chip.includes("输入框"), `chip=${chip.trim()} val=${val}`);
}
await input.fill("");
await wait(200);

// ---- #11 data dir chip -----------------------------------------------------
const dataText = (await page.locator(".data-chip").textContent()) ?? "";
ok("#11 data dir chip", dataText.trim().length > 0, dataText.trim());
await page.screenshot({ path: "shots/r11-statusbar.png" });

// ---- #12 lazy spawn shows a start prompt for idle sessions -----------------
const lazyPanes = await page.locator(".lazy-pane").count();
logs.push(`INFO lazy panes = ${lazyPanes}`);

// ---- #13 bare ↑/↓ browses command history -------------------------------
await input.click();
await input.fill("");
await input.type("echo up-one", { delay: 15 });
await page.keyboard.press("Enter");
await wait(700);
await input.type("echo up-two", { delay: 15 });
await page.keyboard.press("Enter");
await wait(700);

await page.keyboard.press("ArrowUp");
await wait(400);
const up1 = await input.inputValue();
await page.keyboard.press("ArrowUp");
await wait(250);
const up2 = await input.inputValue();
await page.keyboard.press("ArrowDown");
await wait(250);
const down1 = await input.inputValue();
await page.keyboard.press("ArrowDown");
await wait(250);
const down2 = await input.inputValue();

ok("#13a ArrowUp loads newest", up1 === "echo up-two", up1);
ok("#13b ArrowUp steps older", up2 === "echo up-one", up2);
ok("#13c ArrowDown steps newer", down1 === "echo up-two", down1);
ok("#13d ArrowDown restores draft", down2 === "", `[${down2}]`);
await page.screenshot({ path: "shots/r13-history-nav.png" });

const fails = logs.filter((l) => l.startsWith("FAIL") || l.startsWith("[pageerror]"));
console.log(logs.join("\n"));
console.log(`\n==== ${logs.filter((l) => l.startsWith("PASS")).length} passed, ${fails.length} failed ====`);
fs.writeFileSync("shots/regress.log", logs.join("\n"), "utf8");
await browser.close();
process.exit(fails.length ? 1 : 0);
