#!/usr/bin/env node
/**
 * The C line: guides for people moving to, working in or visiting China.
 *
 * ## What it is
 *
 * A third publishing route that shares this repository but not its content collection. `/blog/` is
 * written by the trade pipeline and answers "what does this policy cost per unit". `/guide/` answers
 * "what does this cost me, what does it take, and when was that checked" - a month, an application, a
 * move. Same standard, different unit.
 *
 *   node tools/c-line-orchestrator.mjs              # one guide, or a reason why not
 *   node tools/c-line-orchestrator.mjs --dry-run    # propose and print, touch nothing
 *   node tools/c-line-orchestrator.mjs --slug=<s>   # a specific queued topic
 *
 * ## Three rules this file is built around
 *
 * 1. IT MUST NOT BREAK THE SITE. The one shared failure mode between this line and the trade line is
 *    `astro build`: one invalid entry fails the whole build and freezes every page. So nothing is
 *    written into src/content/guide/ until it has passed its own gates AND the site has built with it
 *    in place. A failure there removes the file and leaves the repository exactly as it was found.
 *
 * 2. THE MODEL DOES NOT INVENT NUMBERS. The queue carries a fact sheet - value, unit, period, named
 *    source - and the prompt is allowed to use those figures and nothing else. Every digit in the
 *    finished prose is checked against the sheet before anything is written. A guide whose numbers do
 *    not trace back to the sheet is rejected, not softened.
 *
 * 3. THE MODEL DOES NOT FORMAT FRONTMATTER. It returns a JSON body; this file assembles the markdown
 *    and writes every field itself with JSON.stringify. That is why a guide cannot reproduce the
 *    2026-10-21 outage, where an unquoted date in a model-written header failed the whole build.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { getWithRetry, loadEnv, today } from "./lib/gsc.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const QUEUE_FILE = join(ROOT, "data", "guide-queue.json");
const DRAFT_DIR = join(ROOT, "data", "drafts-c");
const GUIDE_DIR = join(ROOT, "src", "content", "guide");
const RUN_DIR = join(ROOT, "data", "runs");
const SOURCE_DIR = join(ROOT, "data", "sources");

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const WANT = (args.find((a) => a.startsWith("--slug=")) ?? "").slice("--slug=".length).trim();

const STARTED = Date.now();
const log = (s) => console.log(s);

/* ── the run record, written whatever happens ──────────────────────────────────────────────────── */

const steps = [];
const step = (name, ok, detail = "") => {
  steps.push({ name, ok, detail });
  log(`  ${ok ? "ok  " : "FAIL"} ${name}${detail ? "  " + detail : ""}`);
};

let verdict = "NO-SUBJECT";
let article = "";
let reasons = [];
const usage = { calls: 0, failed: 0, usd: 0 };

function finish(code = 0) {
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
  /* data/runs is what tools/feishu-run-ledger.mjs reads; a run that wrote no row would be a run the
     operator cannot see. The file name carries the route so the ledger and the guard can tell them apart. */
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

log(`C LINE  ${new Date().toISOString()}${DRY ? "  (dry run)" : ""}`);
log("=".repeat(84));

if (!ARK_KEY) {
  verdict = "NO-KEYS";
  reasons.push("ARK_API_KEY is not set, so no guide can be written.");
  step("credentials", false, "ARK_API_KEY missing");
  finish(78);
}
if (!MODEL) {
  verdict = "NO-KEYS";
  reasons.push("No endpoint id: set ARK_MODEL_WRITER (or DUBAOTUILI12345) to the ep-... id.");
  step("credentials", false, "endpoint id missing");
  finish(78);
}
step("credentials", true, `${ARK_KEY.length} key chars, model ${MODEL}`);

/* ── pick a topic ─────────────────────────────────────────────────────────────────────────────── */

const queue = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));
const topics = Array.isArray(queue.topics) ? queue.topics : [];
const taken = new Set(
  (existsSync(GUIDE_DIR) ? readdirSync(GUIDE_DIR) : [])
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, "")),
);

