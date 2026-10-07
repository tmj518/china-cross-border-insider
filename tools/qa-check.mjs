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

/**
 * Document identifiers that count as citing a primary source. Kept as
 * recognisable numbering schemes rather than the word "announcement", so a
 * loose mention does not satisfy the rule.
 */
const PRIMARY_DOC_PATTERN = new RegExp(
  [
    "\\b\\d{1,3}\\s?FR\\s?\\d{3,6}\\b", // Federal Register citation
    "\\bHTSUS\\s?9903\\b",
    "\\bAnnouncement\\s+No\\.?\\s?\\d+",
    "\\b公告\\s?\\d+\\s?号",
    "〔\\d{4}〕\\s?\\d+\\s?号", // Chinese document numbering, e.g. 国市监注发〔2026〕5号
    "\\b(?:Periodical|Circular|Order|Decision)\\s+No\\.?\\s?\\(?\\d+",
    "\\bRegulation\\s+\\(EU\\)\\s+\\d{4}/\\d+",
    "\\bCELEX\\b",
    "\\bOJ\\s?L\\s?\\d",
  ].join("|"),
  "i",
);

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

  // ---- encoding integrity -------------------------------------------
  // This rule exists because the damage already happened once. A PowerShell
  // `Get-Content -Raw` / `Set-Content` round trip rewrote an article through
  // the system ANSI codepage (GBK on this machine), and every em dash came
  // back as "?" — U+FFFD's cousin, and invisible in a browser diff.
  //
  // Node's utf8 decoder is lenient: it substitutes U+FFFD for invalid bytes
  // rather than throwing. That makes one check cover both failures — genuinely
  // invalid UTF-8, and text that survived a bad round trip.
  const replacementChars = (raw.match(/\uFFFD/g) || []).length;
  replacementChars === 0
    ? add("pass", "text encoding", "valid UTF-8, no replacement characters")
    : add("block", "text encoding", `${replacementChars} replacement character(s) — file was rewritten through a non-UTF-8 codepage`);

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

  // A claim of primary-source is only credible if the body actually names the
  // document. Check the number, not the word "announcement".
  if (gain && /primary-source/.test(gain)) {
    PRIMARY_DOC_PATTERN.test(body)
      ? add("pass", "primary-source cited", "document identifier present")
      : add("block", "primary-source cited", "declares primary-source but names no document identifier");
  }
  keyword ? add("pass", "target_keyword declared", keyword) : add("block", "target_keyword declared", "missing");
  audience ? add("pass", "audience declared", audience) : add("warn", "audience declared", "not set (defaults to both)");

  // ---- schema string limits -------------------------------------------
  // The collection schema caps title at 120 characters, subtitle at 160 and
  // description at 300. Exceeding one of those does not warn — it throws
  // InvalidContentEntryDataError, which fails the whole build, so the article
  // 404s and nothing else deploys either.
  //
  // Nothing here checked this, and on 2026-10-07 a 163-character subtitle
  // reached main and did exactly that: the site served a stale build for ten
  // minutes while every article except the new one looked fine, because the
  // stale build already contained them. The gap existed because this gate reads
  // markdown as text and the limits live in a Zod schema, so neither side knew
  // about the other.
  //
  // The limits are duplicated here deliberately rather than read from the
  // schema: importing the config would drag Astro's loaders into a plain Node
  // script. If the schema limits change, this list has to change with it, and
  // the comment is the reminder.
  const LIMITS = { title: 120, subtitle: 160, description: 300 };
  const overLong = [];
  for (const [field, limit] of Object.entries(LIMITS)) {
    const raw = fmLine(field);
    // fmLine returns the raw value including quotes for these fields.
    const value = raw ? raw.replace(/^"|"$/g, "") : null;
    if (value && value.length > limit) overLong.push(`${field} ${value.length}/${limit}`);
  }
  if (overLong.length === 0) {
    add("pass", "schema string limits", "title <= 120, subtitle <= 160, description <= 300");
  } else {
    add(
      "block",
      "schema string limits",
      `${overLong.join(", ")} — the Zod schema rejects this and the build fails, taking every page down`,
    );
  }

  // ---- review clock ----------------------------------------------------
  // Every article here is dated and sourced, which is the strength until one of
  // its dates passes. Ten of the first fourteen published pieces carried a
  // future deadline and seven fell inside three months. An article whose central
  // fact has expired is worse than one never written, because it still ranks and
  // still reads as current.
  //
  // `reviewBy` is set by hand, because a date in prose is not necessarily a
  // deadline: article 14 mentions a Commission review due in 2028 as context.
  // Doing that job automatically would produce false positives on prose that
  // merely contains a year. So the gate does not try to compute the date. It
  // requires that a human recorded one, which is the part that gets forgotten.
  //
  // The second check is the cheap cross-check: if the body contains a future
  // date EARLIER than the declared review date, the piece goes stale before
  // anyone plans to look at it.
  const reviewBy = fmLine("reviewBy");
  if (!reviewBy) {
    add("block", "reviewBy declared", "no review date — set it, or the piece expires silently");
  } else {
    const iso = /^\d{4}-\d{2}-\d{2}/.test(reviewBy) ? reviewBy.slice(0, 10) : null;
    if (!iso) {
      add("block", "reviewBy declared", `"${reviewBy}" is not a YYYY-MM-DD date`);
    } else {
      add("pass", "reviewBy declared", iso);
      // Only dates after this article was published are candidates for
      // staleness. An unbounded lower bound flagged every historical date in
      // the prose, which is noise: the 2019 safeguard, the 2022 reference
      // period, the 2024 capacity figure. Those are context, not expiry.
      const published = fmLine("publishDate")?.slice(0, 10) ?? "";
      const earlier = (body.match(/\b20\d\d-\d\d-\d\d\b/g) || [])
        .filter((d) => d > published && d < iso)
        .sort()[0];
      if (earlier) {
        add(
          "warn",
          "reviewBy covers the body dates",
          `body mentions ${earlier}, earlier than reviewBy ${iso} — the piece goes stale sooner than planned`,
        );
      }

      // A `priced` piece states a per-unit money figure, so a reader can act on
      // it directly; letting one sit for years is the failure that costs money.
      // The ceiling is 180 days, which is a generator of reviews rather than a
      // restriction — no current article breaches it. Directional pieces are
      // deliberately unconstrained: being old is not the same as being wrong.
      const stakes = fmLine("stakes") || "directional";
      if (stakes === "priced") {
        const today = new Date();
        const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
        const days = Math.round((Date.parse(iso) - Date.parse(todayIso)) / 86400000);
        if (days > 180) {
          add(
            "warn",
            "priced piece reviewed within 180 days",
            `reviewBy is ${days} days out; a piece stating a per-unit cost should be rechecked sooner`,
          );
        }
      }
    }
  }

  // ---- revision records ------------------------------------------------
  // `revisions` is the visible half of the review clock: what actually changed
  // after publication. It is the only thing that feeds dateModified, because a
  // date-only edit is not maintenance — Google says changing dates without
  // changing content does not improve rankings, and treats date churn as
  // manipulation. So this field is what a review is supposed to produce, and it
  // is checked for internal consistency rather than for existence: most pieces
  // legitimately have nothing to record.
  //
  // What is checked: a revision cannot predate publication, and `updatedDate`
  // cannot disagree with the newest revision. The two fields say the same thing
  // — updatedDate is the legacy alias — so divergence means one of them is
  // wrong, and a wrong revision date is worse than no revision note.
  const revDates = [...fm.matchAll(/^\s*-\s*date:\s*(\S+)/gm)].map((m) => m[1]);
  if (revDates.length) {
    const published = fmLine("publishDate")?.slice(0, 10) ?? "";
    const before = revDates.filter((d) => d < published);
    if (before.length) {
      add(
        "block",
        "revisions consistent",
        `revision dated ${before[0]} predates publishDate ${published}`,
      );
    }
    const newest = [...revDates].sort().at(-1);
    const updated = fmLine("updatedDate")?.slice(0, 10);
    if (!updated) {
      add("warn", "revisions consistent", `revisions exist but updatedDate is unset (newest ${newest})`);
    } else if (updated !== newest) {
      add(
        "warn",
        "revisions consistent",
        `updatedDate ${updated} disagrees with newest revision ${newest}`,
      );
    } else {
      add("pass", "revisions consistent", `${revDates.length} revision(s), newest ${newest}`);
    }
  }

  // ---- calculation transparency ---------------------------------------
  // Same principle as the primary-source rule above: if the piece claims a
  // custom calculation, the reader has to be able to see the calculation.
  //
  // Why this exists. The site's moat is the arithmetic, and until now the
  // arithmetic was invisible. The five-part figures live in frontmatter, which
  // only a developer reads; the cost models live in tools/. A reader got the
  // answer with no way to check it. The comparison case study that prompted
  // this — NapLab — derives its defensibility as much from publishing its
  // method (ten standardised tests, 43-64 data points, the scoring rule) as
  // from running it. Article 14 printed every input in a table and that was
  // exactly the right instinct, but it was done by accident rather than by
  // rule, so it survived exactly one article.
  //
  // What is required, for `custom-calculation` pieces only:
  //   - a visible "How we calculated this" heading
  //   - a fenced code block, i.e. the formula or the model output, shown
  // and what is reported as a warning rather than a block:
  //   - whether the prose names the reader's own input in so many words
  //
  // That last one was a block in the first version and it was wrong. The check
  // looked for a keyword list — input, cif, value per unit — so a section
  // saying "the spend is yours" or "unit FOB value is the input" failed it.
  // That is a test of vocabulary, not of whether the reader can check the
  // number. The fenced block is the evidence; whether the sentence used the
  // word "input" is not.
  //
  // The model filename is still NOT required: some pieces derive their figure
  // from a published document rather than from a script in tools/, and
  // demanding a filename would be a rule about our internal layout rather than
  // about what the reader can verify.
  if (gain && /custom-calculation/.test(gain)) {
    const section =
      /##\s*How we calculated this\s*\n([\s\S]*?)(?=\n##\s|$)/.exec(body)?.[1] ?? "";
    if (!section) {
      add(
        "block",
        "calculation shown to reader",
        "declares custom-calculation but has no '## How we calculated this' section",
      );
    } else {
      const hasFormula = /```[\s\S]*?```/.test(section);
      const words = wordCount(section);
      hasFormula
        ? add("pass", "calculation shown to reader", `formula shown (${words} words)`)
        : add("block", "calculation shown to reader", "section present but no fenced formula block");

      const namesInput = /\b(spend|input|invoice|fob|cif|value|contract rate|cost of capital|margin|price|units? per|per (tonne|unit|item|container|parcel)|deposit|quote)\b/i.test(
        section,
      );
      if (hasFormula && !namesInput) {
        add("warn", "calculation names an input", "no reader-supplied input named in the prose");
      }
    }
  }

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

