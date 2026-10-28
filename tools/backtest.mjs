#!/usr/bin/env node
/**
 * The 28-day backtest: did the page that was built for a cell find any searchers?
 *
 *   node tools/backtest.mjs              # measure every experiment whose measureOn has passed
 *   node tools/backtest.mjs --dry-run    # validate and report, no network
 *   node tools/backtest.mjs --page=/guide/china-student-monthly-cost/   # measure any page, on demand
 *
 * ## What this is for
 *
 * The site builds pages on the theory that a cell with phrasings also has searchers. That theory is
 * worth nothing until a page has been live for long enough to be shown. This tool closes the loop: it
 * reads the criteria that were written down *before* the page was published, measures the page against
 * them, and writes the result next to the criteria so nobody can renegotiate afterwards.
 *
 * ## The two rules that are easy to get wrong
 *
 * **A verdict is not due until measureOn.** Measuring early and calling it a failure is how a page gets
 * killed in week one, before Google has decided what it is. If today is before measureOn, the experiment
 * is `未到期` and nothing else is said about it.
 *
 * **A failure carries a language qualifier, always.** Every seed in the twenty-five cells was English.
 * So a page with no impressions among English-language searchers says that, and only that. It does not
 * say there is no demand - it says nobody asked in English. Chinese students, expatriates who search in
 * their own language, and buyers in countries where English is not the search language are all outside
 * this sample. Deleting a cell on the strength of an English-only measurement is the same mistake as
 * reading zero hits as "nothing exists".
 *
 * ## Three groups of numbers, never one score
 *
 *   credibility   how many figures the page carries and how many have a source and a retrieval date
 *   reader value  impressions, clicks, CTR, position
 *   growth        shown at all, inside the top 20, matched by any query
 *
 * They are printed side by side and are allowed to disagree. A page can be perfectly sourced and get no
 * traffic; that is a finding, not a number to average away. There is no composite score by design.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { gscCredentials, gscAccessToken, gscSearchAnalytics, isoDaysAgo, loadEnv, today } from "./lib/gsc.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const EXPERIMENTS = join(ROOT, "data", "experiments");
const BLOG = join(ROOT, "src", "content", "blog");
const GUIDE = join(ROOT, "src", "content", "guide");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const pageArg = args.find((a) => a.startsWith("--page="))?.slice(7);

const REQUIRED = ["id", "cell", "page", "publishedAt", "measureOn", "judgedBy"];

/** Thresholds are the director's, fixed on 2026-10-27. Not tuned, not revisited after results. */
const THRESHOLDS = { success: 50, pass: 10 };

const WINDOW_DAYS = 90;
const LANGUAGE_BIAS = "english-seeded";
const LANGUAGE_NOTE =
  "All twenty-five cells were harvested with English seeds, so this measurement covers people who search in English. " +
  "A failure here means no English-language searchers found the page; it does not mean there is no demand.";

/* ------------------------------------------------------------------ validation */

function validateExperiment(exp, file) {
  const missing = REQUIRED.filter((k) => exp[k] === undefined || exp[k] === null || exp[k] === "");
  if (missing.length) throw new Error(`${file}: missing required field(s): ${missing.join(", ")} - refusing to guess`);
  if (!exp.cell || !exp.cell.persona || !exp.cell.moment || !exp.cell.direction) {
    throw new Error(`${file}: cell must carry persona, moment and direction`);
  }
  for (const k of ["publishedAt", "measureOn"]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(exp[k])) throw new Error(`${file}: ${k} must be YYYY-MM-DD, got ${exp[k]}`);
  }
  if (exp.measureOn <= exp.publishedAt) throw new Error(`${file}: measureOn must be after publishedAt`);
  return exp;
}

/* ------------------------------------------------------------------ source side */

/** Every published .md keyed by its URL path, for the completeness group. */
function pageSources() {
  const out = new Map();
  for (const [dir, prefix] of [["blog", "/blog/"], ["guide", "/guide/"]]) {
    const root = join(ROOT, "src", "content", dir);
    if (!existsSync(root)) continue;
    for (const f of readdirSync(root).filter((x) => x.endsWith(".md"))) {
      const raw = readFileSync(join(root, f), "utf8");
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] ?? "";
      const figures = [...fm.matchAll(/^  - value:/gm)].length;
      const withSource = [...fm.matchAll(/^    source:\s*"?[^"\n]+/gm)].length;
      const withRetrieved = [...fm.matchAll(/^    retrieved:/gm)].length;
      out.set(`${prefix}${f.replace(/\.md$/, "")}/`, { file: f, figures, withSource, withRetrieved });
    }
  }
  return out;
}

