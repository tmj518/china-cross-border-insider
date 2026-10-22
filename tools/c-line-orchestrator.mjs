#!/usr/bin/env node
/**
 * The C line: guides for people moving to, working in or visiting China.
 *
 * ## What it is
 *
 * A third publishing route that shares this repository but not its content collection. `/blog/` is
 * written by the trade pipeline and answers "what does this policy cost per unit". `/guide/` answers
 * "what does this cost me, what does it take, and when was that checked".
 *
 *   node tools/c-line-orchestrator.mjs              # try every queued topic until one publishes
 *   node tools/c-line-orchestrator.mjs --dry-run    # propose and print, touch nothing
 *   node tools/c-line-orchestrator.mjs --slug=<s>   # one specific topic
 *
 * ## It does not strike, and it does not invent
 *
 * The first version refused to write a topic without a hand-authored fact sheet. That is a queue that
 * stops after one article. This version fetches the sources itself and extracts the figures from them,
 * but it accepts a figure ONLY when the model returns a verbatim quote that is found in the fetched
 * text. A number with no quote in the page is dropped, not softened.
 *
 * That is the difference between "go and read it yourself" and "make something up". The first is
 * automation; the second is how a content site loses the only thing it has.
 *
 * ## Three properties it must keep
 *
 * 1. IT MUST NOT BREAK THE SITE. The one shared failure mode with the trade line is `astro build`: one
 *    invalid entry fails the whole build. So a guide is written outside the collection, copied in, and
 *    the site is built with it in place. A failure removes the file before anything is committed.
 *
 * 2. THE MODEL DOES NOT FORMAT FRONTMATTER. It returns JSON; this file assembles the markdown and
 *    writes every field through JSON.stringify, so a guide cannot reproduce the 2026-10-21 outage where
 *    an unquoted date in a model-written header froze the build.
 *
 * 3. EVERY DIGIT IN THE PROSE TRACES TO THE FACT SHEET. Checked before a file is written.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";

import { loadEnv, today } from "./lib/gsc.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const QUEUE_FILE = join(ROOT, "data", "guide-queue.json");
const DRAFT_DIR = join(ROOT, "data", "drafts-c");
const GUIDE_DIR = join(ROOT, "src", "content", "guide");
const RUN_DIR = join(ROOT, "data", "runs");
const SOURCE_DIR = join(ROOT, "data", "sources");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const WANT = (args.find((a) => a.startsWith("--slug=")) ?? "").slice("--slug=".length).trim();
const MAX_TOPICS = Number((args.find((a) => a.startsWith("--max=")) ?? "").slice(6)) || 3;

const STARTED = Date.now();
const log = (s) => console.log(s);

/* ── the run record ────────────────────────────────────────────────────────────────────────────── */

const steps = [];
const step = (name, ok, detail = "") => {
  steps.push({ name, ok, detail });
  log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
};

const usage = { calls: 0, failed: 0, usd: 0 };
let spentBefore = { usd: 0 };
let verdict = "NO-SUBJECT";
let article = "";
const reasons = [];

function finish(code = 0) {
  usage.usd = Math.max(0, Number((usageAfter().usd ?? 0) - (spentBefore.usd ?? 0)));
  const report = {
    at: new Date().toISOString(),
    route: "c",
    verdict,
    article: article || null,
    seconds: Math.round((Date.now() - STARTED) / 1000),
    usage,
    providers: ["volces"],
    reasons,
    steps,
    researchLog: [`model : volces/${process.env.ARK_MODEL_WRITER ?? "unset"}`],
  };
  try {
    mkdirSync(RUN_DIR, { recursive: true });
    const stamp = report.at.replace(/[:.]/g, "-").slice(0, 19);
    writeFileSync(join(RUN_DIR, `c-${stamp}.json`), JSON.stringify(report, null, 2), "utf8");
    writeFileSync(join(RUN_DIR, "latest-c.json"), JSON.stringify(report, null, 2), "utf8");
  } catch (e) {
    log(`  could not write the run record: ${e.message}`);
  }
  log(`\nverdict: ${verdict}`);
  process.exit(code);
}

/* ── environment ──────────────────────────────────────────────────────────────────────────────── */

const env = loadEnv(join(ROOT, ".env"));
for (const [k, v] of Object.entries(env)) if (!process.env[k]) process.env[k] = v;

const ARK_KEY = (process.env.ARK_API_KEY ?? "").trim();
const MODEL = (process.env.ARK_MODEL_WRITER ?? process.env.DUBAOTUILI12345 ?? "").trim();
const DAY = today();