const candidates = topics.filter((t) => !taken.has(t.slug) && t.status !== "done");
const picked = WANT ? candidates.find((t) => t.slug === WANT) : candidates.find((t) => t.ready === true);

if (WANT && !picked) {
  verdict = "NO-SUBJECT";
  reasons.push(`--slug=${WANT} is not in the queue, already published, or already done.`);
  finish(1);
}
if (!picked) {
  /*
   * No ready topic. This is the normal state once the seeded fact sheets are used up, and it is a
   * design choice rather than a failure: a guide without an authored fact sheet is a guide whose
   * numbers came from the model, which is the one thing this line will not publish.
   */
  const waiting = candidates.filter((t) => t.ready !== true).length;
  verdict = "NO-SUBJECT";
  reasons.push(
    `No queued topic has an authored fact sheet (${waiting} waiting). The C line does not write numbers it was not given.`,
  );
  step("queue", true, "nothing ready");
  finish(0);
}

const topic = picked;
log(`  topic  : ${topic.slug}  (${topic.topic})`);
step("topic", true, topic.slug);

/* ── fetch and archive the sources ───────────────────────────────────────────────────────────── */

const day = today();
mkdirSync(join(SOURCE_DIR, day), { recursive: true });
const fetched = [];
for (const url of topic.sources ?? []) {
  try {
    const r = getWithRetry(url, { accept: "text/html", retries: 2 });
    fetched.push({ url, status: r.status, bytes: r.body.length });
    writeFileSync(join(SOURCE_DIR, day, `c-${topic.slug}-${fetched.length}.html`), r.body, "utf8");
  } catch (e) {
    fetched.push({ url, status: 0, bytes: 0, error: String(e.message).slice(0, 80) });
  }
}
const okFetches = fetched.filter((f) => f.bytes > 0).length;
step("sources", okFetches > 0, `${okFetches}/${fetched.length} fetched`);

/* A guide grounded in nothing is a guide written from the model's memory, which is exactly what the
   fact sheet exists to prevent. If no source loaded, stop before the model is called. */
if (okFetches === 0 && (topic.facts ?? []).length === 0) {
  verdict = "NO-SOURCE";
  reasons.push("Every source failed and the topic has no fact sheet, so there is nothing to write from.");
  step("grounding", false, "no source, no facts");
  finish(1);
}

/* ── the model ───────────────────────────────────────────────────────────────────────────────── */

const { ask, usageToday } = await import("./lib-llm.mjs");
const spentBefore = usageToday();

const SYSTEM = [
  "You are a long-term foreign resident of China writing for people who have just arrived or are about to.",
  "You write plain, concrete English for someone making a decision that costs them money or time.",
  "",
  "HARD RULES:",
  "1. Use ONLY the figures in the supplied fact sheet. Do not invent, round, estimate or recall any",
  "   other number. If a section would need a figure you were not given, write the section without one.",
  "2. Never call this legal, tax or immigration advice.",
  "3. No marketing language. No exclamation marks. No 'in today's fast-paced world'.",
  "4. British spelling is fine; be consistent.",
  "5. Every step is an action the reader performs, in the order they perform it.",
].join("\n");

const factsForPrompt = (topic.facts ?? []).map((f) => ({
  value: f.value,
  unit: f.unit,
  period: f.period,
  source: f.source,
  note: f.note ?? "",
}));

const USER = [
  `Guide slug: ${topic.slug}`,
  `Topic: ${topic.title}`,
  `Reader: ${(topic.audience ?? []).join(", ")}`,
  `Unit this guide prices: ${topic.unit}`,
  "",
  "FACT SHEET (the only numbers you may use):",
  JSON.stringify(factsForPrompt, null, 2),
  "",
  "You MUST make these points:",
  ...(topic.mustSay ?? []).map((m) => `- ${m}`),
  "",
  "You MUST NOT:",
  ...(topic.avoid ?? []).map((m) => `- ${m}`),
  "",
  `Today's date is ${day}. Write as of that date.`,
  "",
  "Return ONE JSON object and nothing else:",
  "{",
  '  "title": "under 45 characters, names the thing and the consequence",',
  '  "description": "under 150 characters, what the reader gets",',
  '  "intro": "2-3 sentences, no heading",',
  '  "sections": [{"h2": "heading", "paragraphs": ["...", "..."]}],',
  '  "steps": [{"action": "short imperative", "detail": "one sentence"}]',
  "}",
  "Three to five sections. Five to eight steps.",
].join("\n");

