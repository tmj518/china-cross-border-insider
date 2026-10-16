/**
 * The writer. Turns a directive into a draft article.
 *
 *   node tools/cloud-executor.mjs --directive-file=data/tmp/directive.json
 *   node tools/cloud-executor.mjs --keyword="..." --angle="..."
 *
 * Writes `data/drafts/<slug>.md` and prints a one-line verdict. It does not publish, does not commit,
 * and does not decide whether the article is good - `cloud-qa.mjs` does that, and the gate does the
 * part of it that can be mechanical.
 *
 * ## Why an exemplar rather than a description of the format
 *
 * The structure is fifteen frontmatter fields and ten body sections with rules attached to each: the
 * confidence section's three headings must be exactly `Confirmed.` / `Inferred.` / `What would change
 * my mind.`; there must be at least one blockquote; the FAQ answers run 80 to 150 words; `may` and
 * `could` are blocked outright. Describing that produces something close and wrong. Two published
 * articles are passed in full as the shape to match, with the instruction to follow the form and
 * replace every fact.
 *
 * ## What it refuses to do
 *
 * It will not write a figure it was not given a source for. The directive carries the facts; when the
 * directive carries fewer than the minimum number of figures, this exits with that as the reason
 * rather than letting the model fill the gap from memory. That single refusal is what separates this
 * from a text generator pointed at a keyword, and it is the mechanical half of the rule that a number
 * must be traceable to a document.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { askJson, summary as providerSummary } from "./lib-llm.mjs";

const ROOT = process.cwd();
const BLOG = join(ROOT, "src", "content", "blog");
const MIN_FIGURES = 5;

/**
 * Pull the article out of a model response, accepting two shapes.
 *
 * Asking for JSON does not guarantee getting it. On the first live run Doubao returned the article as
 * plain markdown with no wrapper, and the run failed with WRITE-FAILED while a complete article sat in
 * the response. The article was there; only the envelope was missing, and packaging is the part this
 * code can do for itself.
 *
 *   1. JSON with an `article` key - the shape requested.
 *   2. Raw markdown beginning with frontmatter - what a model produces when it reads the instructions
 *      as a specification rather than a protocol. Detected by a leading `---` followed by a `title:`
 *      within the first block, which is specific enough that prose cannot be mistaken for it.
 *   3. The same markdown inside a code fence, which some models add unprompted.
 *
 * Anything else returns null, and the caller reports what the response actually began with rather than
 * a generic parse error.
 */
export function extractArticle(r, fallbackSlug) {
  if (r?.json?.article) {
    return { article: r.json.article, slug: r.json.slug ?? fallbackSlug, notes: r.json.notes, shape: "json" };
  }
  const raw = String(r?.text ?? "").trim();
  if (!raw) return null;
  const unfenced = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/.exec(raw)?.[1] ?? raw;
  const looksLikeArticle = unfenced.startsWith("---") && /^title:\s/m.test(unfenced.slice(0, 3000));
  if (!looksLikeArticle) return null;
  const title = /^title:\s*"?(.+?)"?\s*$/m.exec(unfenced)?.[1] ?? "";
  return {
    article: unfenced,
    slug: fallbackSlug,
    notes: `unwrapped markdown; title read as "${title.slice(0, 60)}"`,
    shape: "markdown",
  };
}

