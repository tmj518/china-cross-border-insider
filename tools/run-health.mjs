#!/usr/bin/env node
/**
 * The health read: streaks, and the difference between a bad afternoon and a broken deployment.
 *
 *   node tools/run-health.mjs            # print and write data/health.json
 *   node tools/run-health.mjs --quiet
 *
 * ## Why this exists
 *
 * On 2026-10-27 the trade line reported DUPLICATE-SUBJECT. That is the duplicate guard working - it is
 * supposed to refuse a subject that is already written. But it was the second day running, and one card
 * cannot tell "the guard caught a repeat" from "research has stopped being able to propose anything
 * new". Only a streak can, and a streak is the one thing a per-run notification structurally cannot
 * see.
 *
 * Same for the provider failures: one run with twenty timeouts that were all recovered is a fact about
 * the route. Five runs like it, with the recovered count never falling, means the primary provider has
 * not been reachable for a week and the "two vendor" arrangement is a claim on paper only.
 *
 * ## What it does not do
 *
 * It changes nothing. There is no auto-retry and no code path that reads its verdict, because a monitor
 * that acts is a monitor that can be wrong in a way nobody sees. It writes a file and says a sentence.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const RUNS = join(ROOT, "data", "runs");
const METRICS = join(ROOT, "data", "metrics");
const OUT = join(ROOT, "data", "health.json");
const quiet = process.argv.includes("--quiet");

/** Thresholds, stated so they can be argued with. */
const ALERT = {
  duplicateStreak: 2, // two runs in a row that could not find an unused subject
  sameVerdictStreak: 3, // three of the same verdict on one route
  unrecoveredRecent: 3, // unrecovered failures in any one run
};

/* ── runs ─────────────────────────────────────────────────────────────────────────────────────── */

const records = [];
for (const f of (existsSync(RUNS) ? readdirSync(RUNS).filter((x) => x.endsWith(".json")) : [])) {
  try {
    const j = JSON.parse(readFileSync(join(RUNS, f), "utf8"));
    if (!j?.at || !j?.verdict) continue;
    records.push({ at: j.at, route: (j.route ?? "?").toLowerCase(), verdict: j.verdict, article: j.article ?? "" });
  } catch {
    /* a half-written record is not a health problem */
  }
}
/* latest.json and the dated copy describe the same run; keep one per (at, route). */
const seen = new Set();
const runs = records
  .filter((r) => {
    const k = `${r.at}|${r.route}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  })
  .sort((a, b) => a.at.localeCompare(b.at));

const streaks = {};
for (const route of [...new Set(runs.map((r) => r.route))]) {
  const mine = runs.filter((r) => r.route === route);
  const last = mine[mine.length - 1];
  if (!last) continue;
  let n = 0;
  for (let i = mine.length - 1; i >= 0 && mine[i].verdict === last.verdict; i--) n++;
  streaks[route] = { verdict: last.verdict, count: n, at: last.at };
}

/* ── metrics ─────────────────────────────────────────────────────────────────────────────────── */

const metrics = [];
for (const f of (existsSync(METRICS) ? readdirSync(METRICS).filter((x) => x.endsWith(".json")) : [])) {
  try {
    metrics.push(JSON.parse(readFileSync(join(METRICS, f), "utf8")));
  } catch {
    /* ignore */
  }
}
metrics.sort((a, b) => String(a.at).localeCompare(String(b.at)));
const lastMetric = metrics[metrics.length - 1] ?? null;

/* ── the sentences ───────────────────────────────────────────────────────────────────────────── */

const warnings = [];

const dup = streaks.script;
if (dup && dup.verdict === "DUPLICATE-SUBJECT" && dup.count >= ALERT.duplicateStreak) {
  warnings.push(
    `The trade line has now ended DUPLICATE-SUBJECT ${dup.count} runs in a row. The guard is doing its job; ` +
      `what it cannot do is find a subject. Read this as research proposing covered ground, not as a publication bug.`,
  );
}

for (const [route, s] of Object.entries(streaks)) {
  if (s.count >= ALERT.sameVerdictStreak && s.verdict !== "DUPLICATE-SUBJECT") {
    warnings.push(`${route} has ended ${s.verdict} ${s.count} runs in a row.`);
  }
}

if (lastMetric && lastMetric.unrecovered >= ALERT.unrecoveredRecent) {
  warnings.push(
    `The last run had ${lastMetric.unrecovered} failures no fallback recovered (${JSON.stringify(lastMetric.byReason)}). ` +
      `Recovered failures are a fact about the route; unrecovered ones are a fault in the run.`,
  );
}

const recoveredSeries = metrics.slice(-7).map((m) => m.recovered ?? 0);
const allRecovered =
  recoveredSeries.length >= 3 && recoveredSeries.every((n) => n > 0) && (lastMetric?.unrecovered ?? 0) === 0;
if (allRecovered) {
  warnings.push(
    `Every failure in the last ${recoveredSeries.length} runs was recovered by the fallback. The configured ` +
      `two-vendor arrangement is not what is in force: the fallback is writing every piece.`,
  );
}

/* ── output ─────────────────────────────────────────────────────────────────────────────────── */

const health = {
  at: new Date().toISOString(),
  streaks,
  lastRun: runs[runs.length - 1] ?? null,
  metrics: { files: metrics.length, last: lastMetric, recoveredLast7: recoveredSeries },
  warnings,
};
mkdirSync(join(ROOT, "data"), { recursive: true });
writeFileSync(OUT, JSON.stringify(health, null, 2) + "\n", "utf8");

if (!quiet) {
  console.log("RUN HEALTH");
  console.log("=".repeat(72));
  for (const [route, s] of Object.entries(streaks)) {
    console.log(`  ${route.padEnd(8)} last ${String(s.verdict).padEnd(26)} ${s.count} in a row   (${s.at})`);
  }
  if (lastMetric) {
    console.log(
      `  failures  total ${lastMetric.total}  recovered ${lastMetric.recovered}  unrecovered ${lastMetric.unrecovered}`,
    );
  }
  if (warnings.length) {
    console.log("");
    for (const w of warnings) console.log(`  ! ${w}`);
  } else {
    console.log("\n  nothing out of the ordinary");
  }
  console.log(`\n  written: data/health.json`);
}