function digitsIn(s) {
  return new Set(String(s).match(/\d+/g) ?? []);
}

let reply;
try {
  reply = await ask({ role: "writer", system: SYSTEM, messages: [{ role: "user", content: USER }], temperature: 0.3, maxTokens: 4000 });
} catch (e) {
  reply = { ok: false, error: e.message };
}
usage.calls += 1;
if (!reply?.ok) {
  usage.failed += 1;
  verdict = "WRITE-FAILED";
  reasons.push(`model call failed: ${String(reply?.error ?? "unknown").slice(0, 200)}`);
  step("model", false, String(reply?.error ?? "").slice(0, 120));
  finish(1);
}
usage.usd = Math.max(0, Number((usageToday().usd ?? 0) - (spentBefore.usd ?? 0)));
step("model", true, `${String(reply.text ?? "").length} chars`);

/* ── parse and validate the reply ─────────────────────────────────────────────────────────────── */

function pickJson(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  for (const c of [fenced, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)]) {
    if (!c) continue;
    try {
      const o = JSON.parse(c);
      if (o && typeof o === "object") return o;
    } catch { /* next shape */ }
  }
  return null;
}

const body = pickJson(reply.text ?? "");
if (!body) {
  verdict = "WRITE-FAILED";
  reasons.push("the model returned no JSON object");
  step("parse", false, "no JSON");
  finish(1);
}
step("parse", true);

const fail = (why) => {
  verdict = "REJECTED";
  reasons.push(why);
  step("gates", false, why);
  if (DRY) {
    log("\n  the reply, so the gate can be debugged:");
    log(JSON.stringify(body, null, 2));
  }
  finish(1);
};

/* G1 - structure */
if (typeof body.title !== "string" || !body.title.trim()) fail("no title");
if (body.title.length > 45) fail(`title is ${body.title.length} chars, over the 45 that fit in a <title> once the site name is appended`);
if (typeof body.description !== "string" || body.description.length > 150) fail("description missing or over 150 chars");
if (!Array.isArray(body.steps) || body.steps.length < 5) fail(`needs at least 5 steps, got ${body.steps?.length ?? 0}`);
if (!Array.isArray(body.sections) || body.sections.length < 3) fail(`needs at least 3 sections, got ${body.sections?.length ?? 0}`);

/* G2 - every digit in the prose must trace to the fact sheet */
const allowed = new Set();
for (const f of topic.facts ?? []) for (const d of digitsIn(f.value)) allowed.add(d);
/*
 * The date is not a factual claim about the policy, so its digits are allowed. Without this the gate
 * rejects "as of 22 October 2026" - which is the one date the guide is required to state.
 */
for (const d of digitsIn(day)) allowed.add(d);
const proseText = [
  body.title, body.description, body.intro,
  ...(body.sections ?? []).flatMap((s) => [s.h2, ...(s.paragraphs ?? [])]),
  ...(body.steps ?? []).flatMap((s) => [s.action, s.detail]),
].join(" ");
const stray = [...digitsIn(proseText)].filter((d) => !allowed.has(d));
if (stray.length) {
  const where = stray.map((d) => {
    const i = proseText.indexOf(d);
    return `${d} in "...${proseText.slice(Math.max(0, i - 45), i + 25).trim()}..."`;
  });
  fail(`the prose contains numbers that are not in the fact sheet: ${where.join(" | ")}`);
}
step("gates", true, "structure and every number traces to the fact sheet");

/* ── assemble the markdown ───────────────────────────────────────────────────────────────────── */

const pad = (n) => String(n).padStart(2, "0");
const plusDays = (iso, n) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