log(`C LINE  ${new Date().toISOString()}${DRY ? "  (dry run)" : ""}`);
log("=".repeat(84));

if (!ARK_KEY || !MODEL) {
  verdict = "NO-KEYS";
  reasons.push(!ARK_KEY ? "ARK_API_KEY is not set" : "no endpoint id: set ARK_MODEL_WRITER");
  step("credentials", false, reasons[0]);
  finish(78);
}
step("credentials", true, `${ARK_KEY.length} key chars, model ${MODEL}`);

const { ask, usageToday } = await import("./lib-llm.mjs");
const usageAfter = usageToday;
spentBefore = usageToday();

/* ── the queue ────────────────────────────────────────────────────────────────────────────────── */

const queue = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
const topics = Array.isArray(queue.topics) ? queue.topics : [];
const published = new Set(
  (existsSync(GUIDE_DIR) ? readdirSync(GUIDE_DIR) : []).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, "")),
);

let candidates = topics.filter((t) => !published.has(t.slug) && t.status !== "done");
if (WANT) candidates = candidates.filter((t) => t.slug === WANT);

if (!candidates.length) {
  verdict = "NO-SUBJECT";
  reasons.push("Every queued topic is published or marked done. Add a topic to data/guide-queue.json.");
  step("queue", true, "empty");
  finish(0);
}
step("queue", true, `${candidates.length} candidate(s)`);

/* ── fetching: the same fetcher the trade line uses ──────────────────────────────────────────────
 *
 * tools/store-source.mjs is not reimplemented here. It is the repository's one way of getting a page
 * onto disk: it follows redirects, retries, decodes by the charset the page declares, archives under
 * data/sources and prints the path it wrote. The trade line has used it for every source since the
 * beginning, and the first version of this file ignored it and fetched with curl - which is why every
 * ministry page arrived as UTF-8-decoded GB2312 and the extraction step kept returning nothing.
 */

const SRCFILE = join(ROOT, "tools", "store-source.mjs");

/** Decode a buffer by the charset the document declares, falling back through gb18030. */
function decodeHtml(buf) {
  const head = buf.subarray(0, 4096).toString("latin1");
  const declared = (/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1] ?? "").toLowerCase();
  const candidates = [declared, "utf-8", "gb18030", "gbk"].filter(Boolean);
  let best = null;
  let bestBad = Infinity;
  for (const enc of candidates) {
    let text;
    try {
      text = new TextDecoder(enc, { fatal: false }).decode(buf);
    } catch {
      continue;
    }
    const bad = (text.match(/\uFFFD/g) ?? []).length;
    if (bad < bestBad) {
      best = text;
      bestBad = bad;
    }
    if (bad === 0) break;
  }
  return best ?? buf.toString("latin1");
}

const stripTags = (html) =>
  String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