function credibilityOf(page, sources) {
  const s = sources.get(page);
  if (!s) return { available: false, note: "page not found in src/content" };
  const sourcedRatio = s.figures ? Number((s.withSource / s.figures).toFixed(3)) : null;
  return {
    figures: s.figures,
    withSource: s.withSource,
    withRetrieved: s.withRetrieved,
    sourcedRatio,
    complete: s.figures > 0 && s.withSource === s.figures && s.withRetrieved === s.figures,
  };
}

/* ------------------------------------------------------------------ search side */

function credentials() {
  const env = { ...loadEnv(join(ROOT, ".env.keywords")) };
  for (const k of ["GSC_CREDENTIALS", "GSC_SITE_URL"]) {
    if (process.env[k]) env[k] = process.env[k];
  }
  if (!env.GSC_CREDENTIALS && process.env.GSC_CREDENTIALS_BASE64) {
    env.GSC_CREDENTIALS = process.env.GSC_CREDENTIALS_BASE64;
  }
  return env;
}

/**
 * @returns {{available: true, impressions, clicks, ctr, position, queries, inTop20, matchedAnyQuery}
 *          | {available: false, note: string}}
 */
function measureInSearch(page, env) {
  if (!env.GSC_CREDENTIALS || !env.GSC_SITE_URL) {
    return { available: false, note: "GSC is not configured in this environment; it runs in CI where the secrets exist" };
  }
  const site = env.GSC_SITE_URL.replace(/\/$/, "");
  const absolute = site.startsWith("sc-domain:")
    ? "https://www." + site.replace("sc-domain:", "") + page
    : site + page;
  const startDate = isoDaysAgo(WINDOW_DAYS);
  const endDate = isoDaysAgo(2); // Search Console lags; the last two days are usually zeros, not data.

  const pagePayload = {
    startDate,
    endDate,
    dimensions: ["page"],
    dimensionFilterGroups: [{ filters: [{ dimension: "page", operator: "equals", expression: absolute }] }],
    rowLimit: 1,
  };
  const pageRows = gscSearchAnalytics(env, pagePayload, {})?.rows ?? [];
  const row = pageRows[0];
  const impressions = row?.impressions ?? 0;
  const clicks = row?.clicks ?? 0;

  const queryPayload = { ...pagePayload, dimensions: ["query"], rowLimit: 25 };
  const queryRows = gscSearchAnalytics(env, queryPayload, {})?.rows ?? [];
  const queries = queryRows.map((r) => ({ query: r.keys[0], impressions: r.impressions, clicks: r.clicks, position: Number(r.position.toFixed(1)) }));

  return {
    available: true,
    window: `${startDate}..${endDate}`,
    impressions,
    clicks,
    ctr: impressions ? Number((clicks / impressions).toFixed(4)) : 0,
    position: row ? Number(row.position.toFixed(1)) : null,
    queries,
    inTop20: row ? row.position <= 20 : false,
    matchedAnyQuery: queries.length > 0,
  };
}

/* ------------------------------------------------------------------ verdict */

function verdictOf(impressions) {
  if (impressions >= THRESHOLDS.success) return "成功";
  if (impressions >= THRESHOLDS.pass) return "及格";
  return "失败";
}

function readingOf(verdict, measured) {
  if (verdict === "成功") {
    return `English-language searchers found this page: ${measured.impressions} impressions and ${measured.clicks} clicks in ninety days.`;
  }
  if (verdict === "及格") {
    return `The page is being shown but rarely clicked: ${measured.impressions} impressions in ninety days. The question is the title and the snippet, not the demand.`;
  }
  return (
    "No demand among English-language searchers in this ninety-day window: " +
    `${measured.impressions} impressions. ` +
    "This is a statement about English-language search only. Readers who search in Chinese, or in their own language, " +
    "are outside the sample and would not appear here even if they exist."
  );
}

/* ------------------------------------------------------------------ main */

function loadExperiments() {
  if (!existsSync(EXPERIMENTS)) return [];
  return readdirSync(EXPERIMENTS)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => ({ file: join(EXPERIMENTS, f), name: f, data: JSON.parse(readFileSync(join(EXPERIMENTS, f), "utf8")) }));
}