/* Written by this file, never by the model, and every string goes through JSON.stringify so a quote
   can never produce an unquoted YAML scalar. */
const fm = [
  "---",
  `title: ${JSON.stringify(body.title.trim())}`,
  `description: ${JSON.stringify(body.description.trim())}`,
  `topic: ${JSON.stringify(topic.topic)}`,
  `audience: [${(topic.audience ?? []).map((a) => JSON.stringify(a)).join(", ")}]`,
  `unit: ${JSON.stringify(topic.unit)}`,
  `lastVerified: ${JSON.stringify(day)}`,
  `reviewBy: ${JSON.stringify(plusDays(day, 180))}`,
  "figures:",
  ...(topic.facts ?? []).flatMap((f) => [
    `  - value: ${JSON.stringify(String(f.value))}`,
    `    unit: ${JSON.stringify(String(f.unit ?? ""))}`,
    `    period: ${JSON.stringify(String(f.period ?? ""))}`,
    `    source: ${JSON.stringify(String(f.source ?? ""))}`,
    `    retrieved: ${JSON.stringify(day)}`,
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

const prose = [
  String(body.intro ?? "").trim(),
  "",
  ...(body.sections ?? []).flatMap((s) => [
    `## ${String(s.h2 ?? "").trim()}`,
    "",
    ...(s.paragraphs ?? []).map((p) => String(p).trim()).filter(Boolean),
    "",
  ]),
  "## Confirm before you act",
  "",
  `Fees, eligible ports and processing times change. This page was checked on ${day}; confirm the current rule with the authority named in each source above before you rely on a deadline.`,
  "",
].join("\n");

const markdown = fm + prose;

if (DRY) {
  log("\n" + "-".repeat(84));
  log(markdown);
  verdict = "DRY-RUN";
  step("dry-run", true, `${markdown.length} chars, nothing written`);
  finish(0);
}

/* ── gate 3: land outside the collection, then prove the site still builds ────────────────────── */

mkdirSync(DRAFT_DIR, { recursive: true });
const draftPath = join(DRAFT_DIR, `${topic.slug}.md`);
writeFileSync(draftPath, markdown, "utf8");
step("draft", true, draftPath.replace(ROOT, "").replace(/\\/g, "/"));

mkdirSync(GUIDE_DIR, { recursive: true });
const target = join(GUIDE_DIR, `${topic.slug}.md`);
writeFileSync(target, markdown, "utf8");

/* Astro's CLI moved from astro.js to bin/astro.mjs; resolve which one this install has rather than
   assuming, because the failure mode is a MODULE_NOT_FOUND that reads like a content error. */
const ASTRO_BIN = [
  join(ROOT, "node_modules", "astro", "bin", "astro.mjs"),
  join(ROOT, "node_modules", "astro", "astro.js"),
].find((p) => existsSync(p));

if (!ASTRO_BIN) {
  verdict = "REJECTED";
  reasons.push("could not find the astro CLI, so the guide cannot be verified against a real build");
  rmSync(target, { force: true });
  step("build", false, "astro CLI not found");
  finish(1);
}

const build = spawnSync(process.execPath, [ASTRO_BIN, "build"], {
  cwd: ROOT,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
});

if (build.status !== 0) {
  /*
   * Remove the file and leave the tree exactly as it was. The site keeps building; tomorrow's run of
   * any line is unaffected. This is the whole reason the C line exists as a separate entry point.
   */
  rmSync(target, { force: true });
  const tail = String(build.stderr ?? build.stdout ?? "").trim().split("\n").slice(-6).join(" | ");
  verdict = "REJECTED";
  reasons.push(`astro build failed with the guide in place, file removed: ${tail.slice(0, 300)}`);
  step("build", false, tail.slice(0, 160));
  finish(1);
}
step("build", true, "site builds with the guide in place");

article = topic.slug;
topic.status = "done";
topic.doneAt = day;
writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2) + "\n", "utf8");
verdict = "PUBLISHED";
step("published", true, `/guide/${topic.slug}/`);
finish(0);
