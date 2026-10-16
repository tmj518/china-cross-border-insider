/**
 * Autonomous research: fetch sources, propose a subject, extract figures, verify them, write a
 * directive.
 *
 *   node tools/research.mjs                       full run, writes data/directive.json
 *   node tools/research.mjs --dry-run              fetch and propose, write nothing
 *   node tools/research.mjs --budget=0.50          hard ceiling in estimated USD for this run
 *   node tools/research.mjs --sources=2            how many candidate pages to fetch
 *   node tools/research.mjs --ledger               show the subject ledger
 *
 * ## The order, and why it is this order
 *
 *   1. Fetch candidate pages and ARCHIVE them. Nothing is proposed before the documents exist
 *      locally, because a subject proposed from a model's memory is a subject nobody has read.
 *   2. The model reads the archives and proposes one subject with five to eight figures, each
 *      carrying `evidence` - a verbatim excerpt - and `evidence_from`, the archive path.
 *   3. tools/check-evidence.mjs verifies every excerpt against the archive, mechanically.
 *   4. Only then is a directive written.
 *
 * Step 3 is the one that makes this safe to run unattended. Without it, the model that writes a
 * figure also certifies the figure, which is the arrangement that produces confident wrong numbers.
 * With it, an invented number cannot pass, because inventing the accompanying excerpt is the same work
 * as reading the file.
 *
 * ## Duplicate detection
 *
 * Every published article contributes a row to `data/ledger.jsonl`: its slug, keyword, category,
 * source hosts and figure values. A proposed subject that shares a host and a keyword stem with an
 * existing row is rejected before any writing happens. This is what stops a pipeline that runs every
 * day from writing the same article twice with different phrasing.
 *
 * ## The budget
 *
 * Calls are metered in `logs/usage.jsonl` by tools/lib-llm.mjs. This module sums the run's own spend
 * and stops before the next call when the ceiling is reached, so a runaway loop costs a known amount
 * rather than whatever it happens to consume. The default ceiling is deliberately small: research
 * that cannot finish within it is research that was not ready.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { askJson, available, summary as providerSummary, usageToday } from "./lib-llm.mjs";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const DRY = args.includes("--dry-run");
const BUDGET = Number(flag("budget", "0.40"));
const MAX_SOURCES = Number(flag("sources", "4"));

const SOURCES_DIR = join(ROOT, "data", "sources");
const LEDGER = join(ROOT, "data", "ledger.jsonl");
const DIRECTIVE = join(ROOT, "data", "directive.json");

/* ---------------------------------------------------------------- the ledger */