function writeGroups(exp, credibility, search) {
  /* Appended, never replacing what was registered before the result. */
  exp.languageBias = LANGUAGE_BIAS;
  exp.languageNote = LANGUAGE_NOTE;
  exp.credibility = credibility;
  exp.readerValue = search.available
    ? { impressions: search.impressions, clicks: search.clicks, ctr: search.ctr, position: search.position, window: search.window, queries: search.queries.length }
    : { available: false, note: search.note };
  exp.growth = search.available
    ? { shownAtAll: search.impressions > 0, inTop20: search.inTop20, matchedAnyQuery: search.matchedAnyQuery, topQueries: search.queries.slice(0, 5).map((q) => q.query) }
    : { available: false, note: search.note };
  return exp;
}

const experiments = loadExperiments();
const sources = pageSources();
const now = today();

if (!experiments.length && !pageArg) {
  console.log("  no experiments registered - nothing to measure");
  process.exit(0);
}

/* On-demand measurement of one page: used to check the instrument before anything is due. */
if (pageArg) {
  const env = credentials();
  const credibility = credibilityOf(pageArg, sources);
  const search = dryRun
    ? { available: false, note: "dry run: search metrics not requested" }
    : measureInSearch(pageArg, env);
  console.log(`PAGE ${pageArg}`);
  console.log("  credibility : " + JSON.stringify(credibility));
  console.log("  readerValue : " + JSON.stringify(search.available ? { impressions: search.impressions, clicks: search.clicks, ctr: search.ctr, position: search.position } : search));
  console.log("  growth      : " + JSON.stringify(search.available ? { shownAtAll: search.impressions > 0, inTop20: search.inTop20, matchedAnyQuery: search.matchedAnyQuery } : search));
  process.exit(0);
}

const due = [];
const notDue = [];

for (const { file, name, data } of experiments) {
  let exp;
  try {
    exp = validateExperiment(data, name);
  } catch (e) {
    console.error("  ERROR " + e.message);
    process.exit(2);
  }
  if (now < exp.measureOn) {
    notDue.push({ name, exp });
    continue;
  }
  due.push({ file, name, exp });
}

if (!due.length) {
  console.log(`  到期 0 份 / 成功 0 / 及格 0 / 失败 0 / 未到期 ${notDue.length}`);
  for (const { name, exp } of notDue) console.log(`    未到期  ${exp.id}  measureOn ${exp.measureOn}  (${exp.page})`);
  process.exit(0);
}

const env = dryRun ? {} : credentials();
const tally = { 成功: 0, 及格: 0, 失败: 0 };
const lines = [];

for (const { file, name, exp } of due) {
  const credibility = credibilityOf(exp.page, sources);
  const search = dryRun ? { available: false, note: "dry run" } : measureInSearch(exp.page, env);

  if (!search.available) {
    console.log(`  SKIP ${exp.id}: ${search.note}`);
    notDue.push({ name, exp });
    continue;
  }

  const verdict = verdictOf(search.impressions);
  tally[verdict]++;
  const updated = writeGroups({ ...exp }, credibility, search);
  updated.measuredAt = now;
  updated.measured = {
    impressions: search.impressions,
    clicks: search.clicks,
    ctr: search.ctr,
    position: search.position,
    window: search.window,
    queries: search.queries,
  };
  updated.verdict = verdict;
  updated.reading = readingOf(verdict, search);
  updated.thresholds = THRESHOLDS;

  writeFileSync(file, JSON.stringify(updated, null, 2) + "\n", "utf8");

  lines.push(
    `${verdict}  ${exp.id}  imp ${search.impressions}  clicks ${search.clicks}  pos ${search.position ?? "-"}  ` +
      `figures ${credibility.figures ?? "?"}/${credibility.figures ?? "?"} sourced`,
  );
}

console.log("BACKTEST " + now);
for (const l of lines) console.log("  " + l);
console.log(`  到期 ${due.length} 份 / 成功 ${tally.成功} / 及格 ${tally.及格} / 失败 ${tally.失败} / 未到期 ${notDue.length}`);
if (tally.失败) {
  console.log("  NOTE: 失败 means no English-language searchers found the page. It is not a statement that demand does not exist.");
}
