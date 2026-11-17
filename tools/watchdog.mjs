#!/usr/bin/env node
/**
 * FRESHNESS WATCHDOG - the system watching itself while nobody is looking.
 *
 * The operator went on leave on 2026-11-17 with one instruction: put the finding and the alerting inside the
 * cloud, and let the system repair its own bugs. Until now every check lived in a conversation: a human read
 * the Feishu cards, a human noticed a day with no article, a human ran the repair. This file is that human's
 * checklist expressed as code, running on every daily slot.
 *
 * What it answers, in this order:
 *   1. FRESHNESS  - is there an article dated today? how many hours since the last publish?
 *   2. HEALTH     - what did the last runs say? is a red verdict repeating?
 *   3. LINKAGE    - does every internal link resolve, or is a draft page being linked again?
 *   4. LIVE       - does today's slug return 200 and appear in the sitemap?
 *
 * Default is report-and-alert. `--fix` additionally repairs what is mechanically repairable (dangling links)
 * and says so in the alert. Exit code is 0 unless a check is CRITICAL, so a watchdog failure cannot silently
 * pass as a green step.
 *
 *   node tools/watchdog.mjs           report; alert on critical
 *   node tools/watchdog.mjs --fix     repair, then report
 *   node tools/watchdog.mjs --json    machine-readable
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIX = process.argv.includes("--fix");
const JSON_OUT = process.argv.includes("--json");
const find = (n, fallback) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1] ?? fallback;

const SITE = find("site", "https://www.landedmath.com");
const STALE_HOURS = Number(find("stale", 26));
const now = Date.now();

const checks = [];
const record = (level, name, detail) => checks.push({ level, name, detail });

/* 1 ---------------------------------------------------------------- freshness */
let latest = null;
for (const dir of ["blog", "guide"]) {
  const abs = join(ROOT, "src", "content", dir);
  if (!existsSync(abs)) continue;
  for (const f of readdirSync(abs)) {
    if (!f.endsWith(".md")) continue;
    const raw = readFileSync(join(abs, f), "utf8");
    if (/^draft:\s*true/m.test(raw)) continue;
    const m = /^publishDate:\s*"?(\d{4}-\d\d-\d\d)/m.exec(raw);
    if (!m) continue;
    const ts = Date.parse(m[1]);
    if (!latest || ts > latest.ts) latest = { ts, slug: f.replace(/\.md$/, ""), dir, date: m[1] };
  }
}
const today = new Date(now + 8 * 3600e3).toISOString().slice(0, 10);
if (!latest) record("critical", "freshness", "no published article found at all");
else {
  const hours = (now - latest.ts) / 3600e3;
  const isToday = latest.date === today;
  if (isToday) record("ok", "freshness", `today has ${latest.date === today ? "an article" : ""}: ${latest.slug}`);
  else if (hours > STALE_HOURS) record("critical", "freshness", `nothing published for ${Math.round(hours)}h (last ${latest.date} ${latest.slug})`);
  else record("warn", "freshness", `nothing dated today yet; last ${latest.date} ${latest.slug} (${Math.round(hours)}h ago)`);
}

/* 2 ------------------------------------------------------------------- health */
const runsDir = join(ROOT, "data", "runs");
let journals = [];
try {
  journals = readdirSync(runsDir)
    .filter((f) => f.endsWith(".json") && !f.startsWith("latest"))
    .map((f) => {
      try { return JSON.parse(readFileSync(join(runsDir, f), "utf8")); } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)));
} catch {}
const recent = journals.slice(0, 12);
const bad = recent.filter((j) => /^(REJECTED|WRITE-FAILED|DANGLING-LINK|NO-SUBJECT|NO-KEYS)/.test(String(j.verdict ?? "")));
if (!recent.length) record("warn", "health", "no run journal at all - the pipeline may never have run here");
else if (bad.length >= 3) record("critical", "health", `${bad.length} of the last ${recent.length} runs ended bad: ` + bad.slice(0, 3).map((j) => j.verdict).join(", "));
else if (bad.length) record("warn", "health", `${bad.length} of the last ${recent.length} ended bad: ` + bad.slice(0, 3).map((j) => j.verdict).join(", "));
else record("ok", "health", `last ${recent.length} runs all published`);

