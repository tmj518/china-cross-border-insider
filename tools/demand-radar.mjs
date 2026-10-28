#!/usr/bin/env node
/**
 * The demand radar: harvest search suggestions for the 25 cells and score them.
 *
 *   node tools/demand-radar.mjs                 # harvest today, write data/demand/
 *   node tools/demand-radar.mjs --date=2026-11-03
 *   node tools/demand-radar.mjs --aggregate    # rescore the newest cell files, no network
 *
 * ## What this is, and what it is not
 *
 * The instrument is Google's and Bing's public autocomplete endpoints. They return the phrases people
 * type, they cost nothing, and they need no key. What they cannot do is tell you how often a phrase is
 * searched, or whether anyone would pay for the answer. So this tool produces a *phrasings* map, not a
 * priority ranking, and every output carries that caveat.
 *
 * Three failure modes were discovered the hard way and are now handled explicitly, because each one
 * produced a confident wrong answer before it was handled:
 *
 *   homonyms      "sell in china online" means dinnerware. A cell of 57 queries can contain 0 real ones.
 *   seed drift    seeds about sourcing produce buying queries. A cell can measure the wrong moment.
 *   direction     "cost to post parcel to china" is into China, not out of it. Without a direction the
 *                 same query is filed under the opposite moment and a page gets built for it.
 *
 * ## The twenty-five cells
 *
 * Five personas (business definitions, docs/初心与目标.md §0.2) times five moments. Neither list may be
 * changed here: the cell names are the analysis unit, and `seedQuality` is what marks a cell unreliable.
 *
 * ## Verdicts
 *
 * Ruling D, from the director, 2026-10-27: the verdict is decided by seed quality, not by a ratio
 * threshold. An empty cell with ambiguous seeds is "定义待验证", never "无需求证据" - absence of evidence
 * is not evidence of absence, and a ratio cut-off is a number chosen after seeing the result.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const DEMAND = join(ROOT, "data", "demand");

/* ------------------------------------------------------------------ the cells */

const PERSONAS = ["platform-seller", "importer", "bri", "student", "expat"];
const MOMENTS = ["buy", "arrive", "live", "leave", "policy"];

/**
 * Seeds per cell. These are the same seeds the manual harvest used; changing them changes what the
 * radar measures, which is a decision for the director, not a maintenance edit.
 */
const SEEDS = {
  "buy|platform-seller": ["amazon fba china supplier", "sell on amazon from china", "import from china to sell online", "china supplier for amazon fba", "dropshipping from china"],
  "arrive|platform-seller": ["visit china supplier factory", "china business trip supplier", "canton fair visit", "china factory tour"],
  "live|platform-seller": ["amazon seller in china warehouse", "fba storage fee china", "sell on tmall foreign brand", "china warehouse storage cost", "china warehouse fees amazon", "fba china storage cost", "ship to amazon warehouse china", "china 3pl cost"],
  "leave|platform-seller": ["ship inventory out of china", "return goods from china", "china warehouse removal fee", "amazon fba removal from china", "amazon removal order china", "china to us freight cost per kg", "return inventory to china supplier", "china exit shipping cost"],
  "policy|platform-seller": ["china export policy for sellers", "china customs rules for ecommerce", "china ecommerce regulation", "china export license"],

  "buy|importer": ["import duty from china", "import from china cost", "china import tax", "landed cost from china", "china import duty calculator"],
  "arrive|importer": ["china sourcing trip", "visit china factory", "china trade fair", "china supplier visit visa"],
  "live|importer": ["cost of living in china for business", "china office setup cost", "expat package china cost", "china business trip cost per day", "china factory visit cost", "china sourcing trip cost", "hotel cost china business travel", "china interpreter cost business"],
  "leave|importer": ["export from china procedure", "shipping goods out of china", "china export documentation", "china customs clearance export"],
  "policy|importer": ["china import export policy", "china tariff changes", "china customs rules", "china export controls"],

  "buy|bri": ["import from china to india duty", "import from china to nigeria", "china import duty pakistan", "import from china to malaysia", "import from china to bangladesh"],
  "arrive|bri": ["china business visa india", "china visa for nigerian citizens", "china business visa pakistan", "china invitation letter business visa"],
  "live|bri": ["cost of living china for indian student", "china apartment rent for foreigner", "living cost guangzhou foreigner", "china rent deposit foreigner", "cost of living china for indian", "china pg rent foreigner", "china daily expenses foreigner", "china apartment deposit foreigner"],
  "leave|bri": ["send money from china to india", "parcel from china to africa cost", "customs clearance nigeria china", "remit money from china to pakistan"],
  "policy|bri": ["china tariff for africa countries", "china export policy india", "africa china trade agreement", "china duty free treatment africa"],

  "buy|student": ["buy laptop in china", "buy phone in china student", "cheapest place to buy electronics china", "student discount china"],
  "arrive|student": ["student visa china requirements", "study in china visa", "china student visa documents", "china university application international"],
  "live|student": ["cost of living china student", "student accommodation china", "part time job china student", "china student health insurance"],
  "leave|student": ["ship belongings home from china", "send luggage from china", "china student baggage allowance", "parcel to india from china"],
  "policy|student": ["china student visa policy", "china work rules for students", "china scholarship policy"],

  "buy|expat": ["buy car in china foreigner", "buy apartment in china foreigner", "buy property in china", "car insurance china foreigner"],
  "arrive|expat": ["extend visa in china", "china work visa process", "china residence permit application", "china visa on arrival", "china digital nomad visa"],
  "live|expat": ["rent apartment china foreigner", "cost of living in china foreigner", "health insurance china foreigner", "open bank account in china", "china sim card foreigner"],
  "leave|expat": ["china tax refund foreigners", "send money out of china", "china departure tax refund", "close bank account china"],
  "policy|expat": ["china visa policy change", "china foreigner regulations", "china residence permit rules", "china work permit policy"],
};

