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

let lastRunTs = 0;
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
  /* A run can publish an article dated yesterday (a late slot, a re-publish). The run journal knows when the
   site actually gained a page; the article's own date does not. */
let lastRunTs = 0;
try {
  for (const f of readdirSync(join(ROOT, "data", "runs"))) {
    if (!f.endsWith(".json") || f.startsWith("latest")) continue;
    const j = JSON.parse(readFileSync(join(ROOT, "data", "runs", f), "utf8"));
    if (!/^PUBLISHED/.test(String(j.verdict ?? ""))) continue;
    const t = Date.parse(j.at);
    if (Number.isFinite(t) && t > lastRunTs) lastRunTs = t;
  }
} catch {}
const freshest = Math.max(latest.ts, lastRunTs);
const hours = (now - freshest) / 3600e3;
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
  /*
   * A 404 WHILE THE DEPLOY IS STILL IN FLIGHT IS NOT A BROKEN SITE.
   *
   * 2026-11-17 20:24: an article was committed at 20:23, Pages was still building, the watchdog asked for the
   * page three minutes later, got 404 and sent a red card. The page was live 200 ten minutes later. So: try
   * three times, and downgrade a 404 to a warning while a deployment is in flight.
   */
  let code = "?";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30000) });
      code = String(r.status);
    } catch {
      code = "unreachable";
    }
    if (code === "200") break;
    if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 15000));
  }
  if (code !== "200") {
    const deploying = checks.find((c) => c.name === "deploy" && /in flight/.test(c.detail));
    if (deploying) {
      code = "200-pending";
      record("warn", "live", `still deploying after three tries: ${url}`);
    }
  }
  /*
 * FRESH PUBLICATION IS NOT A 404 YOU CAN TRUST.
 *
 * 2026-11-19..11-24: every 07:20 run went red on "live 404" for the article it had just published - Pages was
 * still building. The article was live minutes later and the 09:20 backup then saw it and stood down. Six red
 * runs, zero broken pages. A 404 for a page published in the last 45 minutes is a warning.
 */
const ageMin = (now - Math.max(latest.ts, lastRunTs)) / 60000;
if (code === "200") record("ok", "live", `200 ${url}`);
else if (ageMin < 45) record("warn", "live", `${code} but published ${Math.round(ageMin)}m ago - deploy may still be running`);
else record("critical", "live", `${code} ${url}`);
}

/* 5b ------------------------------------------------------ topic supply */
/*
 * A SITE THAT RUNS OUT OF TOPICS STOPS QUIETLY.
 *
 * The radar wrote 21 cell files today but only 8 usable candidates, and the guide queue held 4 entries. When
 * the queue empties the pipeline does not crash - it publishes a fallback guide and looks healthy while the
 * growth stops. This is the check that makes the silence visible.
 */
try {
  let depth = 0;
  for (const f of ["data/guide-queue.json"]) {
    const abs = join(ROOT, f);
    if (!existsSync(abs)) continue;
    const j = JSON.parse(readFileSync(abs, "utf8"));
    depth += Array.isArray(j) ? j.length : (j.topics?.length ?? j.items?.length ?? 0);
  }
  if (depth >= 10) record("ok", "topics", `${depth} queued topic(s)`);
  else if (depth >= 4) record("warn", "topics", `only ${depth} queued topic(s) - the weekly radar runs on Mondays`);
  else record("critical", "topics", `${depth} queued topic(s): the queue is nearly empty and growth will stall`);
} catch (e) {
  record("warn", "topics", "queue unreadable: " + String(e.message).slice(0, 80));
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
    else {
      const stage = String(p0.stage ?? "?");
      const status = String(p0.status ?? "?");
      /*
       * A DEPLOYMENT THAT IS STILL BUILDING IS NOT A FAILURE.
       *
       * 2026-11-17: the watchdog fired twice within an hour because the newest deployment was stage=build,
       * status=active - a deploy in flight. The check treated "not yet deploy" as broken and sent a red card
       * while the site was fine. In-flight is a warning; broken is a failure; stalled is a failure after 90m.
       */
      const born = Date.parse(p0.created ?? p0.created_on ?? "") || now;
      const minutes = Math.round((now - born) / 60000);
      if (status === "failure" || status === "canceled") record("critical", "deploy", `${p0.name} ${p0.commit ?? "?"} ${stage}/${status}`);
      else if (stage === "deploy") record("ok", "deploy", `${p0.name} ${p0.commit ?? "?"} deployed on ${(p0.domains ?? [])[0] ?? "?"}`);
      else if (minutes <= 90) record("warn", "deploy", `${p0.name} ${p0.commit ?? "?"} ${stage}/${status} - in flight, ${minutes}m`);
      else record("critical", "deploy", `${p0.name} ${p0.commit ?? "?"} stuck at ${stage}/${status} for ${minutes}m`);
    }
    const w = (j.workers ?? []).find((x) => /cron/i.test(x.name));
    if (w) record(w.schedules?.length ? "ok" : "critical", "clock", `${w.name}: ${(w.schedules ?? []).join(", ") || "no schedule"}`);
  } catch (e) {
    record("warn", "deploy", "cf-status could not answer: " + String(e.message).slice(0, 100));
  }
} else {
  record("warn", "deploy", "not verified - no CF token in this environment");
}

/* 6 ----------------------------------------------------------- growth vs target */
/*
 * THE GOAL IS 10,000 UV/DAY. This line says where the site actually is, because a number nobody prints is a
 * number nobody improves: activeUsers over the GA4 window divided by the window, and the library that produced it.
 */
try {
  const dir = join(ROOT, "data", "analytics");
  const snaps = existsSync(dir) ? readdirSync(dir).filter((f) => /^ga4-\d{4}-\d\d-\d\d\.json$/.test(f)).sort() : [];
  let pages = 0;
  for (const d of ["blog", "guide"]) {
    try {
      for (const f of readdirSync(join(ROOT, "src", "content", d))) {
        if (!f.endsWith(".md")) continue;
        if (/^draft:\s*true/m.test(readFileSync(join(ROOT, "src", "content", d, f), "utf8"))) continue;
        pages++;
      }
    } catch {}
  }
  if (!snaps.length) record("warn", "growth", `no GA4 snapshot; ${pages} page(s) published`);
  else {
    const j = JSON.parse(readFileSync(join(dir, snaps[snaps.length - 1]), "utf8"));
    const users = Number(j.totals?.activeUsers ?? 0);
    const windowDays = Number(j.days ?? 28);
    const perDay = users / windowDays;
    const pct = ((perDay / 10000) * 100).toFixed(2);
    record(perDay >= 10000 ? "ok" : "warn", "growth", `${perDay.toFixed(1)} UV/day over ${windowDays}d from ${pages} pages = ${pct}% of the 10,000 target`);
  }
} catch (e) {
  record("warn", "growth", "growth numbers unreadable: " + String(e.message).slice(0, 80));
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
