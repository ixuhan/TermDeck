/**
 * Runs every suite in one go, without opening a window.
 *
 * Browser suites run against a temporary Vite dev server; desktop suites spawn
 * the real app with TERMDECK_TEST_HIDDEN=1, which moves the window off-screen
 * and hides it so nothing appears on top of whatever the user is doing.
 *
 * Exception: scrollback-test.mjs needs a live, on-screen WebView2 renderer —
 * a hidden window never drains xterm's write queue — so that single suite
 * shows a window briefly. Skip it with `node scripts/test-all.mjs quiet`
 * when working in the foreground.
 *
 *   node scripts/test-all.mjs            everything
 *   node scripts/test-all.mjs browser    only the dev-server suites
 *   node scripts/test-all.mjs desktop    only the real-app suites
 *   node scripts/test-all.mjs quiet      all except the window-visible suite
 */
import { spawn, execSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const BROWSER = [
  "linestamp-test.mjs",
  "shot.mjs",
  "regress.mjs",
  "dirpanel-test.mjs",
  "quickpanel-test.mjs",
  "quickfix-test.mjs",
  "serialsession-test.mjs",
  "serial-defaults-test.mjs",
  "serial-click-noautoconnect-test.mjs",
  "timestamp-test.mjs",
];

const DESKTOP = [
  "serialports-desktop.mjs",
  "contextmenu-desktop.mjs",
  "contextmenu-reserved-desktop.mjs",
  "ctrlr-desktop.mjs",
  "scrollback-test.mjs",
  "serial-real-desktop.mjs",
  "serial-logpath-desktop.mjs",
  "serial-loopback-desktop.mjs",
  "serial-logstamp-desktop.mjs",
  "timestamp-desktop.mjs",
];

const mode = process.argv[2] ?? "all";

function killApp() {
  try {
    execSync("taskkill /IM termdeck.exe /F", { stdio: "ignore" });
  } catch {
    /* nothing running */
  }
}

/** Runs one script and returns { name, passed, failed, output }. */
function run(script) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [`scripts/${script}`], {
      cwd: process.cwd(),
      env: { ...process.env, NO_PROXY: "127.0.0.1,localhost", no_proxy: "127.0.0.1,localhost" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", () => {
      const combined = `${stdout}\n${stderr}`;
      const fails = (combined.match(/^FAIL /gm) ?? []).length;
      const passes = (combined.match(/^PASS /gm) ?? []).length;
      // Port-dependent suites skip themselves when the virtual COM pair is
      // held by another program; report that instead of an empty 0/0 line.
      const skipped = /^SKIP /m.test(combined);
      resolve({ name: script, passed: passes, failed: fails, skipped, output: combined });
    });
  });
}

const results = [];

if (mode === "all" || mode === "browser" || mode === "quiet") {
  console.log("→ 启动 dev server（无窗口）");
  const dev = spawn("npm", ["run", "dev"], {
    cwd: process.cwd(),
    shell: true,
    stdio: "ignore",
    detached: false,
  });
  try {
    // Vite needs a moment; poll the port instead of guessing.
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      try {
        const res = await fetch("http://localhost:1420/");
        if (res.ok) break;
      } catch {
        /* not up yet */
      }
    }
    for (const s of BROWSER) {
      process.stdout.write(`  ${s.padEnd(22)}`);
      const r = await run(s);
      results.push(r);
      console.log(r.skipped ? "SKIP" : `${r.passed} passed, ${r.failed} failed`);
      if (r.failed) console.log(r.output.split("\n").filter((l) => l.startsWith("FAIL")).join("\n"));
    }
  } finally {
    try {
      execSync("taskkill /IM node.exe /F /FI \"WINDOWTITLE eq npm*\"", { stdio: "ignore" });
    } catch {
      /* ignore */
    }
    dev.kill("SIGTERM");
    await sleep(500);
  }
}

if (mode === "all" || mode === "desktop" || mode === "quiet") {
  const suites =
    mode === "quiet" ? DESKTOP.filter((s) => s !== "scrollback-test.mjs") : DESKTOP;
  for (const s of suites) {
    killApp();
    await sleep(1500);
    process.stdout.write(`  ${s.padEnd(22)}`);
    const r = await run(s);
    results.push(r);
    console.log(r.skipped ? "SKIP" : `${r.passed} passed, ${r.failed} failed`);
    if (r.failed) {
      console.log(
        r.output
          .split("\n")
          .filter((l) => l.startsWith("FAIL") || l.startsWith("THROW"))
          .join("\n"),
      );
    }
  }
  killApp();
}

const totalPass = results.reduce((n, r) => n + r.passed, 0);
const totalFail = results.reduce((n, r) => n + r.failed, 0);
const totalSkip = results.filter((r) => r.skipped).length;
console.log(
  `\n==== 合计 ${totalPass} passed, ${totalFail} failed` +
    (totalSkip ? `, ${totalSkip} skipped` : "") +
    (mode === "quiet" ? "（窗口全程未显示）" : "") +
    " ====",
);
process.exit(totalFail ? 1 : 0);