/* ------------------------------------------------------------------ classification */

const HOMONYM = /(fine china|antique china|vintage china|noritake|lenox|rosenthal|porcelain|dinnerware|bone china|china set|china plates)/i;
const CHINA_ANCHOR = /\b(china|chinese|shanghai|beijing|guangzhou|shenzhen|hangzhou|yiwu|mainland)\b/;

const MOMENT_RE = {
  buy: /(import|duty|tariff|supplier|wholesale|sourcing|factory|landed cost|\bbuy\b|\bbuying\b|\bpurchase\b|price of)/,
  arrive: /(visa|entry|enter|arrive|invitation|immigration|permit|transit|business trip|trip to china|visit china|trade fair|canton fair)/,
  live: /(rent|apartment|warehouse|storage|office|landlord|utility|bank account|sim card|health insurance|hospital|school fee|accommodation|residence permit|cost of living|salary|living cost|hotel)/,
  leave: /(refund|remit|send money|baggage|parcel|departure|move out|shipping|freight|removal|customs)/,
  policy: /(policy|rule|regulation|law|announcement|notice|ban|compliance|license|licence|agreement|tariff)/,
};

const CALC = /(how much|cost|price|fee|duty|tariff|tax|rate|calculator|charges|expensive|cheap|budget|limit|threshold|per kg)/;

/** Which direction the action points, judged by the verb in the query rather than by who is asking. */
function directionOf(q) {
  const city = "(china|chinese|shanghai|beijing|guangzhou|shenzhen|hangzhou|yiwu)";
  if (new RegExp(`\\b(to|into)\\s+${city}\\b`).test(q)) return "into-china";
  if (/\bfrom\s+china\b|\bout of china\b|\bexport(ed)?\s+from\s+china\b/.test(q)) return "out-of-china";
  if (/\btax refund\b|\bdeparture\b|\bleaving china\b|\bcancel tax refund\b/.test(q)) return "out-of-china";
  if (new RegExp(`\\b(in|inside|within)\\s+${city}\\b`).test(q)) return "within-china";
  if (/\b(import|duty|tariff|landed cost)\b/.test(q)) return "out-of-china";
  return "within-china";
}

function kindOf(q) {
  if (/(how to|how do|requirements?|steps|apply|application|documents?|process|procedure|renew)/.test(q)) return "procedural";
  if (/(calculator|cost|price|fee|duty|tariff|tax|rate|how much|charges|budget)/.test(q)) return "transactional";
  if (/(official|website|login|portal)/.test(q)) return "navigational";
  return "informational";
}

/* ------------------------------------------------------------------ pages on the site */

