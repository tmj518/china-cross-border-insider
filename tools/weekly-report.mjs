#!/usr/bin/env node
/**
 * The weekly card: five lines of numbers and, only when something is wrong, one line that says what.
 *
 *   node tools/weekly-report.mjs            # print the card text
 *   node tools/weekly-report.mjs --send     # post it to FEISHU_WEBHOOK
 *
 * ## Where each number comes from
 *
 *   GSC          tools/gsc-report.mjs --json, summed over pages. Search Console cannot be reached from
 *                here without the credential, and the credential lives in CI, so this runs there.
 *   GA4          the newest data/analytics/ga4-*.json, written earlier in the same job.
 *   experiments  data/experiments/*.json, the twenty-eight-day files, not data/backtest.jsonl -
 *                that one is the title-level backtest and answers a different question.
 *   deltas       the previous card, stored under data/reports/. Without it the line says 未取到 rather
 *                than repeating this week's number and calling the change zero.
 *
 * ## The rule that matters
 *
 * A number that could not be read is written 未取到. It is never written 0 and never estimated. A card
 * that says zero impressions when the truth is "the credential was missing" is worse than no card: it
 * looks like a measurement and it will be acted on as one.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const REPORTS = join(ROOT, "data", "reports");
const EXPERIMENTS = join(ROOT, "data", "experiments");
const ANALYTICS = join(ROOT, "data", "analytics");
const MISSING = "未取到";

const today = new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------------ gsc */