/** The structure, as a specification the model is asked to satisfy. */
const STRUCTURE = `The article must have this exact shape.

Frontmatter fields, all required: title, subtitle, description, publishDate, reviewBy, stakes,
category, audience, tags, priority, featured, draft, articleNumber, target_keyword, search_intent,
information_gain, sources, figures.

Hard limits that break the build if exceeded - the schema rejects them and every page goes down:
  title          <= 120 characters
  subtitle       <= 160 characters
  description    <= 300 characters

Body sections, in this order and with these exact headings:
  ## AI Summary         60 to 100 words. Conclusion first: what the change is and what it costs whom.
  ## What happened      the precise change, with numbers and the instrument that made it
  ## Why now            the timing, and what moved. Keep this section tight.
  ## So what            the judgement plus the cost arithmetic. This is the most valuable section.
  ## How confident      exactly three paragraphs, each starting with the bold label on its own line:
                          **Confirmed.** ...
                          **Inferred.** ...
                          **What would change my mind.** ...
                        The headings must be those words. Anything else fails the gate.
  ## For you            three or more bullet points, each starting with a bolded audience segment
  ## The data point     one sentence, then a <div class="callout"> containing it
  ## FAQ                exactly 3 questions, each answer between 80 and 150 words
  ## How we calculated this   the arithmetic in a fenced code block
  ## The point          one paragraph

Also required:
  - at least one blockquote line starting with "> " (a definition block for the key term)
  - at least one markdown table, and at least 3 rows of a table carrying an amount
  - at least 3 internal links to other articles, in the form [anchor](/blog/<slug>/)
  - 1,200 to 1,800 words of body prose if the article carries a cost table

Blocked words, case-insensitive, anywhere in the file: may, could.
Note that this catches the month May as well. Write dates as "24 September 2026" and never "May 2026";
if a May date is unavoidable, express it through the instrument number instead.`;

const RULES = `Non-negotiable rules.

1. Use only the figures supplied in the directive. Do not add a number that is not in that list, and
   do not change the value, unit, period, source or retrieved date of one that is.
2. Do not invent a quotation, a person, an experience, or a panel of data. The first person is banned
   entirely: never "I found", "my supplier", "our data". There is no human reviewer and an invented
   experience cannot be caught by any check.
3. "How confident" must separate what a document supports from what you are inferring. If a number
   rests on a single document, say so in the Inferred paragraph. Do not present an inference as fact.
4. Do not write a duty rate, a deadline or an effective date that the directive did not supply.
5. Write in plain declarative sentences. State what happens. Never hedge.
6. The reader is an importer or a foreign merchant, not a lawyer. Give them the number and the action.`;

function parseDirective() {
  const args = process.argv.slice(2);
  const flag = (name, dflt) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : dflt;
  };
  const file = flag("directive-file", null);
  if (file && existsSync(file)) return JSON.parse(readFileSync(file, "utf8"));
  const keyword = flag("keyword", null);
  if (!keyword) return null;
  return {
    slug: flag("slug", keyword.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60)),
    title_idea: flag("title", keyword),
    keyword,
    angle: flag("angle", ""),
    category: flag("category", "trade-policy"),
    audience: flag("audience", "importer"),
    figures: [],
    sources: [],
  };
}