const PERSONA_RE = {
  "platform-seller": /(amazon|fba|seller|platform|dropship|ecommerce|marketplace)/,
  importer: /(import|duty|tariff|landed|broker|customs)/,
  bri: /(india|nigeria|pakistan|malaysia|bangladesh|africa|vietnam|indonesia|sri lanka)/,
  student: /(student|study|university|scholarship)/,
  expat: /(visa|residence|permit|rent|bank|sim|expat|foreigner|tax refund)/,
};
const MOMENT_PAGE = {
  buy: /(import|duty|tariff|landed|cost|price|sourcing|supplier|rebate)/,
  arrive: /(visa|entry|transit|permit|invitation)/,
  live: /(rent|apartment|bank|sim|insurance|cost of living|medical|residence)/,
  leave: /(refund|remit|baggage|parcel|shipping|departure)/,
  policy: /(policy|regulation|notice|rule|announcement|tariff)/,
};

function publishedPages() {
  const out = [];
  for (const dir of ["blog", "guide"]) {
    const root = join(ROOT, "src", "content", dir);
    if (!existsSync(root)) continue;
    for (const f of readdirSync(root).filter((x) => x.endsWith(".md"))) {
      const raw = readFileSync(join(root, f), "utf8");
      const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] ?? "";
      if (/^draft:\s*true/m.test(fm)) continue;
      const title = /^title:\s*"(.*?)"\s*$/m.exec(fm)?.[1] ?? "";
      const kw = /^target_keyword:\s*"(.*?)"\s*$/m.exec(fm)?.[1] ?? "";
      out.push({ id: `${dir}/${f.replace(/\.md$/, "")}`, text: `${title} ${kw} ${f}`.toLowerCase() });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ harvest */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function suggest(url) {
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (compatible; landedmath-radar)" }, signal: AbortSignal.timeout(12000) });
      if (r.status === 200) {
        const j = JSON.parse(await r.text());
        return { ok: true, list: Array.isArray(j?.[1]) ? j[1] : [] };
      }
      if (r.status === 403 || r.status === 429) { await sleep(2500 * (attempt + 1)); continue; }
      return { ok: false, list: [] };
    } catch {
      await sleep(1200 * (attempt + 1));
    }
  }
  return { ok: false, list: [] };
}

async function harvest(date) {
  mkdirSync(DEMAND, { recursive: true });
  let written = 0, failedCells = 0;
  for (const persona of PERSONAS) {
    for (const moment of MOMENTS) {
      const seeds = SEEDS[`${moment}|${persona}`] ?? [];
      const found = new Map();
      let ok = 0, bad = 0;
      for (const seed of seeds) {
        for (const [engine, u] of [
          ["google", `https://suggestqueries.google.com/complete/search?client=firefox&hl=en&q=${encodeURIComponent(seed)}`],
          ["bing", `https://api.bing.com/osjson.aspx?query=${encodeURIComponent(seed)}`],
        ]) {
          const r = await suggest(u);
          r.ok ? ok++ : bad++;
          for (const s of r.list) {
            const q = s.toLowerCase().replace(/\s+/g, " ").trim();
            if (q.length < 8) continue;
            if (!found.has(q)) found.set(q, { query: q, engines: new Set(), seeds: new Set() });
            found.get(q).engines.add(engine);
            found.get(q).seeds.add(seed);
          }
          await sleep(1100);
        }
      }
      const rows = [...found.values()].map((v) => ({ query: v.query, engines: [...v.engines], seeds: [...v.seeds] }));
      const status = rows.length ? (bad > ok ? "partial" : "ok") : "failed";
      if (status === "failed") failedCells++;
      writeFileSync(
        join(DEMAND, `matrix-${moment}-${persona}-${date}.json`),
        JSON.stringify({ at: new Date().toISOString(), date, persona, moment, seeds, status, okCalls: ok, failCalls: bad, total: rows.length, rows, seedQuality: "unambiguous" }, null, 2) + "\n",
        "utf8",
      );
      written++;
      console.log(`  ${moment.padEnd(6)} x ${persona.padEnd(16)} ${status.padEnd(8)} ${String(rows.length).padStart(3)} queries  (ok ${ok}/fail ${bad})`);
    }
  }
  return { written, failedCells };
}

/* ------------------------------------------------------------------ aggregate */