function gscTotals() {
  try {
    const out = execFileSync(process.execPath, [join(ROOT, "tools", "gsc-report.mjs"), "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 120000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const j = JSON.parse(out.slice(out.indexOf("{")));
    const pages = j.pages ?? [];
    if (!pages.length) return null;
    const impressions = pages.reduce((a, p) => a + (p.impressions ?? 0), 0);
    const clicks = pages.reduce((a, p) => a + (p.clicks ?? 0), 0);
    return { impressions, clicks, ctr: impressions ? clicks / impressions : 0, days: j.days ?? 90 };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ ga4 */

function ga4Active30() {
  if (!existsSync(ANALYTICS)) return null;
  const files = readdirSync(ANALYTICS).filter((f) => /^ga4-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  if (!files.length) return null;
  try {
    const j = JSON.parse(readFileSync(join(ANALYTICS, files[files.length - 1]), "utf8"));
    const rows = j.rows ?? j.report ?? [];
    const active = rows.find?.((r) => /activeUsers/i.test(JSON.stringify(r)));
    const value = j.activeUsers28d ?? j.activeUsers30d ?? j.activeUsers ?? active?.activeUsers ?? null;
    return typeof value === "number" ? value : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ experiments */

function experimentTally() {
  if (!existsSync(EXPERIMENTS)) return null;
  const rows = readdirSync(EXPERIMENTS).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(join(EXPERIMENTS, f), "utf8")));
  if (!rows.length) return null;
  const t = { due: 0, 成功: 0, 及格: 0, 失败: 0, 未到期: 0 };
  for (const r of rows) {
    if (!r.verdict || r.measuredAt === undefined) {
      if (r.measureOn && today >= r.measureOn) t.due++;
      else t.未到期++;
    } else {
      t.due++;
      t[r.verdict] = (t[r.verdict] ?? 0) + 1;
    }
  }
  return t;
}

/* ------------------------------------------------------------------ self check */

function selfCheck(gsc, exp) {
  const problems = [];

  /* ① a cell whose verdict has not moved in over a week */
  const matrixFiles = existsSync(join(ROOT, "data", "demand"))
    ? readdirSync(join(ROOT, "data", "demand")).filter((f) => /^matrix-cells-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort()
    : [];
  if (matrixFiles.length >= 2) {
    const now = JSON.parse(readFileSync(join(ROOT, "data", "demand", matrixFiles[matrixFiles.length - 1]), "utf8"));
    const prev = JSON.parse(readFileSync(join(ROOT, "data", "demand", matrixFiles[matrixFiles.length - 2]), "utf8"));
    const changed = (now.cells ?? []).filter((c) => {
      const p = (prev.cells ?? []).find((x) => x.persona === c.persona && x.moment === c.moment);
      return p && p.verdict !== c.verdict;
    }).length;
    if (changed === 0) problems.push(`① 25 格 verdict 一周零变化（${prev.date} → ${now.date}）`);
  }

  /* ② an experiment past its date with no measurement */
  if (exp) {
    const overdue = (existsSync(EXPERIMENTS) ? readdirSync(EXPERIMENTS).filter((f) => f.endsWith(".json")) : [])
      .map((f) => JSON.parse(readFileSync(join(EXPERIMENTS, f), "utf8")))
      .filter((r) => r.measureOn && today > r.measureOn && r.measuredAt === undefined);
    if (overdue.length) problems.push(`② ${overdue.length} 份实验到期未回测`);
  }

  /* ③ a page with no impressions in the whole window - only meaningful when GSC answered */
  if (gsc) {
    try {
      const out = execFileSync(process.execPath, [join(ROOT, "tools", "gsc-report.mjs"), "--json"], { cwd: ROOT, encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "ignore"] });
      const pages = JSON.parse(out.slice(out.indexOf("{"))).pages ?? [];
      if (pages.length && pages.every((p) => (p.impressions ?? 0) === 0)) problems.push("③ 90 天内全站零曝光");
    } catch {}
  }

  /* ④ duplicate titles */
  try {
    execFileSync(process.execPath, [join(ROOT, "tools", "check-meta.mjs")], { cwd: ROOT, encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    problems.push("④ 标题或描述重复（check-meta 未通过）");
  }

  return problems;
}

/* ------------------------------------------------------------------ card */

function pct(v) {
  return v === null ? MISSING : (v * 100).toFixed(2) + "%";
}
function num(v) {
  return v === null || v === undefined ? MISSING : String(v);
}

mkdirSync(REPORTS, { recursive: true });
const previousFiles = readdirSync(REPORTS).filter((f) => /^weekly-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
const previous = previousFiles.length ? JSON.parse(readFileSync(join(REPORTS, previousFiles[previousFiles.length - 1]), "utf8")) : null;

const gsc = gscTotals();
const ga4 = ga4Active30();
const exp = experimentTally();

const delta = gsc && previous?.gsc ? gsc.impressions - previous.gsc.impressions : null;

const lines = [
  `📊 Landed Math — 周报 ${today}`,
  "",
  `曝光（90d）    本周 ${num(gsc?.impressions)} ｜ 上周 ${num(previous?.gsc?.impressions)} ｜ 变化 ${delta === null ? MISSING : (delta >= 0 ? "+" : "") + delta}`,
  `点击（90d）    本周 ${num(gsc?.clicks)} ｜ 上周 ${num(previous?.gsc?.clicks)}`,
  `CTR            本周 ${pct(gsc?.ctr ?? null)} ｜ 上周 ${pct(previous?.gsc?.ctr ?? null)}`,
  `活跃用户（30d） 本周 ${num(ga4)} ｜ 上周 ${num(previous?.ga4)}`,
  `实验           到期 ${num(exp?.due)} ｜ 成功 ${num(exp?.成功)} ｜ 及格 ${num(exp?.及格)} ｜ 失败 ${num(exp?.失败)} ｜ 未到期 ${num(exp?.未到期)}`,
];

const problems = selfCheck(gsc, exp);
if (problems.length) {
  lines.push("", "自检异常：", ...problems.map((p) => "  " + p));
}

const card = lines.join("\n");
console.log(card);

writeFileSync(join(REPORTS, `weekly-${today}.json`), JSON.stringify({ at: new Date().toISOString(), gsc, ga4, experiments: exp, problems, card }, null, 2) + "\n", "utf8");

if (process.argv.includes("--send")) {
  const hook = process.env.FEISHU_WEBHOOK;
  if (!hook) {
    console.log("\nFEISHU_WEBHOOK is not set, so no card is sent.");
    process.exit(0);
  }
  const res = execFileSync("curl", ["-sS", "-X", "POST", hook, "-H", "content-type: application/json", "-d", JSON.stringify({ msg_type: "text", content: { text: card } })], { encoding: "utf8" });
  console.log("\nfeishu: " + res);
}