/** Fetch one URL through store-source, and read back the decoded text. Never throws. */
function fetchSource(url, label) {
  let out = "";
  try {
    out = execFileSync(process.execPath, [SRCFILE, `--url=${url}`, `--label=${label}`], {
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (e) {
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  const ok = /^\s+ok\s/m.test(out);
  const file = /archived: (\S+)/.exec(out)?.[1] ?? null;
  if (!ok || !file) return { url, ok: false, text: "", html: "" };
  try {
    const buf = readFileSync(join(ROOT, file));
    const html = decodeHtml(buf);
    return { url, ok: true, file, html, text: stripTags(html) };
  } catch {
    return { url, ok: false, text: "", html: "" };
  }
}

/**
 * The second hop: an index page is a table of contents, not a document.
 *
 * Same shape test the trade line uses - four or more consecutive digits in the path, and deeper than
 * the index. A navigation link has neither, so this needs no per-site pattern.
 */
function articleLinks(html, base, limit = 3) {
  const out = [];
  const seen = new Set();
  const basePath = (() => {
    try {
      return new URL(base).pathname;
    } catch {
      return "/";
    }
  })();
  for (const m of String(html).matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    let abs;
    try {
      abs = new URL(m[1], base);
    } catch {
      continue;
    }
    if (!/^https?:/.test(abs.href)) continue;
    if (!/\d{4,}/.test(abs.pathname)) continue;
    if (abs.pathname === basePath) continue;
    if (seen.has(abs.href)) continue;
    seen.add(abs.href);
    out.push(abs.href);
    if (out.length >= limit) break;
  }
  return out;
}

/* ── grounding: figures the pages actually state ──────────────────────────────────────────────── */

async function ground(topic) {
  const seeds = topic.sources ?? [];
  const fetched = [];
  for (const url of seeds) {
    const r = fetchSource(url, `guide-${topic.slug}`);
    log(`  ${r.ok ? "ok  " : "skip"} source ${url.slice(0, 62)}${r.ok ? `  ${r.text.length} chars` : ""}`);
    if (r.ok) fetched.push(r);
  }

  /* Listings are not documents. Take up to two article links per fetched listing. */
  for (const f of [...fetched]) {
    if (fetched.length >= 5) break;
    for (const link of articleLinks(f.html, f.url, 2)) {
      if (fetched.length >= 5) break;
      const r = fetchSource(link, `guide-${topic.slug}`);
      log(`  ${r.ok ? "ok  " : "skip"} article ${link.slice(0, 61)}${r.ok ? `  ${r.text.length} chars` : ""}`);
      if (r.ok) fetched.push(r);
    }
  }

  const usable = fetched.filter((p) => p.text.length > 400);
  if (!usable.length) {
    return { facts: [], error: "every source failed or returned under 400 characters of text" };
  }

  const corpus = usable
    .slice(0, 2)
    .map((p, i) => `[${i + 1}] ${p.url}\n${p.text.slice(0, 6000)}`)
    .join("\n\n");

  const extracted = await ask({
    role: "writer",
    temperature: 0,
    maxTokens: 2000,
    system: [
      "You extract facts from supplied web pages. You never use outside knowledge.",
      "A fact is a fee, a time limit, a duration, a count of countries or ports, or a processing time",
      "written explicitly in the text.",
      "",
      "For each fact return the exact sentence or clause that states it, copied character for character",
      "from the page. If you cannot copy a verbatim quote, do not return the fact.",
      "A page that is only navigation or a list of headlines contains no facts.",
      "Return an empty array when the pages contain nothing usable.",
    ].join("\n"),
    messages: [
      {
        role: "user",
        content: [
          `Topic: ${topic.title}`,
          `Looking for: ${(topic.fetchKeywords ?? []).join(", ")}`,
          "",
          "PAGES:",
          corpus,
          "",
          'Return JSON only: {"facts":[{"value":"144","unit":"hours","period":"maximum stay","quote":"verbatim text from the page","source":1}]}',
          "`source` is the [number] of the page the quote came from. At most 8 facts.",
        ].join("\n"),
      },
    ],
  });
  usage.calls += 1;
  if (!extracted?.ok) {
    usage.failed += 1;
    return { facts: [], error: String(extracted?.error ?? "no reply").slice(0, 120) };
  }

  const raw = String(extracted.text ?? "");
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)?.[1];
  let parsed = null;
  for (const c of [fenced, raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)]) {
    if (!c) continue;
    try {
      const o = JSON.parse(c);
      if (o && Array.isArray(o.facts)) {
        parsed = o;
        break;
      }
    } catch {
      /* next shape */
    }
  }
  if (!parsed) return { facts: [], error: "no JSON in the extraction reply" };

  /*
   * The quote check. A fact survives only if the text it claims to quote is really on the page -
   * whitespace-normalised, because the model copies a line the browser would have collapsed. Anything
   * else is dropped, and the run reports how many.
   */
  const kept = [];
  let dropped = 0;
  for (const f of parsed.facts.slice(0, 8)) {
    const page = usable[Number(f.source) - 1];
    if (!page) {
      dropped++;
      continue;
    }
    const q = String(f.quote ?? "").replace(/\s+/g, " ").trim();
    if (q.length < 8 || !page.text.replace(/\s+/g, " ").includes(q)) {
      dropped++;
      continue;
    }
    if (!String(f.value ?? "").trim()) {
      dropped++;
      continue;
    }
    kept.push({
      value: String(f.value).trim(),
      unit: String(f.unit ?? "").trim(),
      period: String(f.period ?? "").trim() || q.slice(0, 120),
      source: `${new URL(page.url).host} — ${q.slice(0, 90)}`,
      url: page.url,
      quote: q,
    });
  }
  log(`  extracted : ${kept.length} kept, ${dropped} dropped on the quote check`);
  return { facts: kept, dropped };
}


/* ── one attempt at one topic ────────────────────────────────────────────────────────────────── */

const ASTRO_BIN = [
  join(ROOT, "node_modules", "astro", "bin", "astro.mjs"),
  join(ROOT, "node_modules", "astro", "astro.js"),
].find((p) => existsSync(p));

function buildSite() {
  if (!ASTRO_BIN) return { status: 1, stderr: "astro CLI not found" };
  return spawnSync(process.execPath, [ASTRO_BIN, "build"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

const pad = (n) => String(n).padStart(2, "0");
const plusDays = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
const digitsIn = (s) => new Set(String(s).match(/\d+/g) ?? []);

function pickJson(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  for (const c of [fenced, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)]) {
    if (!c) continue;
    try {
      const o = JSON.parse(c);
      if (o && typeof o === "object") return o;
    } catch { /* next */ }
  }
  return null;
}

async function attempt(topic) {
  log("");
  log(`  ── ${topic.slug}`);

  /* 1. grounding */
  let facts = topic.facts ?? [];
  if (!facts.length) {
    const g = await ground(topic);
    facts = g.facts;
    if (!facts.length) {
      topic.status = "no-grounding";
      return { ok: false, why: `no figure survived the quote check${g.error ? ` (${g.error})` : ""}` };
    }
  }

  /*
   * Market prices are a different claim from a published fee, and they are allowed to be published only
   * as what they are: an estimate across at least three independent sources, dated.
   */
  let factSheet = facts;
  if (topic.marketPrice) {
    const hosts = new Set(facts.map((f) => (f.url ? new URL(f.url).host : f.source)).filter(Boolean));
    if (hosts.size < 3) {
      return { ok: false, why: `market topic needs 3 independent sources, found ${hosts.size}` };
    }
    factSheet = facts.slice(0, 6).map((f) => ({
      ...f,
      source: `Market estimate based on ${hosts.size} sources as of ${DAY.slice(0, 7)}`,
    }));
  }

  step(`grounding ${topic.slug}`, true, `${factSheet.length} figure(s)`);

  /* 2. the guide itself */
  const SYSTEM = [
    "You are a long-term foreign resident of China writing for people who have just arrived or are about to.",
    "You write plain, concrete English for someone making a decision that costs them money or time.",
    "",
    "HARD RULES:",
    "1. Use ONLY the figures in the supplied fact sheet. Do not invent, round, estimate or recall any",
    "   other number. If a section would need a figure you were not given, write it without one.",
    "2. Never call this legal, tax or immigration advice.",
    "3. No marketing language. No exclamation marks.",
    "4. Every step is an action the reader performs, in the order they perform it.",
  ].join("\n");

  const USER = [
    `Guide slug: ${topic.slug}`,
    `Topic: ${topic.title}`,
    `Reader: ${(topic.audience ?? []).join(", ")}`,
    `Unit this guide prices: ${topic.unit}`,
    "",
    "FACT SHEET (the only numbers you may use):",
    JSON.stringify(factSheet.map((f) => ({ value: f.value, unit: f.unit, period: f.period, source: f.source })), null, 2),
    "",
    "You MUST make these points:",
    ...(topic.mustSay ?? []).map((m) => `- ${m}`),
    "",
    "You MUST NOT:",
    ...(topic.avoid ?? []).map((m) => `- ${m}`),
    "",
    `Today's date is ${DAY}.`,
    "",
    "Return ONE JSON object and nothing else:",
    "{",
    '  "title": "under 45 characters, names the thing and the consequence",',
    '  "description": "under 150 characters, what the reader gets",',
    '  "intro": "2-3 sentences, no heading",',
    '  "sections": [{"h2": "heading", "paragraphs": ["..."]}],',
    '  "steps": [{"action": "short imperative", "detail": "one sentence"}]',
    "}",
    "Three to five sections. Five to eight steps.",
  ].join("\n");

  const reply = await ask({ role: "writer", system: SYSTEM, messages: [{ role: "user", content: USER }], temperature: 0.3, maxTokens: 4000 });
  usage.calls += 1;
  if (!reply?.ok) {
    usage.failed += 1;
    return { ok: false, why: `model failed: ${String(reply?.error ?? "").slice(0, 120)}` };
  }

  const body = pickJson(reply.text ?? "");
  if (!body) return { ok: false, why: "the model returned no JSON object" };

  if (typeof body.title !== "string" || !body.title.trim()) return { ok: false, why: "no title" };
  if (body.title.length > 45) return { ok: false, why: `title is ${body.title.length} chars, over 45` };
  if (typeof body.description !== "string" || body.description.length > 150) return { ok: false, why: "description over 150 chars" };
  if (!Array.isArray(body.steps) || body.steps.length < 5) return { ok: false, why: `needs 5 steps, got ${body.steps?.length ?? 0}` };
  if (!Array.isArray(body.sections) || body.sections.length < 3) return { ok: false, why: `needs 3 sections, got ${body.sections?.length ?? 0}` };

  const allowed = new Set();
  for (const f of factSheet) for (const d of digitsIn(f.value)) allowed.add(d);
  for (const d of digitsIn(DAY)) allowed.add(d); /* the verification date is not a policy claim */

  const prose = [
    body.title, body.description, body.intro,
    ...(body.sections ?? []).flatMap((s) => [s.h2, ...(s.paragraphs ?? [])]),
    ...(body.steps ?? []).flatMap((s) => [s.action, s.detail]),
  ].join(" ");
  const stray = [...digitsIn(prose)].filter((d) => !allowed.has(d));
  if (stray.length) return { ok: false, why: `prose uses numbers not in the fact sheet: ${stray.join(", ")}` };

  step(`gates ${topic.slug}`, true, "structure and every number traces to a quote");

  /* 3. assemble — the model never writes frontmatter */
  const fm = [
    "---",
    `title: ${JSON.stringify(body.title.trim())}`,
    `description: ${JSON.stringify(body.description.trim())}`,
    `topic: ${JSON.stringify(topic.topic)}`,
    `audience: [${(topic.audience ?? []).map((a) => JSON.stringify(a)).join(", ")}]`,
    `unit: ${JSON.stringify(topic.unit)}`,
    `lastVerified: ${JSON.stringify(DAY)}`,
    `reviewBy: ${JSON.stringify(plusDays(DAY, 180))}`,
    "figures:",
    ...factSheet.flatMap((f) => [
      `  - value: ${JSON.stringify(String(f.value))}`,
      `    unit: ${JSON.stringify(String(f.unit ?? ""))}`,
      `    period: ${JSON.stringify(String(f.period ?? ""))}`,
      `    source: ${JSON.stringify(String(f.source ?? ""))}`,
      `    retrieved: ${JSON.stringify(DAY)}`,
    ]),
    "steps:",
    ...(body.steps ?? []).flatMap((s) => [
      `  - action: ${JSON.stringify(String(s.action ?? "").trim())}`,
      `    detail: ${JSON.stringify(String(s.detail ?? "").trim())}`,
    ]),
    'persona: "old-china-hand"',
    "---",
    "",
  ].join("\n");

  const markdown = fm + [
    String(body.intro ?? "").trim(),
    "",
    ...(body.sections ?? []).flatMap((s) => [`## ${String(s.h2 ?? "").trim()}`, "", ...(s.paragraphs ?? []).map((p) => String(p).trim()).filter(Boolean), ""]),
    "## Confirm before you act",
    "",
    `Fees and processing times change. This page was checked on ${DAY}; confirm the current rule with the authority named in each source above before you rely on a deadline.`,
    "",
  ].join("\n");

  if (DRY) {
    log("\n" + "-".repeat(84));
    log(markdown);
    return { ok: true, dry: true, slug: topic.slug };
  }

  mkdirSync(DRAFT_DIR, { recursive: true });
  writeFileSync(join(DRAFT_DIR, `${topic.slug}.md`), markdown, "utf8");

  mkdirSync(GUIDE_DIR, { recursive: true });
  const target = join(GUIDE_DIR, `${topic.slug}.md`);
  writeFileSync(target, markdown, "utf8");

  const b = buildSite();
  if (b.status !== 0) {
    rmSync(target, { force: true });
    const tail = String(b.stderr ?? b.stdout ?? "").trim().split("\n").slice(-5).join(" | ");
    return { ok: false, why: `astro build failed with the guide in place, removed: ${tail.slice(0, 200)}` };
  }
  step(`build ${topic.slug}`, true, "site builds with the guide in place");

  topic.status = "done";
  topic.doneAt = DAY;
  writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2) + "\n", "utf8");
  return { ok: true, slug: topic.slug };
}

/* ── try topics until one publishes ──────────────────────────────────────────────────────────── */

let succeeded = null;
for (const topic of candidates.slice(0, MAX_TOPICS)) {
  const r = await attempt(topic);
  if (r.ok) {
    succeeded = r;
    break;
  }
  reasons.push(`${topic.slug}: ${r.why}`);
  step(`skipped ${topic.slug}`, false, r.why.slice(0, 140));
}

if (!succeeded) {
  verdict = "NO-SUBJECT";
  if (!reasons.length) reasons.push("no candidate was attempted");
  finish(0);
}

article = succeeded.slug;
verdict = succeeded.dry ? "DRY-RUN" : "PUBLISHED";
step("published", true, `/guide/${succeeded.slug}/`);
finish(0);
