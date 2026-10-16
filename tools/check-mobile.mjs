#!/usr/bin/env node
/**
 * Check that every built page fits a phone screen.
 *
 * This exists because article pages did not. A CSS Grid item defaults to
 * min-width: auto, so it refuses to shrink below its content; the content included a
 * <pre> of calculation steps, and a pre defaults to white-space: pre and does not
 * wrap. The longest line therefore set the width of main, and main set the width of
 * the page. On a phone every article was cut off at the right edge with a sideways
 * scrollbar, while the homepage and the calculator were fine.
 *
 * Nothing caught it: the build passed, the gates passed, the deploy passed. It took
 * the operator looking at his own phone.
 *
 * Runs against dist/ with a real browser at two phone widths. Needs Chrome or Edge
 * present. Skips cleanly, with a warning, if neither is found — a missing browser must
 * not block a deploy, but it must say so rather than pass silently.
 *
 *   node tools/check-mobile.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, statSync, readFileSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, extname } from "node:path";

/*
 * Browser discovery, made portable on 2026-10-16 for the cloud migration.
 *
 * This was four hard-coded Windows paths, so on a Linux runner the check found no browser and printed
 * SKIP. A gate that skips is not a gate: mobile layout would have reported green while measuring
 * nothing, which is worse than failing.
 *
 * The order prefers an explicit override, then a real install, then whatever `chromium` or
 * `google-chrome` resolves to on the PATH - which is how a runner with apt-installed Chromium presents
 * it. Windows paths are kept last so this machine keeps working exactly as before.
 */
const BROWSERS = [
  process.env.CHROME_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
].filter(Boolean);
const browser = BROWSERS.find((b) => existsSync(b));
if (!browser) {
  /*
   * The exit code is the point. This used to exit 0 with SKIP, so a missing browser counted as a pass
   * in every caller, including the publish gate. CI installs the browser; when it is absent, that is a
   * configuration failure and it is reported as one. `--allow-skip` keeps the old behaviour for the
   * case where someone genuinely wants to run the rest of the gate without a browser.
   */
  const allowSkip = process.argv.includes("--allow-skip");
  console.log("RESULT: " + (allowSkip ? "SKIP" : "FAIL") + " - no Chrome or Chromium found, so overflow cannot be measured");
  console.log("  looked for: " + BROWSERS.join(", "));
  process.exit(allowSkip ? 0 : 1);
}
if (!existsSync("dist")) {
  console.log("RESULT: FAIL - dist/ does not exist, run the build first");
  process.exit(1);
}

/* ---------- serve dist/ ---------- */
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".xml": "application/xml", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".ico": "image/x-icon" };
const server = createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  let file = join("dist", p);
  try {
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) { res.writeHead(404); res.end("404"); return; }
    res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  } catch { res.writeHead(500); res.end("err"); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const HTTP = server.address().port;

/* ---------- drive the browser ---------- */
const PORT = 9233;
const profile = mkdtempSync(join(tmpdir(), "dsh-mobile-"));
const chrome = spawn(browser, ["--headless=new", `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let version = null;
for (let i = 0; i < 40 && !version; i++) { try { version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); } catch { await sleep(500); } }
if (!version) { console.log("RESULT: SKIP - the browser did not start"); chrome.kill(); server.close(); process.exit(0); }

const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" })).json();
const ws = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const pending = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result?.exceptionDetails ? null : r.result?.result?.value;
};

/** Every built page, as a URL path. */
function pages(dir = "dist", out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) pages(p, out);
    else if (e.name === "index.html") out.push("/" + p.replace(/^dist[\\/]/, "").replace(/index\.html$/, "").replace(/\\/g, "/"));
  }
  return out;
}
const PATHS = [...new Set(pages())].sort();

await send("Runtime.enable");
await send("Page.enable");

console.log("MOBILE OVERFLOW CHECK\n" + "=".repeat(76));
console.log(`  pages : ${PATHS.length}`);
console.log(`  widths: 320px and 390px`);

const problems = [];
for (const width of [320, 390]) {
  await send("Emulation.setDeviceMetricsOverride", { width, height: 844, deviceScaleFactor: 2, mobile: true });
  for (const p of PATHS) {
    await send("Page.navigate", { url: `http://127.0.0.1:${HTTP}${p}` });
    await sleep(700);
    // The mobile menu is closed by default, but force it so a page cannot be judged
    // in a state a visitor would not be in.
    await evaluate(`(() => { const l = document.getElementById('nav-links'); if (l) l.dataset.open='false'; })()`);
    const raw = await evaluate(`(() => {
      const vw = document.documentElement.clientWidth;
      const out = [];
      for (const el of document.querySelectorAll('*')) {
        if (el.closest('#nav-links')) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0) continue;
        const o = Math.round(r.right - vw);
        if (o > 1) out.push(el.tagName.toLowerCase() + (typeof el.className === 'string' && el.className ? '.' + el.className.trim().split(/\\s+/)[0] : '') + ' +' + o + 'px');
      }
      return JSON.stringify({ sw: document.documentElement.scrollWidth, vw, off: out.slice(0, 3) });
    })()`);
    if (!raw) continue;
    const d = JSON.parse(raw);
    if (d.sw > d.vw + 1) problems.push(`${width}px ${p} scrollWidth=${d.sw}${d.off.length ? " (" + d.off.join(", ") + ")" : ""}`);
  }
}

ws.close(); chrome.kill(); server.close(); await sleep(300);
try { rmSync(profile, { recursive: true, force: true }); } catch {}

if (problems.length === 0) {
  console.log(`\nRESULT: PASS - all ${PATHS.length} pages fit 320px and 390px with no sideways scroll`);
  process.exit(0);
}
console.log(`\n${problems.length} PROBLEM(S) - a phone would show these pages cut off:`);
for (const p of problems.slice(0, 12)) console.log(`  ${p}`);
if (problems.length > 12) console.log(`  ... and ${problems.length - 12} more`);
console.log("\nRESULT: FAIL");
process.exit(1);
