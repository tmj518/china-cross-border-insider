#!/usr/bin/env node
/**
 * Turn harvested search suggestions into queue candidates, and say how many survived.
 *
 *   node tools/demand-to-queue.mjs            # report only
 *   node tools/demand-to-queue.mjs --write    # write data/demand/queue-candidates.json
 *
 * ## The problem
 *
 * `data/demand/suggest-2026-10-27.json` holds 379 real phrases people typed into Google and Bing, of
 * which 235 are not answered by anything on the site. That number is not a topic list. Most of it is
 * unusable: brand names, other countries' rules we do not cover, questions no guide can answer, and
 * phrases that collide with something already written.
 *
 * So this tool does not "add 235 topics". It applies the filters that decide whether a phrase can
 * become a guide at all, and prints what survived. The number that matters is the survival rate: a
 * handful means the demand signal is not the bottleneck after all, and a few dozen means the guide
 * line has a runway it did not have this morning.
 *
 * ## The filters, and why each one exists
 *
 *   not covered        the phrase is already answered; writing again splits the signal
 *   intent             the searcher wants a procedure or a number, not news or an opinion
 *   class              it maps to one of the guide collection's topic values, or the schema rejects it
 *   no collision       it does not overlap an existing queue topic or published piece
 *   not another country  "china import duty in india" is a real query about a rule we do not document
 *
 * The last one is a judgement call and it is deliberately conservative: the site documents what China
 * charges, not what India charges on Chinese goods. Those queries are real demand and they are out of
 * scope, so they are counted separately rather than silently dropped.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DEMAND = join(ROOT, "data", "demand");
const QUEUE = join(ROOT, "data", "guide-queue.json");
const OUT = join(ROOT, "data", "demand", "queue-candidates.json");
const write = process.argv.includes("--write");

/* ── the newest harvest ─────────────────────────────────────────────────────────────────────── */

const harvests = (existsSync(DEMAND) ? readdirSync(DEMAND) : [])
  .filter((f) => f.startsWith("suggest-") && f.endsWith(".json"))
  .sort();
if (!harvests.length) {
  console.log("no harvest in data/demand - run the autocomplete collection first");
  process.exit(2);
}
const harvest = JSON.parse(readFileSync(join(DEMAND, harvests[harvests.length - 1]), "utf8"));
const rows = harvest.rows ?? [];

/* ── vocabulary ─────────────────────────────────────────────────────────────────────────────── */

/** A phrase has to be asking for a procedure or a number. Everything else is news, opinion or a brand. */
const INTENT =
  /\b(how|what|can|do i|does|requirements?|documents?|steps?|cost|costs|fee|fees|rate|rates|calculator|calculate|apply|application|renew|renewal|need|qualify|eligible|deadline|process|procedure|rules?)\b/i;

/** Which guide topic a phrase belongs to. Order matters: the first match wins. */
const CLASSES = [
  ["tax", /\b(tax|vat|rebate|refund|income tax|withholding)\b/i],
  ["work-visa", /\b(work permit|z visa|employment pass|work visa|labour permit)\b/i],
  ["residence", /\b(residence permit|visa|permanent residence|green card|overstay|entry|exit|mm2h)\b/i],
  ["social-insurance", /\b(social insurance|pension|medical insurance|health insurance)\b/i],
  ["driving", /\b(driving licen[cs]e|driver|vehicle registration)\b/i],
  ["relocation", /\b(moving|relocat|household|shipping personal|bring my)\b/i],
  ["employment", /\b(hire|hiring|employ|salary|payroll|expat package)\b/i],
  ["logistics", /\b(ship|freight|container|customs clearance|cargo)\b/i],
  ["transit", /\b(transit|layover|visa-free|144)\b/i],
];

/**
 * Named programmes that belong to another country.
 *
 * "mm2h visa requirements" survived every filter - it has visa intent, it maps to the residence class,
 * and nothing on the site collides with it. It is also Malaysia's programme, not China's. A country-name
 * test cannot catch it because the query never names a country; only the programme does.
 */
const FOREIGN_PROGRAMME = /\b(mm2h|s-pass|employment pass|de ranto|b1\/b2|esta|schengen|eb-5|o-1|h-1b)\b/i;

/** Queries about what some other country charges. Real demand, out of scope. */
const OTHER_COUNTRY =
  /\b(in|to|from)\s+(india|pakistan|bangladesh|sri lanka|nigeria|kenya|brazil|mexico|vietnam|indonesia|thailand|philippines|malaysia|singapore|japan|korea|australia|canada)\b/i;

