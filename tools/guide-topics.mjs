/**
 * Guide topics, generated from the demand matrix.
 *
 * The queue was hand-written and ran dry every few days. Meanwhile the radar harvests what people actually
 * type - 1,319 phrasings across five personas and five moments, from Google and Bing autosuggest - and none
 * of it reached the guide line.
 *
 * This turns uncovered intents into queue entries. No model call: the slug, title, audience and keywords all
 * come from the query itself, which is what makes it free to run on every guide run. A model could write
 * prettier titles, and that is the one thing worth adding later.
 *
 *   node tools/guide-topics.mjs                 top up to --min=10 open topics
 *   node tools/guide-topics.mjs --dry-run       print what would be added
 */
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const DRY = args.includes("--dry-run");
const MIN_OPEN = Number(flag("min", "10"));
const QUEUE = join(ROOT, "data", "guide-queue.json");

const GUIDE_PERSONAS = { expat: "relocating", student: "student", bri: "visitor" };
const GUIDE_MOMENTS = new Set(["arrive", "live", "leave"]);

/* Words that make a query a guide question rather than a trade question. */
const GUIDE_SHAPE = /\b(visa|permit|rent|apartment|bank|account|pay|payment|sim|phone|health|insurance|deposit|salary|cost|price|fee|tax|refund|licence|license|drive|driving|school|university|tuition|student|live|living|move|relocat|settle|register|registration|renew|renewal|open|apply|application|document|documents)\b/i;

const STOP = new Set(["the","a","an","in","of","for","to","and","or","is","are","do","does","can","i","my","china","chinese","how","much","what","where","when","why","with","on","at","from","by","it","this","that","be","has","have","need","needs","get","getting","guide","2026"]);

function slugify(text, max = 7) {
  const words = String(text).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w && !STOP.has(w));
  return words.slice(0, max).join("-");
}