function exemplars(n = 2) {
  const out = [];
  for (const f of readdirSync(BLOG).filter((x) => x.endsWith(".md"))) {
    const t = readFileSync(join(BLOG, f), "utf8");
    if (/^draft:\s*true/m.test(t)) continue;
    if (!/^information_gain:\s*"?custom-calculation/m.test(t)) continue;
    out.push(t);
    if (out.length >= n) break;
  }
  return out;
}

async function main() {
  const directive = parseDirective();
  if (!directive) {
    console.log("usage: node tools/cloud-executor.mjs --directive-file=data/tmp/directive.json");
    console.log("       node tools/cloud-executor.mjs --keyword=... --angle=...");
    process.exit(2);
  }

  const figures = Array.isArray(directive.figures) ? directive.figures : [];
  const sourced = figures.filter((f) => f && f.value && f.source && f.retrieved);
  if (sourced.length < MIN_FIGURES) {
    console.log(`REFUSED - the directive carries ${sourced.length} sourced figure(s), the gate requires ${MIN_FIGURES}.`);
    console.log("");
    console.log("  A writer told to produce an article will produce one, and the numbers it cannot find it");
    console.log("  will invent in the right format. The instruction to this module is therefore that it");
    console.log("  writes only from figures it was handed. Populate the directive first - by reading the");
    console.log("  source documents and archiving them with tools/store-source.mjs - and run this again.");
    console.log("");
    console.log("  Each figure needs all five parts: value, unit, period, source, retrieved.");
    process.exit(3);
  }

  const examples = exemplars();
  const task = `Write one article for Landed Math.

DIRECTIVE
  slug      : ${directive.slug}
  working title : ${directive.title_idea ?? ""}
  target keyword: ${directive.keyword ?? ""}
  category  : ${directive.category ?? "trade-policy"}
  audience  : ${directive.audience ?? "importer"}
  angle     : ${directive.angle ?? ""}

${STRUCTURE}

${RULES}

THE FIGURES - these are the only numbers you may use:
${JSON.stringify(sourced, null, 2)}

THE BIBLIOGRAPHY - cite these, and only these, in the sources field:
${JSON.stringify(directive.sources ?? [], null, 2)}

${examples.length ? `TWO PUBLISHED ARTICLES, for the shape only. Copy the form, the section order, the
tone and the density. Every fact, number and name in them belongs to a different subject and must not
appear in your article.

--- EXEMPLAR 1 ---
${examples[0].slice(0, 9000)}
${examples[1] ? `\n--- EXEMPLAR 2 ---\n${examples[1].slice(0, 9000)}` : ""}` : ""}

Return the complete markdown file including its frontmatter, and nothing else. Do not wrap it in a
code fence and do not add commentary before or after it.`;

  console.log(`EXECUTOR  slug=${directive.slug}`);
  console.log(providerSummary());
  console.log(`  figures handed over : ${sourced.length}`);
  console.log(`  exemplars           : ${examples.length}`);
  console.log("");

  const r = await askJson({
    role: "writer",
    system:
      "You are the writer for Landed Math, an English site that turns Chinese and other official " +
      "primary documents into per-unit cost consequences for importers. You write only from the " +
      "figures you are given. You never invent a number, a source, a quotation or an experience. You " +
      "return the finished markdown file and nothing else.",
    messages: [{ role: "user", content: task }],
    maxTokens: 16384,
  });

  if (!r.ok) {
    console.log(`  FAILED - ${r.error}`);
    if (r.need) console.log(`  needs: ${r.need.join(", ")}`);
    process.exit(1);
  }

  const extracted = extractArticle(r, directive.slug);
  if (!extracted) {
    console.log(`  FAILED - the response was neither JSON with an article nor markdown with frontmatter`);
    if (r.parseError) console.log(`  parse    : ${r.parseError}`);
    console.log(`  response began: ${String(r.text ?? "").slice(0, 300).replace(/\s+/g, " ")}`);
    process.exit(1);
  }

  const outSlug = String(extracted.slug ?? directive.slug).replace(/[^a-z0-9-]/g, "").slice(0, 80);
  mkdirSync(join(ROOT, "data", "drafts"), { recursive: true });
  const outFile = join(ROOT, "data", "drafts", `${outSlug}.md`);
  writeFileSync(outFile, extracted.article, "utf8");

  const words = (extracted.article.split(/\n---\n/)[1] ?? "").split(/\s+/).filter(Boolean).length;
  console.log(`  provider  : ${r.provider} / ${r.model}`);
  console.log(`  shape     : ${extracted.shape}`);
  if (extracted.notes) console.log(`  notes     : ${String(extracted.notes).slice(0, 200)}`);
  console.log(`  tokens    : ${r.usage?.prompt_tokens ?? "?"} in, ${r.usage?.completion_tokens ?? "?"} out`);
  console.log(`  estimated : $${r.estimatedUsd ?? "?"}`);
  console.log(`  written   : ${outFile.replace(/\\/g, "/").replace(ROOT.replace(/\\/g, "/") + "/", "")}`);
  console.log(`  words     : ${words}`);
  console.log("");
  console.log("  Next: node tools/cloud-qa.mjs --draft=" + outFile.replace(/\\/g, "/"));
}

const IS_MAIN = process.argv[1] ? process.argv[1].replace(/\\/g, "/").endsWith("cloud-executor.mjs") : false;
if (IS_MAIN) await main();