// ---------------------------------------------------------------------------
// Library-wide claims.
//
// The About page makes promises about how this site works, and the code has to
// keep them. A promise the code no longer honours is worse than no promise: the
// About page stated for a week that a correction "is noted at the foot of the
// article", which stopped being true the moment corrections moved into
// structured `revisions` rendered as a fixed block.
//
// Declared as a function rather than inlined at module scope so it can run after
// the file list exists. The first version was inlined above the `const args` and
// `let files` declarations and would have thrown a temporal-dead-zone
// ReferenceError on every run — the same mistake made twice already in this
// project, which is why the check is written this way instead.
function reportLibraryClaims(files) {
  const all = files
    .map((f) => readFileSync(f, "utf8"))
    .filter((raw) => !/^draft:\s*true/m.test(raw));
  const fmOf = (raw) => /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw)?.[1] ?? "";
  const count = (raw, re) => (fmOf(raw).match(re) || []).length;

  const noReview = all.filter((raw) => !/^reviewBy:/m.test(fmOf(raw))).length;
  const fewFigures = all.filter((raw) => count(raw, /^\s+- value:/gm) < 5).length;
  const noSources = all.filter((raw) => count(raw, /^\s+- /gm) === 0).length;
  const dateWithoutRevision = all.filter(
    (raw) => /^updatedDate:/m.test(fmOf(raw)) && count(raw, /^\s+- date:/gm) === 0,
  ).length;

  const claims = [
    ["every article carries reviewBy", noReview === 0, `${noReview} missing`],
    ["every article carries >= 5 figures", fewFigures === 0, `${fewFigures} short`],
    ["every article names sources", noSources === 0, `${noSources} with none`],
    [
      "updatedDate only with a recorded revision",
      dateWithoutRevision === 0,
      `${dateWithoutRevision} article(s) update the date with nothing recorded`,
    ],
  ];

  console.log("\nABOUT-PAGE CLAIMS (whole library)");
  console.log("=".repeat(78));
  let failed = 0;
  for (const [name, ok, detail] of claims) {
    console.log(`  ${ok ? "[ ok ]" : "[FAIL]"} ${name.padEnd(42)} ${detail}`);
    if (!ok) failed++;
  }
  if (failed) {
    console.log(
      `\n  ${failed} About-page promise(s) no longer hold. Either fix the library or fix\n` +
        "  the About page — do not leave the site describing a process it abandoned.",
    );
  }
  return failed;
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
for (const file of files) {  const raw = readFileSync(file, "utf8");
  const isDraft = /^draft:\s*true/m.test(raw);
  const results = check(file);

  // A draft is not published, so a blocking rule cannot leak anything. Report
  // drafts as warnings so `--all` stays a usable gate on what is live.
  const blocks = results.filter((r) => r.level === "block");
  const warns = results.filter((r) => r.level === "warn");
  const passes = results.filter((r) => r.level === "pass");

  console.log(`\n${file}${isDraft ? "  [draft]" : ""}`);
  console.log(`  ${passes.length} pass · ${warns.length + (isDraft ? blocks.length : 0)} warn · ${isDraft ? 0 : blocks.length} BLOCK`);
  if (isDraft) {
    console.log(`  –        draft: ${blocks.length} blocking rule(s) not yet met, excluded from the gate`);
  } else {
    for (const r of blocks) console.log(`  ✗ BLOCK  ${r.rule.padEnd(38)} ${r.detail}`);
  }
  for (const r of warns) console.log(`  ! warn   ${r.rule.padEnd(38)} ${r.detail}`);

  // Passes are hidden by default because the count on the line above is the
  // useful part when scanning a whole library. But that leaves no way to confirm
  // that a specific rule RAN and passed, as opposed to not running at all —
  // which is indistinguishable from the outside. VERBOSE=1 lists them.
  if (process.env.VERBOSE) {
    for (const r of passes) console.log(`  · pass   ${r.rule.padEnd(38)} ${r.detail}`);
  }

  if (!isDraft && blocks.length) anyBlocking = true;
}

// Only in library mode: these are claims about the whole set, and running them
// per file would report the same four lines once per article.
if (args[0] === "--all") {
  const claimFailures = reportLibraryClaims(files);
  // A broken About-page promise is a content defect, not a build failure, so it
  // does not set exit 1 on its own — but it is printed loudly and it is the kind
  // of thing that should be fixed the moment it appears.
  void claimFailures;
}

console.log(anyBlocking ? "\nRESULT: BLOCKED — fix the blocking rules above.\n" : "\nRESULT: PASS — every blocking rule cleared.\n");
process.exit(anyBlocking ? 1 : 0);