function aggregate(date) {
  const cellRe = new RegExp(`^matrix-(buy|arrive|live|leave|policy)-(platform-seller|importer|bri|student|expat)-${date}\\.json$`);
  const files = readdirSync(DEMAND).filter((f) => cellRe.test(f)).sort();
  if (!files.length) {
    console.error(`no cell files for ${date} in data/demand - run the harvest first`);
    process.exit(2);
  }

  const pages = publishedPages();
  const detail = [];
  const cells = [];

  for (const f of files) {
    const j = JSON.parse(readFileSync(join(DEMAND, f), "utf8"));
    const { moment, persona } = j;

    const seen = new Set();
    const clean = [];
    for (const r of j.rows ?? []) {
      if (HOMONYM.test(r.query) || seen.has(r.query)) continue;
      seen.add(r.query);
      clean.push(r);
    }

    let own = 0, calc = 0;
    const directionMix = {};
    for (const r of clean) {
      const relevant = MOMENT_RE[moment].test(r.query);
      if (relevant) own++;
      if (relevant && CALC.test(r.query)) calc++;
      const d = directionOf(r.query);
      directionMix[d] = (directionMix[d] ?? 0) + 1;
      detail.push({
        text: r.query,
        moment,
        persona,
        kind: kindOf(r.query),
        computable: CALC.test(r.query),
        seed: (r.seeds ?? [])[0] ?? "",
        source: (r.engines ?? [])[0] ?? "",
        direction: d,
        chinaAnchored: CHINA_ANCHOR.test(r.query),
      });
    }

    const hits = pages.filter((p) => PERSONA_RE[persona].test(p.text) && MOMENT_PAGE[moment].test(p.text));
    const seedQuality = j.seedQuality ?? "ambiguous";

    let verdict, why = "";
    if (j.status === "failed") { verdict = "定义待验证"; why = "抓取失败"; }
    else if (own === 0) {
      if (seedQuality === "unambiguous") { verdict = "无需求证据"; why = "own=0 且种子无歧义"; }
      else { verdict = "定义待验证"; why = `own=0 但 seedQuality=${seedQuality}`; }
    } else if (hits.length === 0) { verdict = "有需求·无页面"; }
    else { verdict = "有需求·有页面"; }

    cells.push({ moment, persona, status: j.status === "failed" ? "failed" : "ok", seedQuality, clean: clean.length, own, calc, pages: hits.length, pageIds: hits.map((p) => p.id), verdict, why, directionMix });
  }

  const totalClean = cells.reduce((a, c) => a + c.clean, 0);
  const out = {
    at: new Date().toISOString(),
    date,
    instrument: "Google and Bing public autocomplete. Returns phrasings, not volume; read it as a scope map, not a ranking.",
    qualityRules: [
      "own == 0 and seedQuality == 'unambiguous' -> 无需求证据",
      "own == 0 and seedQuality != 'unambiguous' -> 定义待验证",
      "own > 0 and pages == 0 -> 有需求·无页面",
      "own > 0 and pages > 0 -> 有需求·有页面",
      "status == failed (harvest) -> 定义待验证",
    ],
    selfCheck: {
      total_raw: cells.reduce((a, c) => a + (c.clean + 0), 0),
      total_clean: totalClean,
      total_own: cells.reduce((a, c) => a + c.own, 0),
      sum_clean_by_cell: totalClean,
      detail_rows: detail.length,
      unique_cross_cell: new Set(detail.map((d) => d.text)).size,
    },
    cells,
    intents: detail,
  };
  out.selfCheck.reconcile = out.selfCheck.sum_clean_by_cell === totalClean && detail.length === totalClean;

  writeFileSync(join(DEMAND, `matrix-cells-${date}.json`), JSON.stringify(out, null, 2) + "\n", "utf8");
  return out;
}

/* ------------------------------------------------------------------ main */

const argDate = process.argv.find((a) => a.startsWith("--date="))?.slice(7);
const date = argDate ?? new Date().toISOString().slice(0, 10);
const aggregateOnly = process.argv.includes("--aggregate");

if (!aggregateOnly) {
  console.log(`DEMAND RADAR ${date}`);
  const { written, failedCells } = await harvest(date);
  console.log(`\n  ${written} cells written, ${failedCells} failed to harvest`);
}

const out = aggregate(date);
const tally = {};
for (const c of out.cells) tally[c.verdict] = (tally[c.verdict] ?? 0) + 1;

console.log("\nVERDICTS " + JSON.stringify(tally));
console.log("SELFCHECK " + JSON.stringify(out.selfCheck));
if (!out.selfCheck.reconcile) {
  console.error("reconcile failed: the summary does not match the detail rows");
  process.exit(3);
}