/* 3 ------------------------------------------------------------------ linkage */
let linkReport = "";
try {
  execFileSync(process.execPath, [join(ROOT, "tools", "link-check.mjs")], { cwd: ROOT, encoding: "utf8", timeout: 120000, stdio: "pipe" });
  record("ok", "linkage", "every internal link resolves");
} catch (e) {
  const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  const broken = (out.match(/broken targets\s*:\s*(\d+)/) ?? [])[1] ?? "?";
  linkReport = out.split("\n").filter((l) => /->|broken targets/.test(l)).slice(0, 4).join(" | ");
  if (FIX) {
    try {
      const fixOut = execFileSync(process.execPath, [join(ROOT, "tools", "repair-dangling.mjs")], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
      const n = (fixOut.match(/repaired (\d+)/) ?? [])[1] ?? "0";
      record(n === "0" ? "warn" : "ok", "linkage", `repaired ${n} dangling link(s) automatically` + (linkReport ? ` - ${linkReport.slice(0, 160)}` : ""));
    } catch (e2) {
      record("critical", "linkage", `repair failed: ${String(e2.message).slice(0, 120)}`);
    }
  } else record("critical", "linkage", `${broken} broken target(s): ${linkReport.slice(0, 200)}`);
}

/* 4 --------------------------------------------------------------------- live */
if (latest) {
  const url = `${SITE}/${latest.dir === "blog" ? "blog" : "guide"}/${latest.slug}/`;
  let code = "?";
  try {
    /* fetch, not curl.exe: the runner is Linux and has no curl.exe. That difference made a healthy page
       report "? " and the watchdog cry wolf on its first cloud run. */
    const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30000) });
    code = String(r.status);
  } catch (e) {
    code = "unreachable";
  }
  if (code === "200") record("ok", "live", `200 ${url}`);
  else record("critical", "live", `${code} ${url}`);
}

/* 5 ------------------------------------------------------ cloudflare deploy */
/*
 * The GitHub side can be green while Cloudflare is serving the previous build. This check only runs when a
 * token exists; when it does not, the watchdog says so instead of implying the deploy was verified.
 */
if (process.env.CF_API_TOKEN && process.env.CF_ACCOUNT_ID) {
  try {
    const out = execFileSync(process.execPath, [join(ROOT, "tools", "cf-status.mjs"), "--json"], { cwd: ROOT, encoding: "utf8", timeout: 90000 });
    const j = JSON.parse(out);
    /* Named project, and its domains must include the site: several projects and several zones share account. */
    const p0 = (j.projects ?? []).find((x) => x.name === (process.env.CF_PAGES_PROJECT ?? "china-cross-border-insider")) ?? j.projects?.[0];
    if (!p0) record("warn", "deploy", "no Pages project returned");
    else if (p0.servesSite === false) record("critical", "deploy", `${p0.name} does not serve landedmath.com (${(p0.domains ?? []).join(",") || "no domains"})`);
    else if (String(p0.stage) === "deploy" && String(p0.status) === "success") record("ok", "deploy", `${p0.name} ${p0.commit ?? "?"} deployed on ${(p0.domains ?? [])[0] ?? "?"}`);
    else record("critical", "deploy", `${p0.name} ${p0.commit ?? "?"} ${p0.stage}/${p0.status}`);
    const w = (j.workers ?? []).find((x) => /cron/i.test(x.name));
    if (w) record(w.schedules?.length ? "ok" : "critical", "clock", `${w.name}: ${(w.schedules ?? []).join(", ") || "no schedule"}`);
  } catch (e) {
    record("warn", "deploy", "cf-status could not answer: " + String(e.message).slice(0, 100));
  }
} else {
  record("warn", "deploy", "not verified - no CF token in this environment");
}

/* ------------------------------------------------------------------- verdict */
const critical = checks.filter((c) => c.level === "critical").length;
const warn = checks.filter((c) => c.level === "warn").length;

if (JSON_OUT) {
  console.log(JSON.stringify({ at: new Date().toISOString(), today, checks, critical, warn }, null, 2));
} else {
  console.log("WATCHDOG\n" + "=".repeat(74));
  for (const c of checks) console.log(`  ${c.level === "ok" ? "ok  " : c.level === "warn" ? "warn" : "CRIT"}  ${c.name.padEnd(10)} ${c.detail}`);
  console.log(`\n  RESULT: ${critical ? critical + " critical" : "healthy"}${warn ? `, ${warn} warning(s)` : ""}`);
}

/* ------------------------------------------------------------ the alert path */
const webhook = process.env.FEISHU_WEBHOOK;
if (webhook && critical) {
  const text = [
    "🔴 Landed Math — 看门狗告警",
    "",
    ...checks.filter((c) => c.level !== "ok").map((c) => `${c.level === "critical" ? "✗" : "!"} ${c.name}: ${c.detail}`),
    "",
    "这是云端自己在报警：没有人工在盯。",
  ].join("\n");
  try {
    const secret = (process.env.FEISHU_SECRET ?? "").trim();
    const ts = String(Math.floor(Date.now() / 1000));
    let url = webhook;
    if (secret) {
      const sign = (await import("node:crypto")).createHmac("sha256", `${ts}\n${secret}`).update("").digest("base64");
      url = `${webhook}&timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
    }
    const r = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msg_type: "text", content: { text } }),
      signal: AbortSignal.timeout(30000),
    });
    console.log("  alert: " + (r.ok ? "sent to Feishu" : "Feishu refused it (" + r.status + ")"));
  } catch (e) {
    console.log("  alert: failed - " + String(e.message).slice(0, 80));
  }
}

process.exit(critical ? 1 : 0);