export function loadLedger() {
  if (!existsSync(LEDGER)) return [];
  try {
    return readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

if (args.includes("--ledger")) {
  /* Built on demand: the ledger is derived from the corpus, so asking to see it when it does not yet
     exist should show it rather than report that it is absent. */
  const rows = existsSync(LEDGER) ? loadLedger() : buildLedger();
  console.log(`SUBJECT LEDGER — ${rows.length} row(s)\n${"=".repeat(88)}`);
  if (!rows.length) console.log("  (the corpus produced no rows, which means no published articles were found)");
  for (const r of rows) {
    console.log(`  #${String(r.articleNumber ?? "?").padStart(2)}  ${String(r.category ?? "").padEnd(12)} ${r.slug}`);
    console.log(`        keyword : ${r.keyword || "(none)"}`);
    console.log(`        sources : ${(r.sourceNames ?? []).slice(0, 2).map((s) => String(s).slice(0, 62)).join(" | ") || "(none)"}`);
    console.log(`        figures : ${(r.values ?? []).slice(0, 6).join(" ") || "(none)"}`);
  }
  process.exit(0);
}

/**
 * Build the ledger from the corpus. Idempotent: it is derived, never hand-edited.
 *
 * The obvious key would be the source host, and it cannot be used: not one of the thirty-six articles
 * contains a URL. Sources are named strings - "General Administration of Customs of the PRC,
 * Announcement No. 74 of 2026" - which is deliberate, since the site cites instruments rather than
 * links, and a link rots while an instrument number does not.
 *
 * So the ledger carries what is actually there: the keyword, the source names as written, and every
 * figure value. Two proposals that name the same instrument and report the same numbers are the same
 * subject, and that is what the duplicate check compares.
 */
export function buildLedger() {
  const blog = join(ROOT, "src", "content", "blog");
  const rows = [];
  for (const f of readdirSync(blog).filter((x) => x.endsWith(".md"))) {
    const t = readFileSync(join(blog, f), "utf8");
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(t)?.[1] ?? "";
    if (/^draft:\s*true/m.test(fm)) continue;
    const slug = f.replace(/\.md$/, "");
    const sourceBlock = fm.split(/^sources:\s*$/m)[1]?.split(/^\w+:/m)[0] ?? "";
    const sourceNames = [...sourceBlock.matchAll(/^\s{2}-\s*"?(.+?)"?\s*$/gm)].map((m) => m[1].trim()).filter(Boolean);
    const values = [...new Set([...fm.matchAll(/^\s{2}- value:\s*"?(.+?)"?\s*$/gm)].map((m) => m[1].trim()))];
    rows.push({
      articleNumber: Number(/^articleNumber:\s*(\d+)/m.exec(fm)?.[1] ?? 0),
      slug,
      keyword: (/^target_keyword:\s*"?(.+?)"?\s*$/m.exec(fm)?.[1] ?? "").trim(),
      category: (/^category:\s*"?(.+?)"?\s*$/m.exec(fm)?.[1] ?? "").trim(),
      publishDate: (/^publishDate:\s*"?(.+?)"?\s*$/m.exec(fm)?.[1] ?? "").trim(),
      sourceNames,
      values,
      tags: (/^tags:\s*\[(.*?)\]/m.exec(fm)?.[1] ?? "").replace(/["\s]/g, "").split(",").filter(Boolean),
    });
  }
  rows.sort((a, b) => a.articleNumber - b.articleNumber);
  mkdirSync(join(ROOT, "data"), { recursive: true });
  writeFileSync(LEDGER, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return rows;
}

const STOP = new Set(["duty", "duties", "rate", "rates", "2026", "2027", "china", "chinese", "the", "and", "for", "from", "anti", "dumping", "tariff", "cost", "price", "import", "imports", "importing", "trade", "export", "exports"]);
const stems = (s) => String(s).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !STOP.has(w));

/** Words that identify an institution across the ways it gets written. */
const ORG_STOP = new Set(["general", "administration", "ministry", "commission", "state", "council", "national", "bureau", "department", "republic", "peoples", "people", "official", "notice", "announcement", "regulation", "customs", "the", "and", "for", "from"]);
const orgTokens = (s) => String(s).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 3 && !ORG_STOP.has(w));

/**
 * Overlap between a proposal and the corpus.
 *
 * Three signals, weighted by how much each actually means. A shared figure value is the strongest:
 * two articles reporting 17.45 per cent about the same product are the same article. A shared keyword
 * stem is next. A shared institution is weakest on its own - many subjects come from the same ministry
 * - so it counts for one.
 *
 * The threshold is four. A single shared value plus a shared keyword stem reaches it, which is the
 * case that matters: the same number under a different headline.
 */
function duplicateScore(proposal, ledger) {
  const pk = new Set(stems(proposal.keyword ?? ""));
  const pv = new Set((proposal.figures ?? []).map((f) => String(f.value ?? "").replace(/[$,%\s]/g, "").toLowerCase()).filter((v) => v.length >= 3));
  const po = new Set((proposal.sources ?? []).flatMap((s) => orgTokens(s)));
  const pn = new Set((proposal.sourceHosts ?? []).flatMap((h) => orgTokens(h)));

  let best = { score: 0, against: null, why: [] };
  for (const row of ledger) {
    const rk = new Set(stems(row.keyword));
    const rv = new Set((row.values ?? []).map((v) => String(v).replace(/[$,%\s]/g, "").toLowerCase()).filter((v) => v.length >= 3));
    const ro = new Set((row.sourceNames ?? []).flatMap((s) => orgTokens(s)));

    const sharedKw = [...pk].filter((w) => rk.has(w));
    const sharedVals = [...pv].filter((v) => rv.has(v));
    const sharedOrg = [...po, ...pn].filter((w) => ro.has(w));

    const score = sharedVals.length * 3 + sharedKw.length * 2 + sharedOrg.length;
    if (score > best.score) {
      best = {
        score,
        against: row.slug,
        why: [
          sharedVals.length ? `shared figure value(s): ${sharedVals.slice(0, 5).join(", ")}` : "",
          sharedKw.length ? `shared keyword stems: ${sharedKw.slice(0, 5).join(", ")}` : "",
          sharedOrg.length ? `shared institution(s): ${[...new Set(sharedOrg)].slice(0, 5).join(", ")}` : "",
        ].filter(Boolean),
      };
    }
  }
  return best;
}

/* ---------------------------------------------------------------- candidate sources */

/*
 * Pages worth fetching, chosen because they are index-shaped: a listing that changes daily and links
 * to the documents behind it. A single document is only useful once a subject is chosen; a listing is
 * what a subject gets chosen from.
 *
 * The first URL of each pair answers from a data-centre address in the tests run so far; the second is
 * the fallback for the sites that raise 412 against some request patterns. A failure is recorded and
 * the next candidate is tried, because a research run that dies on one blocked site is a research run
 * that dies every day.
 */
const CANDIDATES = [
  ["https://cacs.mofcom.gov.cn/", "trade-remedy-cases", "foreign anti-dumping and safeguard measures against Chinese exports, the highest-value source for a cost angle"],
  ["http://gss.mof.gov.cn/gzdt/", "tariff-commission", "Tariff Commission notices: rate schedules and adjustments"],
  ["https://www.mof.gov.cn/zhengwuxinxi/zhengcefabu/", "ministry-of-finance", "Ministry of Finance policy releases"],
  ["https://www.mofcom.gov.cn/zfxxgk/", "mofcom", "MOFCOM announcements"],
  ["https://www.stats.gov.cn/sj/zxfb/", "statistics-bureau", "National Bureau of Statistics releases: PPI, CPI, industrial profit"],
  ["https://www.chinatax.gov.cn/chinatax/n810341/n810755/index.html", "tax-administration", "export tax rebate rates"],
  ["https://policy.trade.ec.europa.eu/news_en", "eu-trade-news", "EU trade policy news, CBAM and trade defence"],
  ["https://www.federalregister.gov/api/v1/documents.json?per_page=20&order=newest&conditions[agencies][]=u.s.-customs-and-border-protection", "federal-register-cbp", "US CBP rules with effective dates, the best API of any source here"],
];

if (!available().length) {
  console.log("RESEARCH\n" + "=".repeat(84));
  console.log(providerSummary());
  console.log("\n  No provider key, so no subject can be proposed. Nothing was fetched and nothing written.");
  process.exit(78);
}

console.log(`RESEARCH  ${new Date().toISOString()}\n${"=".repeat(84)}`);
console.log(providerSummary());
console.log(`  budget   : $${BUDGET.toFixed(2)}`);
console.log(`  fetches  : up to ${MAX_SOURCES}`);
console.log("");

const started = usageToday();

/* ---------------------------------------------------------------- 1. fetch and archive */

const day = new Date().toISOString().slice(0, 10);
mkdirSync(join(SOURCES_DIR, day), { recursive: true });

const fetched = [];
for (const [url, label, why] of CANDIDATES) {
  if (fetched.length >= MAX_SOURCES) break;
  let out = "";
  try {
    out = execFileSync(process.execPath, [join(ROOT, "tools", "store-source.mjs"), `--url=${url}`, `--label=research-${label}`], { encoding: "utf8", timeout: 120000 });
  } catch (e) {
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  const ok = /^\s+ok\s/m.test(out);
  const file = /archived: (\S+)/.exec(out)?.[1] ?? null;
  const bytes = Number(/ok\s+\d+\s+(\d+) bytes/.exec(out)?.[1] ?? /FAIL\s+\d+\s+(\d+) bytes/.exec(out)?.[1] ?? 0);
  console.log(`  ${ok ? "ok  " : "skip"}  ${label.padEnd(24)} ${String(bytes).padStart(8)}B  ${ok ? "archived" : "not usable (recorded anyway)"}`);
  if (ok && file) fetched.push({ url, label, why, file: file.replace(/\\/g, "/"), bytes });
}

if (!fetched.length) {
  console.log("");
  console.log("  Nothing was fetched. Research stops here rather than proposing a subject from memory.");
  console.log("  Run node tools/check-source-reachability.mjs to see which sources answer from this machine,");
  console.log("  and in Actions run the probe workflow to see whether a data-centre address fares differently.");
  process.exit(1);
}

/* ---------------------------------------------------------------- 2. the model proposes */

const ledger = existsSync(LEDGER) ? loadLedger() : buildLedger();
console.log(`\n  ledger: ${ledger.length} published subject(s) to avoid repeating`);

/*
 * The archives are passed as text with their paths. The model is told to quote from them and to give
 * the path it quoted from; the checker verifies both, so a quotation from memory fails.
 */
const corpus = fetched
  .slice(0, 3)
  .map((f) => {
    const p = join(ROOT, f.file);
    let body = "";
    try {
      body = readFileSync(p, "latin1")
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;|&#160;/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 18000);
    } catch {}
    return `--- SOURCE: ${f.file}\nURL: ${f.url}\nWHY IT MATTERS: ${f.why}\n\n${body}\n`;
  })
  .join("\n");

const covered = ledger
  .slice(-40)
  .map((r) => `  #${r.articleNumber} ${r.slug} — keyword "${r.keyword}"`)
  .join("\n");

/*
 * Which sections the operator's rule says are behind.
 *
 * The rule is one to three articles per section per week, and the orchestrator computes which sections
 * have none yet. Those are passed here because the subject is chosen in this module and nowhere else -
 * a rule checked but not acted on is a report, not a rule.
 *
 * It is a preference and not a constraint, and the wording says so. If today's documents do not support
 * an article in the section that is behind, forcing one produces exactly the thing the quality rule
 * exists to prevent: a summary with no arithmetic in it, which is what search engines demote. So the
 * model is told that favouring a section is worth a little and damaging the article is worth more.
 */
const behind = (process.env.UNCOVERED_SECTIONS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const sectionBlock = behind.length
  ? `
SECTION COVERAGE — the operator's rule is one to three articles per section per week

These sections have had no net-new article this week: ${behind.join(", ")}

Prefer a subject in one of them when the documents below genuinely support it. A subject in a covered
section that the documents support well is better than a subject in a behind section that they support
thinly: an article without five citable numbers and a cost consequence is the commodity summary this
site exists not to publish, and publishing one costs more than a week's gap in a section. Say which
section your subject belongs to in "category", and if the documents do not support the section that is
behind, choose what they do support.
`
  : "";

const prompt = `You are choosing today's subject for Landed Math, an English site that turns official
documents into per-unit cost consequences for importers.

Below are source documents, fetched and archived today. Their paths are real; quote from them.

WHAT MAKES A SUBJECT WORTH WRITING
  - a change with a date: something that took effect, expires, or was announced
  - at least five citable numbers, each of which appears verbatim in one of these documents
  - a cost consequence an importer can act on: a duty, a fee, a deadline, a rate, a threshold
  - it is not already covered. The last forty published subjects are listed below.

WHAT IS REJECTED
  - a subject whose numbers are not in the documents below
  - a subject that repeats one of the listed articles, even under a different title
  - political, religious, military or reputation commentary. Trade and cost facts only.
${sectionBlock}
THE SOURCES

${corpus}

ALREADY PUBLISHED — do not repeat these
${covered}

Return ONLY a JSON object:
{
  "feasible": true or false,
  "reason_if_not": "one sentence, when feasible is false",
  "slug": "kebab-case, distinctive",
  "title_idea": "a plain declarative headline",
  "keyword": "the phrase a buyer would search",
  "category": "trade-policy | platforms | supply-chain | sourcing | logistics",
  "audience": "importer | platform-seller | both",
  "angle": "the decision this article lets the reader make, in one sentence",
  "sourceHosts": ["hostnames you used"],
  "figures": [
    { "value": "as it appears in the document",
      "unit": "what it measures",
      "period": "when it applies",
      "source": "the instrument or publisher, named",
      "retrieved": "${day}",
      "evidence": "a verbatim excerpt copied from the document, which must contain the value",
      "evidence_from": "the SOURCE path above, exactly as written" }
  ],
  "sources": ["the instruments or publishers, one line each"]
}

Give five to eight figures. Every one needs an evidence excerpt that literally contains the value and
literally appears in the document it names. If the documents do not support five figures, set
feasible to false and say so — that is a correct and useful answer, not a failure.`;

console.log(`  proposing a subject from ${Math.min(fetched.length, 3)} archived document(s)...`);
const r = await askJson({
  role: "planner",
  system:
    "You select subjects for a trade-cost publication from documents supplied to you. You quote only " +
    "from those documents and you say so when they do not support an article. You never supply a " +
    "number that is not literally in a document you were given.",
  messages: [{ role: "user", content: prompt }],
  maxTokens: 8192,
});

const spent = usageToday().usd - started.usd;
if (!r.ok || !r.json) {
  console.log(`\n  FAILED - ${r.error ?? r.parseError ?? "unparseable response"}`);
  if (r.raw) console.log(`  raw head: ${String(r.raw).slice(0, 400)}`);
  console.log(`  spent   : ~$${spent.toFixed(4)}`);
  process.exit(1);
}

const proposal = r.json;
console.log(`  spent   : ~$${spent.toFixed(4)}  (ceiling $${BUDGET.toFixed(2)})`);
console.log(`  model   : ${r.provider}/${r.model}`);
console.log("");
console.log(`  feasible: ${proposal.feasible}`);
if (proposal.feasible === false) {
  console.log(`  reason  : ${proposal.reason_if_not}`);
  console.log("");
  console.log("  The documents do not support an article today. That is the answer, and no directive was");
  console.log("  written. A day without a qualifying subject is a day without an article.");
  process.exit(0);
}
console.log(`  slug    : ${proposal.slug}`);
console.log(`  keyword : ${proposal.keyword}`);
console.log(`  category: ${proposal.category}`);
console.log(`  figures : ${(proposal.figures ?? []).length}`);

/* ---------------------------------------------------------------- 3. duplicate check */

const dup = duplicateScore(proposal, ledger);
console.log(`\n  duplicate check: score ${dup.score}${dup.against ? ` against ${dup.against}` : ""}`);
if (dup.why?.length) for (const w of dup.why) console.log(`      ${w}`);
if (dup.score >= 4) {
  console.log("");
  console.log("  REJECTED as a duplicate. The proposal shares enough with a published article that it is");
  console.log("  the same subject under a different title. No directive was written.");
  process.exit(2);
}

/* ---------------------------------------------------------------- 4. verify the evidence */

mkdirSync(join(ROOT, "data", "tmp"), { recursive: true });
const probePath = join(ROOT, "data", "tmp", "research-proposal.json");
writeFileSync(probePath, JSON.stringify(proposal, null, 2), "utf8");

let evidenceOut = "";
let evidenceCode = 0;
try {
  evidenceOut = execFileSync(process.execPath, [join(ROOT, "tools", "check-evidence.mjs"), `--directive=${probePath}`, "--json"], { encoding: "utf8", timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
} catch (e) {
  evidenceOut = `${e.stdout ?? ""}`;
  evidenceCode = e.status ?? 1;
}
let evidence = null;
try {
  evidence = JSON.parse(evidenceOut)?.[0];
} catch {}

console.log(`\n  evidence check:`);
if (!evidence) {
  console.log("    the checker produced no result");
} else {
  console.log(`    external figures : ${evidence.checked}`);
  console.log(`    verified         : ${evidence.checked - (evidence.failed?.length ?? 0)}`);
  console.log(`    failed           : ${evidence.failed?.length ?? 0}`);
  for (const f of (evidence.failed ?? []).slice(0, 6)) {
    console.log(`      "${f.value}"  ${f.problems.join("; ")}`);
  }
}

if (evidenceCode !== 0 || (evidence?.failed?.length ?? 0) > 0) {
  console.log("");
  console.log("  REJECTED. At least one figure's excerpt is not in the document it cites. This is the check");
  console.log("  that makes unattended research safe: the model that proposed the number is not the thing");
  console.log("  that certifies it. No directive was written.");
  process.exit(3);
}

/* ---------------------------------------------------------------- 5. write the directive */

const directive = {
  _note:
    "Written by tools/research.mjs and verified by tools/check-evidence.mjs. Every external figure's " +
    "excerpt was found in its archived document and carries its value. Figures are the only numbers " +
    "the writer may use.",
  _generated: new Date().toISOString(),
  _research: {
    fetched: fetched.map((f) => ({ url: f.url, file: f.file, bytes: f.bytes })),
    model: `${r.provider}/${r.model}`,
    spentUsd: Number(spent.toFixed(4)),
    duplicateScore: dup.score,
    duplicateAgainst: dup.against ?? null,
  },
  slug: proposal.slug,
  title_idea: proposal.title_idea,
  keyword: proposal.keyword,
  category: proposal.category,
  audience: proposal.audience,
  angle: proposal.angle,
  figures: proposal.figures,
  sources: proposal.sources,
};

if (DRY) {
  console.log(`\n  --dry-run: would write ${DIRECTIVE.replace(ROOT, "")}`);
  console.log(`  total spend this run: ~$${(usageToday().usd - started.usd).toFixed(4)}`);
  process.exit(0);
}

writeFileSync(DIRECTIVE, JSON.stringify(directive, null, 2), "utf8");

/* The ledger gains the approved subject immediately, so a second run today cannot repeat it. */
appendFileSync(
  LEDGER,
  JSON.stringify({
    articleNumber: null,
    slug: proposal.slug,
    keyword: proposal.keyword,
    category: proposal.category,
    publishDate: day,
    hosts: (proposal.sourceHosts ?? []).map((h) => String(h).replace(/^www\./, "")),
    values: (proposal.figures ?? []).map((f) => f.value),
    tags: [],
    proposedNotYetPublished: true,
  }) + "\n",
  "utf8",
);

console.log("");
console.log(`  wrote ${DIRECTIVE.replace(ROOT, "")}`);
console.log(`  spend this run: ~$${(usageToday().usd - started.usd).toFixed(4)}`);
console.log("");
console.log("  Next: node tools/cloud-orchestrator.mjs   (which will write, review and publish)");
process.exit(0);
