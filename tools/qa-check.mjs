/**
 * Pre-publish QA gate — the machine half of spec v1.3 §9.1.
 *
 * This exists because the human review step was removed. Every rule that a
 * machine can decide is decided here, and a blocking failure means the piece
 * does not get published.
 *
 * Run:  node tools/qa-check.mjs src/content/blog/<slug>.md
 *       node tools/qa-check.mjs --all
 *
 * Exit code is non-zero when any blocking rule fails.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const BANNED_VAGUE = [
  "may", "might", "possibly", "perhaps", "could", "reportedly", "allegedly",
  "arguably", "seemingly", "somewhat", "fairly", "quite possibly",
];

const BANNED_CLICHE = [
  "in today's fast-paced world", "in the ever-evolving", "delve into", "delve",
  "landscape of", "it's important to note", "it is important to note",
  "unlock the secrets", "game-changer", "game changer", "navigate the complexities",
  "tapestry", "testament to", "when it comes to", "at the end of the day",
  "in conclusion", "let's dive in", "buckle up",
];

const BANNED_SENSITIVE = [
  "taiwan independence", "south china sea ruling", "uyghur", "xinjiang camps",
  "tiananmen", "tibet independence", "hong kong independence",
];

const SECTIONS = [
  "What happened", "Why now", "So what", "For you", "The data point",
];

const wordCount = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);

function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  if (!m) return { fm: "", body: raw };
  return { fm: m[1], body: raw.slice(m[0].length) };
}

function check(file) {
  const raw = readFileSync(file, "utf8");
  const { fm, body } = parseFrontmatter(raw);
  const results = [];
  const add = (level, rule, detail) =>
    results.push({ level, rule, detail });

  const fmLine = (key) => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(fm)?.[1]?.trim();

  // ---- frontmatter-driven rules -------------------------------------
  const figures = (fm.match(/^\s*- value:/gm) || []).length;
  const sources = (fm.match(/^\s{2}- "/gm) || []).length;
  const gain = fmLine("information_gain");
  const keyword = fmLine("target_keyword");
  const audience = fmLine("audience");
  const isDraft = /^draft:\s*true/m.test(fm);

  if (figures >= 5) add("pass", "figures >= 5", `${figures} figures recorded`);
  else add("block", "figures >= 5", `only ${figures} figures in frontmatter`);

  const figureBlocks = fm.split(/^\s*- value:/m).slice(1);
  const incomplete = figureBlocks.filter(
    (b) => !/unit:/.test(b) || !/period:/.test(b) || !/source:/.test(b) || !/retrieved:/.test(b),
  ).length;
  if (figureBlocks.length === 0) add("block", "figure five-part records", "no figures[] entries");
  else if (incomplete === 0) add("pass", "figure five-part records", `${figureBlocks.length}/${figureBlocks.length} complete`);
  else add("block", "figure five-part records", `${incomplete} entries missing unit/period/source/retrieved`);

  if (sources >= 3) add("pass", "named sources >= 3", `${sources} sources`);
  else add("warn", "named sources >= 3", `${sources} sources`);

  gain ? add("pass", "information_gain declared", gain) : add("block", "information_gain declared", "missing");
  keyword ? add("pass", "target_keyword declared", keyword) : add("block", "target_keyword declared", "missing");
  audience ? add("pass", "audience declared", audience) : add("warn", "audience declared", "not set (defaults to both)");

  // ---- body structure ------------------------------------------------
  // The AI Summary rule applies to the summary paragraph itself, not to
  // everything up to the next H2 (the hook paragraph follows it).
  const summarySection =
    /##\s*AI Summary\s*\n+([\s\S]*?)(?=\n##\s)/.exec(body + "\n## end")?.[1] ?? "";
  const summary = summarySection.split(/\n\s*\n/).find((p) => p.trim()) ?? "";
  const summaryWords = wordCount(summary);
  if (summaryWords >= 40 && summaryWords <= 60)
    add("pass", "AI summary 40-60 words", `${summaryWords} words`);
  else add("block", "AI summary 40-60 words", `${summaryWords} words`);

  const missing = SECTIONS.filter((s) => !new RegExp(`^##\\s*${s}`, "m").test(body));
  missing.length === 0
    ? add("pass", "V6.1 six sections", "all present (Hook = opening paragraph)")
    : add("block", "V6.1 six sections", `missing: ${missing.join(", ")}`);

  const words = wordCount(body);
  if (words >= 1500 && words <= 2500) add("pass", "body 1500-2500 words", `${words} words`);
  else add("block", "body 1500-2500 words", `${words} words`);

  const faqBlocks = [...body.matchAll(/^###\s+(.+)$/gm)];
  const faqSection = /##\s*FAQ\s*\n([\s\S]*?)(?=\n##\s|$)/.exec(body)?.[1] ?? "";
  const faqQs = (faqSection.match(/^###\s+/gm) || []).length;
  const faqAnswers = faqSection.split(/^###\s+/m).slice(1).map(wordCount);
  const badAnswers = faqAnswers.filter((w) => w < 80 || w > 150).length;
  if (faqQs >= 3 && faqQs <= 5 && badAnswers === 0)
    add("pass", "FAQ 3-5 questions, 80-150 word answers", `${faqQs} questions`);
  else if (faqQs < 3 || faqQs > 5)
    add("block", "FAQ 3-5 questions, 80-150 word answers", `${faqQs} questions`);
  else add("warn", "FAQ answer length", `${badAnswers}/${faqQs} answers outside 80-150 words`);

  const tables = (body.match(/^\|.*\|\s*$/gm) || []).length;
  tables >= 4 ? add("pass", "comparison table present", `${tables} table rows`) : add("block", "comparison table present", `${tables} table rows`);

  const quotes = (body.match(/^>\s+\S/gm) || []).length;
  quotes >= 1 ? add("pass", "definition block present", `${quotes} blockquote(s)`) : add("block", "definition block present", "none");

  const forYou = /##\s*For you\s*\n([\s\S]*?)(?=\n##\s|$)/.exec(body)?.[1] ?? "";
  const segs = (forYou.match(/^\s*-\s+\*\*/gm) || []).length;
  segs >= 3 ? add("pass", "audience segments >= 3", `${segs}`) : add("block", "audience segments >= 3", `${segs}`);

  // ---- language --------------------------------------------------------
  const urls = body.match(/https?:\/\/\S+/g) || [];
  urls.length === 0 ? add("pass", "no URLs in body", "clean") : add("block", "no URLs in body", urls.join(", "));

  // "May" the month is a homograph of "may" the hedge. Months are always
  // capitalised and the hedge is not, so this one word is matched
  // case-sensitively; the rest are case-insensitive.
  const CASE_SENSITIVE = new Set(["may"]);
  const vague = BANNED_VAGUE.filter((w) =>
    new RegExp(`\\b${w}\\b`, CASE_SENSITIVE.has(w) ? "" : "i").test(body),
  );
  vague.length === 0 ? add("pass", "no hedging words", "clean") : add("block", "no hedging words", vague.join(", "));

  const cliche = BANNED_CLICHE.filter((w) => body.toLowerCase().includes(w));
  cliche.length === 0 ? add("pass", "no AI cliches", "clean") : add("block", "no AI cliches", cliche.join(", "));

  const sensitive = BANNED_SENSITIVE.filter((w) => body.toLowerCase().includes(w));
  sensitive.length === 0 ? add("pass", "sensitive-term screen", "clean") : add("block", "sensitive-term screen", sensitive.join(", "));

  if (isDraft) add("warn", "draft flag", "piece is draft: true — will not be published");

  return results;
}

const args = process.argv.slice(2);
let files;
if (args[0] === "--all") {
  const dir = "src/content/blog";
  files = readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => join(dir, f));
} else if (args.length) {
  files = args;
} else {
  console.error("usage: node tools/qa-check.mjs <file.md> | --all");
  process.exit(2);
}

let anyBlocking = false;
for (const file of files) {
  const results = check(file);
  const blocks = results.filter((r) => r.level === "block");
  const warns = results.filter((r) => r.level === "warn");
  const passes = results.filter((r) => r.level === "pass");

  console.log(`\n${file}`);
  console.log(`  ${passes.length} pass · ${warns.length} warn · ${blocks.length} BLOCK`);
  for (const r of blocks) console.log(`  ✗ BLOCK  ${r.rule.padEnd(38)} ${r.detail}`);
  for (const r of warns) console.log(`  ! warn   ${r.rule.padEnd(38)} ${r.detail}`);

  if (blocks.length) anyBlocking = true;
}

console.log(anyBlocking ? "\nRESULT: BLOCKED — fix the blocking rules above.\n" : "\nRESULT: PASS — every blocking rule cleared.\n");
process.exit(anyBlocking ? 1 : 0);