const stop = new Set(["china", "chinese", "the", "for", "and", "from", "with", "2026", "2027", "2028", "import", "export", "cost", "costs", "rate", "rates"]);
const tokens = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length >= 4 && !stop.has(w));

/* ── what already exists ───────────────────────────────────────────────────────────────────── */

const queue = existsSync(QUEUE) ? JSON.parse(readFileSync(QUEUE, "utf8")) : { topics: [] };
const existing = [];
for (const t of queue.topics ?? []) existing.push({ id: `queue/${t.slug}`, text: `${t.title} ${t.query} ${t.slug}` });
for (const dir of ["blog", "guide"]) {
  const root = join(ROOT, "src", "content", dir);
  if (!existsSync(root)) continue;
  for (const f of readdirSync(root).filter((x) => x.endsWith(".md"))) {
    const raw = readFileSync(join(root, f), "utf8");
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] ?? "";
    if (/^draft:\s*true/m.test(fm)) continue;
    const kw = /^target_keyword:\s*"(.*?)"\s*$/m.exec(fm)?.[1] ?? "";
    const title = /^title:\s*"(.*?)"\s*$/m.exec(fm)?.[1] ?? "";
    existing.push({ id: `${dir}/${f.replace(/\.md$/, "")}`, text: `${title} ${kw} ${f}` });
  }
}
const existingTokens = existing.map((e) => ({ id: e.id, set: new Set(tokens(e.text)) }));

function collides(query) {
  const t = tokens(query);
  if (!t.length) return null;
  for (const e of existingTokens) {
    const hit = t.filter((w) => e.set.has(w)).length;
    if (hit >= Math.ceil(t.length * 0.7)) return e.id;
  }
  return null;
}

/* ── filter and rank ───────────────────────────────────────────────────────────────────────── */

const stats = { total: rows.length, covered: 0, otherCountry: 0, noIntent: 0, noClass: 0, collision: 0, survived: 0 };
const candidates = [];

for (const r of rows) {
  if (r.coveredBy) { stats.covered++; continue; }
  if (OTHER_COUNTRY.test(r.query) || FOREIGN_PROGRAMME.test(r.query)) { stats.otherCountry++; continue; }
  if (!INTENT.test(r.query)) { stats.noIntent++; continue; }
  const cls = CLASSES.find(([, re]) => re.test(r.query));
  if (!cls) { stats.noClass++; continue; }
  const hit = collides(r.query);
  if (hit) { stats.collision++; continue; }
  stats.survived++;
  candidates.push({
    query: r.query,
    topic: cls[0],
    /* breadth: how many of our seeds returned this phrase. A weak proxy for how often it is asked. */
    breadth: (r.seeds ?? []).length,
    engines: r.engines ?? [],
    suggestedSlug: r.query.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60),
    blockedBy: hit,
  });
}

candidates.sort((a, b) => b.breadth - a.breadth || a.query.localeCompare(b.query));

/* ── output ─────────────────────────────────────────────────────────────────────────────────── */

console.log("DEMAND → QUEUE CANDIDATES");
console.log("=".repeat(74));
console.log(`  harvested            ${stats.total}`);
console.log(`  already answered     ${stats.covered}`);
console.log(`  other country's rule ${stats.otherCountry}   (out of scope: the site documents what China charges)`);
console.log(`  no procedural intent ${stats.noIntent}`);
console.log(`  no topic class       ${stats.noClass}`);
console.log(`  collides with ours   ${stats.collision}`);
console.log(`  SURVIVED             ${stats.survived}   (${((stats.survived / stats.total) * 100).toFixed(1)}%)`);

const byClass = {};
for (const c of candidates) byClass[c.topic] = (byClass[c.topic] ?? 0) + 1;
console.log("\n  by class:", Object.entries(byClass).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(" / "));

console.log("\n  top 20:");
for (const c of candidates.slice(0, 20)) console.log(`   ${String(c.breadth).padStart(2)}×  ${c.topic.padEnd(16)} ${c.query}`);

if (write) {
  writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), source: harvests[harvests.length - 1], stats, candidates }, null, 2) + "\n", "utf8");
  console.log(`\n  written: data/demand/queue-candidates.json (${candidates.length})`);
} else {
  console.log("\n  report only - add --write to save");
}