function titleOf(text) {
  const s = String(text).trim().replace(/\s+/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* Two shared significant words is our working definition of "the site already answers this". */
const existing = (() => {
  const out = [];
  for (const dir of ["src/content/guide", "src/content/blog"]) {
    const p = join(ROOT, dir);
    if (!existsSync(p)) continue;
    for (const f of readdirSync(p).filter((x) => x.endsWith(".md"))) {
      out.push(f.replace(/\.md$/, "").split("-").filter((w) => w.length > 3));
    }
  }
  return out;
})();

function coveredBy(phrase) {
  const words = String(phrase).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !STOP.has(w));
  if (words.length < 2) return false;
  for (const slugWords of existing) {
    const shared = words.filter((w) => slugWords.includes(w)).length;
    if (shared >= Math.min(3, words.length)) return true;
  }
  return false;
}

const queue = JSON.parse(readFileSync(QUEUE, "utf8"));
queue.topics = Array.isArray(queue.topics) ? queue.topics : [];
const open = queue.topics.filter((t) => t.status !== "done");
if (open.length >= MIN_OPEN) {
  console.log(`  queue has ${open.length} open topic(s), at or above the ${MIN_OPEN} requested - nothing to do`);
  process.exit(0);
}

/* Newest matrix on disk. */
const dir = join(ROOT, "data", "demand");
const matrixFile = readdirSync(dir).filter((f) => f.startsWith("matrix-cells-")).sort().at(-1);
if (!matrixFile) {
  console.log("  no demand matrix on disk - run tools/demand-radar.mjs first");
  process.exit(0);
}
const matrix = JSON.parse(readFileSync(join(dir, matrixFile), "utf8"));

const seenSlug = new Set(queue.topics.map((t) => t.slug));
const seenCluster = new Map();

/*
 * THREE PHRASINGS OF ONE QUESTION ARE ONE TOPIC.
 *
 * "china visa fee in nigeria", "china visa fee for nigerians" and "how much is a visa from nigeria to china"
 * produced three slugs and would have produced three articles about the same fee - the duplicate problem,
 * arriving from the supply side this time. The key is the two or three significant words reduced to their
 * first six characters, which folds nigeria/nigerians and price/prices together without a stemmer.
 */
/*
 * ONE TOPIC PER ANCHOR AND COUNTRY.
 *
 * Counting shared words was not enough: "health insurance cost in china", "how much is health insurance in
 * china" and "health insurance in china for foreigners cost" survived as three topics because the word sets
 * differ while the question does not. The anchor - the noun the question is about - plus the country (or
 * "generic") is what actually identifies a subject.
 */
const ANCHORS = ["insurance", "permit", "apartment", "rent", "deposit", "bank", "account", "payment", "sim", "visa", "parcel", "refund", "salary", "tax", "licence", "license", "school", "tuition", "health", "phone", "transfer", "shipping", "freight"];
const COUNTRIES = ["nigeria", "nigerian", "nigerians", "pakistan", "pakistani", "pakistanis", "india", "indian", "indians", "bangladesh", "bangladeshi", "africa", "ghana", "kenya", "egypt", "indonesia", "vietnam", "philippines", "russia", "brazil", "mexico", "turkey", "iran", "iraq", "saudi", "uae", "dubai", "usa", "america", "britain", "british", "uk", "canada", "australia", "germany", "france", "italy", "spain", "korea", "japan", "thailand", "malaysia"];
function clusterKey(text) {
  const words = String(text).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const anchor = ANCHORS.find((a) => words.some((w) => w.startsWith(a.slice(0, Math.max(4, a.length - 2))))) ?? words.filter((w) => w.length > 3 && !STOP.has(w))[0] ?? "misc";
  const country = COUNTRIES.find((c) => words.some((w) => w.startsWith(c.slice(0, 4)))) ?? "generic";
  return anchor + "|" + country;
}
const candidates = [];
for (const row of matrix.intents ?? []) {
  const audience = GUIDE_PERSONAS[row.persona];
  if (!audience) continue;
  if (!GUIDE_MOMENTS.has(row.moment)) continue;
  const text = String(row.text ?? "").trim();
  if (!text || text.length > 70) continue;
  if (!GUIDE_SHAPE.test(text)) continue;
  /*
   * A GUIDE IS ABOUT CHINA. The matrix harvests whatever autosuggest returns, and it returned "japan
   * apartments for rent for foreigners", "close bank of china account singapore" and "how to close a bank
   * account uk" - three subjects this site has no business writing. A country name that is not China, in a
   * question that does not mention China, is a different market. */
  const OTHER_COUNTRY = /\b(japan|korea|singapore|uk|britain|usa|america|canada|australia|germany|france|italy|spain|philippines|thailand|malaysia|vietnam|indonesia|dubai|uae|saudi|turkey|russia|mexico|brazil|egypt|ghana|kenya|nigeria|pakistan|bangladesh|india|iran|iraq)\b/i;
  if (OTHER_COUNTRY.test(text) && !/\bchina\b|\bchinese\b|\bmainland\b/i.test(text)) continue;
  const slug = slugify(text);
  if (!slug || slug.split("-").length < 2) continue;
  if (seenSlug.has(slug)) continue;
  if (coveredBy(text)) continue;
  seenSlug.add(slug);
  const key = clusterKey(text);
  if (seenCluster.has(key)) continue;
  seenCluster.set(key, text);
  candidates.push({ text, slug, audience, moment: row.moment, source: row.source ?? "matrix" });
}

/* Questions first: a "how much" query is what the guide format answers best. */
const scored = candidates
  .map((c) => ({
    ...c,
    /* A figure the sources actually publish beats a figure that only an embassy knows. */
    score:
      (/\b(rent|apartment|deposit|bank|account|pay|payment|insurance|permit|renew|health|sim|salary|tax|refund)\b/i.test(c.text) ? 3 : 0) +
      (/\b(how much|cost|price|fee)\b/i.test(c.text) ? 1 : 0) -
      (/\b(parcel|courier|ship a|visa fee)\b/i.test(c.text) ? 1 : 0),
  }))
  .sort((a, b) => b.score - a.score);

const wanted = Math.max(0, MIN_OPEN - open.length);
const picked = scored.slice(0, wanted);
console.log(`  matrix ${matrixFile}: ${(matrix.intents ?? []).length} intents, ${candidates.length} uncovered guide-shaped, adding ${picked.length}`);
for (const c of picked) console.log(`   + ${c.slug}   ← "${c.text}"`);

if (!DRY) {
  for (const c of picked) {
    queue.topics.push({
      slug: c.slug,
      topic: c.moment,
      audience: [c.audience],
      unit: "one application",
      title: titleOf(c.text),
      query: c.text,
      status: "queued",
      evidence: `demand matrix: "${c.text}" (${c.source})`,
      sources: ["https://www.nia.gov.cn/n741440/n741567/index.html", "https://english.www.gov.cn/", "https://www.gov.cn/zhengce/zuixin/"],
      fetchKeywords: String(c.text).split(/\s+/).filter((w) => w.length > 3).slice(0, 5),
      facts: [], mustSay: [], avoid: [],
    });
  }
  queue.updatedAt = new Date().toISOString();
  writeFileSync(QUEUE, JSON.stringify(queue, null, 2) + "\n", "utf8");
  console.log(`  queue now ${queue.topics.length} topic(s), ${queue.topics.filter((t) => t.status !== "done").length} open`);
}
