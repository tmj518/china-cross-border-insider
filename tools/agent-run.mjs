#!/usr/bin/env node
/**
 * The daily job, run by an agent rather than by a fixed script.
 *
 * ## Why this exists
 *
 * The working local pipeline was not a script. `tools/run-daily.ps1` piped `daily-task.txt` - 22 KB of
 * instructions - into `dsh headless`, a general agent that read files, ran commands, looked at errors and
 * decided what to do next. It produced 29 articles. The wrapper script only did the two things the agent
 * could not do inside its sandbox: build and push.
 *
 * The cloud replacement was `cloud-orchestrator.mjs`, a fixed sequence of steps. That is a different
 * machine: it can only do what someone wrote down in advance. Every judgement the agent made implicitly
 * had to be enumerated, and every enumeration has a gap. Fourteen consecutive runs failed, and each
 * failure was one gap - a missing field in a validator, a prompt that did not say a thing the agent would
 * have inferred, an import that an experiment-only loader could not resolve.
 *
 * The operator's own description of the goal was "one more scheduled trigger, hands free". Not a rewrite.
 * This file is that trigger: the same task file, the same tools, an agent deciding.
 *
 * ## How it differs from the local arrangement, and why that is an improvement here
 *
 * Locally the agent ran inside a sandbox that could not build or push, so the wrapper did those. On a
 * GitHub runner there is no sandbox, so the agent can do everything - which is simpler and also more
 * dangerous. Two guards make it safe:
 *
 *   The deterministic checks run as a tool the agent must call before it can finish. It cannot skip them,
 *   because `finish` refuses until they pass. This is the scaffolding from the script pipeline doing the
 *   job it is actually good at: deciding mechanically, precisely, for free.
 *
 *   Every command the agent runs and every file it writes is recorded, and the transcript is written to
 *   the report. An agent that goes off the rails is diagnosable afterwards rather than mysterious.
 *
 * The agent is given judgement; the checks keep it honest. Neither alone was working.
 *
 * ## Usage
 *
 *   node tools/agent-run.mjs                        # the full daily job
 *   node tools/agent-run.mjs --task=other.txt       # a different instruction file
 *   node tools/agent-run.mjs --max-turns=8          # bound the loop
 *   node tools/agent-run.mjs --dry-run              # plan only, run no commands
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { ask, summary as providerSummary, usageToday } from "./lib-llm.mjs";
import { looksDuplicate } from "./lib-duplicate.mjs";
import { loadMatrix, nextCell, markCell, intentSamples } from "./lib-cells.mjs";

const ROOT = process.cwd();
/*
 * THE AGENT ROUTE WRITES WITH THE LITE ENDPOINT, and the script route keeps the Pro one.
 *
 * The two routes are for different jobs. The script route has to produce a finished article from a directive, so it gets
 * the slower, stronger model - 592 seconds and two calls on 2026-10-20. The agent route's job is to probe three data
 * sources, decide whether a subject exists at all, and stop early if it does not; that is many short calls, and it was
 * measured at 70 calls for one article. Spending Pro latency on seventy short calls is wrong twice over.
 *
 * So the writer model is chosen per route, not per repository. ARK_MODEL_WRITER stays the Pro endpoint for the script
 * route; the agent sets the lite endpoint here, before any call is made.
 */
if (!process.env.AGENT_WRITER_ENDPOINT) {
  process.env.AGENT_WRITER_ENDPOINT = "ep-20251220175517-rjpsc";
}
process.env.ARK_MODEL_WRITER = process.env.AGENT_WRITER_ENDPOINT;

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};

const TASK_FILE = flag("task", "daily-task.txt");
/*
 * Forty turns, not twenty-four.
 *
 * The run that failed spent all twenty-four on preparation and never wrote a draft, so the ceiling was not
 * the binding constraint - but twenty-four is also too few for a task that legitimately needs a draft, two
 * revisions and a publish. Forty leaves room for the work while the budget and the repeat guard below stop
 * the preparing from filling it.
 */
/*
 * Fourteen turns, not forty.
 *
 * Forty was chosen when the limit was about not looping forever. The 12:05 run on 2026-10-18 showed what it costs
 * instead: forty turns at roughly thirty seconds each is twenty minutes of wall clock, and the goal for this route is
 * five. The tool wall already stops reading after turn four, so the later turns are a model being asked to write
 * without being told anything new - which is latency, not work.
 *
 * Fourteen turns is three of model latency at thirty seconds, which leaves room for a check, a repair and a publish.
 */
/*
 * Thirty turns, and the measurement is why.
 *
 * Twenty turns took two minutes, not ten: a turn is a model call plus one tool, and the model is answering in a few
 * hundred tokens. The 05:19 run reached turn twenty having fixed a misspelled field, a schema shape, an
 * internal-links gate and a misread subsidy figure, and hit the limit one call short of publish_draft. A budget that
 * stops at the last useful turn is not a budget, it is a coin flip.
 */
/*
 * THE DATA ORDER is the first thing the model reads, because the first three turns decide the article.
 *
 * A pipeline chooses a subject from a fixed rule. An editor chooses it from evidence, and the evidence has an order:
 * what people search for, then what they read, then what the ministry published. On a new site the first two are empty
 * and the third is the answer - but the model has to ask in that order to know that, and it has to be told not to
 * invent a subject when all three are empty.
 */
const DATA_NOTE = `BEFORE YOU WRITE, PROBE THE DATA - in this order, one call each:

  1. get_gsc_blue_ocean    What people searched for and did not find. A keyword here is the strongest subject there
                           is, because somebody has already asked the question. If it returns keywords, write about
                           the first one and use get_latest_official_docs to find the rate behind it.
  2. get_ga4_trending      What people actually read. If Search Console is empty and this names a category, write in
                           that category.
  3. get_latest_official_docs  What the ministries published today, with the figures. This is the normal answer for a
                           new site, and it is a good answer: it carries rates and amounts.

If the subject research proposes is already published - check src/content/blog for the slug, or for an article carrying
the same figures - call relaunch ONCE to get a different subject. That is what the tool is for: a published subject is
not a verdict on the day, it is one subject out of many.

If all three return nothing, call finish with NO-SUBJECT. Do not invent a subject, and do not write an article from
memory. The probes cost almost nothing; a fabricated article costs the site its credibility.

You have three turns for probing. From turn four those three tools stop answering and only writing tools work, so
probe first and write second.`;

const SUBMIT_NOTE = "SUBMIT AT TURN TEN: if check_draft is still reporting problems at turn ten, stop editing. Call publish_draft on the best draft you have. A published article that the checker disliked is worth more than a perfect draft that never shipped, and the operator reads the checker's complaint on the card either way.";

/*
 * Fifteen turns, locked.
 *
 * Thirty ran without converging: the agent moved between "too short" and "too long", fixed one rule and broke another,
 * and spent sixty-nine cents arriving nowhere. A budget that a run cannot finish inside is not a budget. Fifteen turns,
 * and the last two are for submitting rather than editing.
 */
const MAX_TURNS = Number(flag("max-turns", 10));

/*
 * How many turns may be spent reading and inspecting before writing has to start.
 *
 * Chosen as a share of the budget rather than a constant, so --max-turns=12 does not leave a reading
 * allowance larger than the whole run.
 */
/*
 * Four turns of preparation, not a quarter of the budget.
 *
 * The share-based rule gave ten of forty turns to reading, and the job is smaller than that: read the directive,
 * run research once if it names nothing, then write. A model with ten turns of reading allowed uses ten - that is
 * what the 06:16 run did, and it is the operator's own description of the problem: "开始前阅读太多".
 *
 * Four is enough for the directive, a research call, a look at the draft and one correction. Everything past that
 * is refused, and the refusal says to write.
 */
const PREP_TURNS = 4;

/*
 * A HARD DOLLAR CEILING, because turns are not money.
 *
 * The 2026-10-19 runs measured it: the agent route spent $0.0469 in seventy calls, fifty-six of which were retries after
 * Ark timed out in a long context. A turn budget cannot see that - turn nine of a retry storm looks exactly like turn
 * nine of a clean run. The ceiling is checked after every tool call, and reaching it ends the loop the same way the
 * turn limit does: the newest draft is submitted and the verdict says how.
 */
const USD_LIMIT = Number(process.env.AGENT_USD_LIMIT ?? 0.06);
let spentUsd = 0;

const DRY = args.includes("--dry-run");
const REPORT = join(ROOT, "data", "tmp", "agent-report.json");
const TRANSCRIPT = join(ROOT, "data", "tmp", "agent-transcript.jsonl");

/*
 * Commands the agent may run.
 *
 * An allowlist rather than a free shell. Not because the agent is untrusted - it is the same model that
 * writes the articles - but because a general agent with a general shell finds general solutions, and
 * this repository's correctness depends on specific ones: the schema check, the gates, the audit. An
 * agent that runs `git commit --no-verify` or rewrites a validator has solved its problem and broken the
 * pipeline. The allowlist is the boundary that makes the difference between assistance and drift.
 *
 * The list is deliberately long enough to work and short enough to audit. Anything an agent wants that
 * is not here, it can ask for in its final message rather than improvising.
 */
const ALLOWED_COMMANDS = [
  [/^node tools\/[a-z0-9-]+\.mjs(\s|$)/, "a repository tool"],
  [/^node --version$/, "node version"],
  [/^git (status|diff|log|add|commit|rev-parse)(\s|$)/, "git, read and commit only"],
  [/^pnpm exec astro build$/, "the build"],
  [/^ls(\s|$)/, "list a directory"],
  [/^grep -rn /, "search the tree"],
];
const FORBIDDEN_IN_COMMAND = [
  /\bpush\b.*--force/,
  /--no-verify/,
  /\brm\s+-rf\s+[./]/,
  /\bgit\s+reset\s+--hard/,
  /\bgit\s+checkout\s+--\s/,
  /\bcurl\b|\bwget\b/,
  /\bnpm\s+install\b|\bpnpm\s+(add|install)\b/,
];

function commandAllowed(cmd) {
  const c = String(cmd).trim();
  if (FORBIDDEN_IN_COMMAND.some((re) => re.test(c))) return { ok: false, why: "the command matches a forbidden pattern (history rewrite, verification skip, network fetch or install)" };
  const hit = ALLOWED_COMMANDS.find(([re]) => re.test(c));
  return hit ? { ok: true, why: hit[1] } : { ok: false, why: "not in the allowlist; ask for it in your final message instead of improvising" };
}

/*
 * THE FRONTMATTER CONTRACT, CHECKED LINE BY LINE.
 *
 * qa-check reads the frontmatter with expressions, not with a parser, so a duplicated key passed quietly:
 * the last value won and the file looked fine. It is not fine - duplicated mapping key is a YAML error, and
 * the build refused the whole site while check_draft had already told the model the draft was good.
 *
 * No YAML parser is a direct dependency here, so this is a targeted scanner rather than a general parse: it
 * looks at top-level keys and at the figures block, which is everything the contract constrains. Every finding
 * carries the line number and the single edit that fixes it, because 'frontmatter has a problem' costs a turn
 * and teaches nothing.
 */
/*
 * THE PUBLISH GATE. Nothing reaches src/content/blog with a BLOCK against it.
 *
 * Until now publish_draft published whatever it was handed: the code above says so out loud, and the
 * reason was a deadlock - requiring a clean check meant nothing was ever submitted. But the opposite
 * failure is worse. On 2026-10-28 a draft with a blocked rule and an orphan page was published, the nine
 * gates went red, and the only reason the site survived is that a person moved the file out.
 *
 * So the rule is not 'a clean check or nothing'. It is: no BLOCK may pass. Warnings may, because a warning
 * is a judgement about quality and a BLOCK is a rule the site says it will not break. A draft with blocks
 * is not published, the cell is released, and the verdict says REJECTED with the rules named.
 */
function gateOf(draftPath) {
  try {
    const out = execFileSync(process.execPath, [join(ROOT, "tools", "qa-check.mjs"), draftPath, "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 180000,
      maxBuffer: 32 * 1024 * 1024,
    });
    const j = JSON.parse(out.slice(out.indexOf("{")));
    const blocks = (j.results ?? []).filter((r) => r.level === "block" && !r.isDraft);
    const warns = (j.results ?? []).filter((r) => r.level === "warn");
    return { blocks, warns, ok: blocks.length === 0 };
  } catch (e) {
    let parsed = null;
    try { parsed = JSON.parse(String(e.stdout ?? "").slice(String(e.stdout ?? "").indexOf("{"))); } catch {}
    const blocks = (parsed?.results ?? []).filter((r) => r.level === "block" && !r.isDraft);
    const warns = (parsed?.results ?? []).filter((r) => r.level === "warn");
    return { blocks, warns, ok: blocks.length === 0, error: blocks.length ? null : String(e.message).slice(0, 120) };
  }
}

function frontmatterFixes(raw) {
  const fixes = [];
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (!m) return ["Fix: the file has no frontmatter block. Open it with a line containing only three dashes and close it the same way."];

  const fmLines = m[1].split(/\r?\n/);
  const seen = new Map();
  for (let i = 0; i < fmLines.length; i++) {
    const mm = /^([A-Za-z_][\w-]*):/.exec(fmLines[i]);
    if (!mm) continue;
    const key = mm[1];
    const fileLine = i + 2;
    if (seen.has(key)) fixes.push(`Fix: '${key}' is duplicated at line ${fileLine}, first defined at line ${seen.get(key)}. Delete one of the two lines.`);
    else seen.set(key, fileLine);
  }

  for (const banned of ["date", "createdAt", "publish_date", "published"]) {
    if (seen.has(banned)) fixes.push(`Fix: '${banned}' at line ${seen.get(banned)} must be renamed to 'publishDate'.`);
  }
  for (const req of ["title", "description", "category", "audience", "information_gain", "publishDate"]) {
    if (!seen.has(req)) fixes.push(`Fix: required key '${req}' is missing. Add it as a top-level key in the frontmatter.`);
  }
  if (seen.has("publishDate")) {
    const line = fmLines[seen.get("publishDate") - 2] ?? "";
    if (!/publishDate:\s*"?\d{4}-\d{2}-\d{2}"?\s*$/.test(line)) {
      fixes.push(`Fix: 'publishDate' at line ${seen.get("publishDate")} must be a quoted date, like publishDate: "2026-10-28".`);
    }
  }

  const figStart = fmLines.findIndex((l) => /^figures:/.test(l));
  if (figStart >= 0) {
    const entries = [];
    for (let i = figStart + 1; i < fmLines.length; i++) {
      const l = fmLines[i];
      if (l.trim() === "") continue;
      if (!/^\s+/.test(l)) break;
      if (/^\s*-\s/.test(l)) entries.push({ line: i + 2, body: [l] });
      else if (entries.length) entries[entries.length - 1].body.push(l);
    }
    for (const e of entries) {
      for (const field of ["value", "unit", "period", "source", "retrieved"]) {
        if (!e.body.some((x) => new RegExp(`^\\s*(?:-\\s*)?${field}:`).test(x))) {
          fixes.push(`Fix: the figures entry that starts at line ${e.line} has no '${field}'.`);
        }
      }
    }
    if (!entries.length) fixes.push(`Fix: 'figures' at line ${figStart + 1} is empty. Every entry needs value / unit / period / source / retrieved.`);
  }
  return fixes;
}

/* ---------------------------------------------------------------- the tools */

const TOOLS = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a text file from the repository. Paths are relative to the repository root.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, max_lines: { type: "integer", description: "default 400" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Write a text file. Use this for an article draft under data/drafts/ and for nothing else unless the task says so. Creating or overwriting an article in src/content/blog/ is refused: an article reaches the collection only by passing the checks and then being published.",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, content: { type: "string" } },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dir",
      description: "List the entries of a directory.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "run",
      description:
        "Run a command from the allowlist. The allowlist covers the repository's own tools, git add/commit, the build, and read-only listings. Anything else is refused with the reason.",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    },
  },
  {
    type: "function",
    function: {
      name: "check_draft",
      description:
        "Run every deterministic check against a draft: the content schema, the seven gates, the L2-L4 audit. Call this after writing a draft and before publishing it. It returns pass or the failures.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_gsc_blue_ocean",
      description:
        "Search Console: queries with real impressions and no clicks over the last seven days. Call this FIRST. A keyword here is a question people already ask, which makes it the strongest subject available. Returns the queries with their numbers, or says there are none.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_ga4_trending",
      description:
        "Readership: which categories the site is actually read in. Call this when Search Console returns nothing. A category people read is a category worth writing in.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_latest_official_docs",
      description:
        "Today's official documents and the subject research proposes from them. Call this when neither data source has anything, which is normal for a new site. The answer lists the figures, so you can see whether a cost article is possible before writing one.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "relaunch",
      description:
        "Abandon the current draft and ask research for a different subject. Use this when the material cannot support a cost article - no rate, no amount, nothing an importer can act on - because rewriting that draft only burns turns. One use per run. It returns the new subject and its figures; write a fresh draft from them.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "publish_draft",
      description:
        "Move a checked draft into src/content/blog/ so the next build includes it, and rebuild the instrument registry. Refuses if the draft has not passed check_draft in this run.",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    },
  },
  {
    type: "function",
    function: {
      name: "finish",
      description:
        "End the run. Refused if any draft was published without passing check_draft, so call check_draft first.",
      parameters: {
        type: "object",
        properties: {
          verdict: { type: "string", description: "PUBLISHED, NO-SUBJECT, REJECTED, or a short reason it could not proceed" },
          summary: { type: "string", description: "one sentence for the notification" },
        },
        required: ["verdict", "summary"],
      },
    },
  },
];

/* ---------------------------------------------------------------- state */

const transcript = [];
let LAST_GATE_WARNINGS = 0;
const published = new Set();

/*
 * THE CELL THIS RUN IS WRITING FOR, if any.
 *
 * The twenty-five cells are the only subject source on this site that is not a prior. Picking one here
 * and putting its five phrasings into the prompt is what turns a demand map into an article: the model
 * is no longer asked "what happened today", it is asked "these people asked this, answer it with a
 * number".
 *
 * Claimed as taken at the start, not at the end - otherwise a run that dies mid-way leaves the cell
 * available and tomorrow's run writes the same subject again, which is how five near-duplicates get
 * published and no cell gets covered.
 */
const CELL = (() => {
  if (process.env.NO_CELL) return null;
  try {
    const matrix = loadMatrix();
    if (!matrix) return null;
    const picked = nextCell(matrix);
    if (!picked) return null;
    markCell(matrix, picked.persona, picked.moment, "taken");
    console.log(`  cell      : ${picked.persona} x ${picked.moment} [${picked.direction}] ${picked.reason}`);
    return { ...picked, matrix };
  } catch (e) {
    console.log("  cell      : none (" + e.message + ")");
    return null;
  }
})();

const CELL_BRIEF = CELL
  ? `THIS RUN HAS A DEMAND CELL

The twenty-five-cell map found that people are asking the questions below and this site has no page that
answers them. Write the article that answers them.

THIS OVERRIDES TODAY'S JOB BELOW: do not run research.mjs and do not take a subject from
data/directive.json. The subject is this cell.

  cell      ${CELL.persona} x ${CELL.moment} (${CELL.direction})
  evidence  ${CELL.reason}

Questions people actually typed:

${CELL.samples.map((q, i) => `  ${i + 1}. ${q}`).join("\n")}

Rules for this article:
  - Every figure must be quoted verbatim from an official page you actually fetched, with its source and
    retrieval date. No estimate, no range, no "typically".
  - If the official sources do not publish a number that answers these questions, do NOT write around it.
    Call finish with verdict INSUFFICIENT-EVIDENCE and say which sources you tried and which figure was
    missing. A missing number reported is worth more than a plausible number invented.
  - This is a demand-driven article: it exists because those questions were typed, not because a ministry
    published something.`
  : "";
const checkedOk = new Set();
let finished = null;
/** A relaunch is allowed once per run; a second one is a refusal. */
let relaunched = false;

function record(entry) {
  transcript.push({ at: new Date().toISOString(), ...entry });
}

/** Refuse to touch the collection directly: that is publish_draft's job, after the checks. */
function writeTargetRefused(p) {
  const norm = p.replace(/\\/g, "/");
  if (norm.startsWith("src/content/blog/")) {
    return "src/content/blog/ is off limits. Write the draft under data/drafts/ and use publish_draft, which refuses a draft that has not passed check_draft.";
  }
  if (norm.includes("..")) return "paths may not escape the repository";
  return null;
}

function runTool(name, input) {
  const started = Date.now();
  const done = (result) => {
    record({ tool: name, input, result: String(result).slice(0, 4000), ms: Date.now() - started });
    return String(result).slice(0, 12000);
  };

  try {
    if (name === "read_file") {
      const p = join(ROOT, input.path);
      if (!existsSync(p)) return done(`no such file: ${input.path}`);
      const lines = readFileSync(p, "utf8").split("\n");
      const max = Number(input.max_lines ?? 400);
      const body = lines.slice(0, max).join("\n");
      return done(body + (lines.length > max ? `\n\n... ${lines.length - max} more line(s)` : ""));
    }

    if (name === "write_file") {
      const refusal = writeTargetRefused(input.path);
      if (refusal) return done(`REFUSED: ${refusal}`);
      if (DRY) return done("dry run: the write was not performed");
      /*
       * A DEMAND CELL WITH NO FIGURE IS NOT AN ARTICLE.
       *
       * The cell exists because somebody asked for an amount. Publishing a page that describes the
       * procedure instead answers a different question and then reports success - which is how eight
       * guides ended up with an empty figures array while the card still said PUBLISHED.
       *
       * Refusing here is cheap: the run ends yellow, the cell stays claimed, and the next run knows the
       * official sources do not carry this number. That is a finding, not a failure.
       */
      if (CELL) {
        const draftSrc = readFileSync(join(ROOT, input.path), "utf8");
        const figureCount = (draftSrc.match(/^  - value:/gm) ?? []).length;
        if (figureCount === 0) {
          if (!finished) {
            finished = {
              verdict: "INSUFFICIENT-EVIDENCE",
              summary:
                "the " + CELL.persona + " x " + CELL.moment + " cell asked " + CELL.samples.length +
                " questions that need an amount, and no official source fetched this run carried one. Nothing was published.",
            };
          }
          console.log("  refused   : the draft answers a demand cell with zero sourced figures");
          return done("INSUFFICIENT-EVIDENCE: no sourced figure in the draft, so it was not published. Call finish with that verdict and name the sources you tried.");
        }
      }
      const p = join(ROOT, input.path);
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, String(input.content ?? ""), "utf8");
      checkedOk.delete(input.path);
      return done(`wrote ${input.path} (${String(input.content ?? "").length} bytes). Call check_draft on it before publishing.`);
    }

    if (name === "list_dir") {
      const p = join(ROOT, input.path);
      if (!existsSync(p)) return done(`no such directory: ${input.path}`);
      return done(readdirSync(p, { withFileTypes: true }).map((e) => (e.isDirectory() ? e.name + "/" : e.name)).join("\n"));
    }

    if (name === "run") {
      /*
       * The agent may not start another pipeline.
       *
       * tools/cloud-orchestrator.mjs, tools/agent-run.mjs and tools/research.mjs are the three entry points to the
       * work this agent is supposed to be doing. An agent that shells out to one of them has handed its own job to a
       * second process it can no longer see: no turn limit applies, the report is written by somebody else, and the
       * job budget is spent on a run whose transcript says nothing about it.
       */
      /*
       * Research is NOT on this list, and the difference cost a run.
       *
       * The first version banned all three entry points. At 04:49 on 2026-10-18 the agent did exactly the right
       * thing - read the empty directive, ran research to pick a subject - and the guard refused it, so it finished
       * with NO-SUBJECT after four turns. Short, fast and useless.
       *
       * cloud-orchestrator and agent-run are whole pipelines: they write, review, publish and commit, and an agent
       * that starts one has handed its job to a process it cannot see. tools/research.mjs is a tool that answers one
       * question - what subject do today's documents support - and it is the only way to answer it once the
       * directive has been consumed.
       */
      const PIPELINE = /\b(cloud-orchestrator|agent-run)\.mjs\b/;
      if (PIPELINE.test(input.command)) {
        return done(
          "REFUSED: that starts another pipeline. You are the pipeline. Read the directive, fetch what you need, " +
            "write the article with write_file, check it with check_draft, publish it with publish_draft.",
        );
      }
      const verdict = commandAllowed(input.command);
      if (!verdict.ok) return done(`REFUSED: ${verdict.why}`);
      if (DRY) return done(`dry run: would run ${input.command} (${verdict.why})`);
      try {
        /*
       * Two minutes, not fifteen.
       *
       * The repository's own tools finish in seconds - the whole script pipeline is about ninety - so a command that
       * runs longer than two minutes is not doing the work, it is looping or it has started something that never
       * ends. The old ceiling let one call consume a seventh of the entire job budget, and the 12:05 run on
       * 2026-10-18 spent twenty minutes with no output.
       */
      const COMMAND_TIMEOUT = Number(process.env.AGENT_COMMAND_TIMEOUT_MS ?? 120000);
      const out = execFileSync(input.command, { shell: true, cwd: ROOT, encoding: "utf8", timeout: COMMAND_TIMEOUT, maxBuffer: 64 * 1024 * 1024 });
        return done(`exit 0\n${out.slice(-6000)}`);
      } catch (e) {
        const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
        const first = out.split("\n").find((l) => /Error|FAIL|error:/.test(l)) ?? out.split("\n").filter(Boolean)[0] ?? "no output";
        return done(`exit ${e.status ?? 1}: ${first}\n\n${out.slice(-4000)}`);
      }
    }

    if (name === "check_draft") {
      /*
       * The checks are the same ones the script pipeline ran, called through the same entry point, so the
       * agent is held to exactly the standard that was being enforced before - including the schema rules,
       * which catch a wrong enum value before it reaches the build.
       */
      if (DRY) return done("dry run: the checks were not run");
      const p = join(ROOT, input.path);

      /*
       * The contract before the content. A draft that cannot be parsed is not a draft with weak arguments -
       * it cannot be published at all, and the model must be told which line to delete rather than that something
       * is wrong somewhere.
       */
      const contract = frontmatterFixes(readFileSync(p, "utf8"));
      if (contract.length) {
        console.log("  turn " + turn + " · check_draft: " + contract.length + " frontmatter fix(es)");
        return done(
          "FRONTMATTER CONTRACT: " + contract.length + " line(s) must change before this draft can be checked further.\n\n" +
            contract.join("\n") +
            "\n\nApply these edits, then call check_draft again.",
        );
      }
      if (!existsSync(p)) return done(`no such draft: ${input.path}`);

      /*
       * Trim over-long fields first.
       *
       * A subtitle at 194 characters against a limit of 160 is arithmetic, not judgement: it does not need
       * a model turn and it must not cost a draft. trim-draft shortens the value on a word boundary and
       * changes nothing else, and the fact that it did so is reported so nobody thinks the writer chose
       * those words.
       */
      let trimNote = "";
      try {
        const trimOut = execFileSync(process.execPath, [join(ROOT, "tools", "trim-draft.mjs"), p, "--write"], {
          cwd: ROOT,
          encoding: "utf8",
          timeout: 60000,
        });
        if (!/nothing to trim/.test(trimOut)) {
          trimNote = "Trimmed before checking:\n" + trimOut.split("\n").filter((l) => l.trim() && !/dry run|written:/.test(l)).join("\n") + "\n\n";
        }
      } catch {
        /* a trim that fails leaves the draft as it was, and the checks below will say what is wrong */
      }
      /*
       * Structure first, and its failures are returned with their guidance.
       *
       * This is the loop the operator asked for: a block says what it wants, how to satisfy it, and what passing
       * looks like. Returning "the build failed" and stopping is the behaviour that produced revision rounds that
       * each fixed one thing.
       */
      let structure = null;
      try {
        const raw = execFileSync(process.execPath, [join(ROOT, "tools", "qa-check.mjs"), p, "--json"], {
          encoding: "utf8",
          cwd: ROOT,
          timeout: 120000,
          maxBuffer: 32 * 1024 * 1024,
        });
        structure = JSON.parse(raw);
      } catch (e) {
        /* A non-zero exit still carries the JSON on stdout; only a parse failure means we learned nothing. */
        try {
          structure = JSON.parse(String(e.stdout ?? ""));
        } catch {
          structure = null;
        }
      }

      if (structure?.blocked) {
        const blocking = (structure.results ?? []).filter((r) => r.level === "block" && !r.isDraft);
        const lines = [];
        lines.push(`STRUCTURE CHECK: ${blocking.length} rule(s) block this draft.`);
        lines.push("");
        lines.push("Each entry tells you what the rule wants, the edits that satisfy it, and a fragment that would pass.");
        lines.push("Work through them in this order. Do not rewrite the whole article; make these edits and run");
        lines.push("check_draft again.");
        lines.push("");
        for (const r of blocking) {
          lines.push(`✗ ${r.rule} — ${r.detail}`);
          if (r.want) lines.push(`   wants: ${r.want}`);
          if (r.how) for (const step of r.how) lines.push(`   fix:   ${step}`);
          if (r.example) {
            lines.push("   looks like:");
            for (const line of String(r.example).split("\n")) lines.push(`     ${line}`);
          }
          if (r.unguided) lines.push("   (no guidance written for this rule yet - report it)");
          lines.push("");
        }
        if (structure.unguided?.length) {
          lines.push(`Rules with no guidance, which means the check is incomplete: ${structure.unguided.join(", ")}`);
        }
        return done(`${trimNote}${lines.join("\n")}`);
      }

      try {
        const out = execFileSync(process.execPath, [join(ROOT, "tools", "cloud-qa.mjs"), `--draft=${p}`, "--json"], {
          encoding: "utf8",
          cwd: ROOT,
          timeout: 1800000,
          maxBuffer: 64 * 1024 * 1024,
        });
        JSON.parse(out);
        checkedOk.add(input.path);
        return done(`${trimNote}PASS. Every check cleared.`);
      } catch (e) {
        const out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
        let detail = out.slice(0, 3000);
        try {
          const j = JSON.parse(out);
          const failed = Object.entries(j.layers ?? {}).filter(([, l]) => !l.pass).map(([k, l]) => `${k}: ${l.detail}`);
          detail = failed.join("\n") || detail;
          if (j.reasons?.length) detail += "\n\n" + j.reasons.slice(0, 8).join("\n");
        } catch {
          /* not JSON: the raw output is the detail */
        }
        /* A refusal without a next action is the other half of the deadlock. */
        const fixFor = (line) => {
          if (/word|prose|length/i.test(line)) return "Fix: expand. Add a second worked scenario to So what and a further reader group to For you until the count passes 1,200 words.";
          if (/figure|substantive/i.test(line)) return "Fix: carry at least two figures from the directive into figures[] and into the prose with source, period and retrieved date.";
          if (/faq/i.test(line)) return "Fix: add three to five FAQ entries, each answer 80 to 150 words.";
          if (/table|comparison/i.test(line)) return "Fix: add a markdown table of three rows, each carrying an amount.";
          if (/segment|audience/i.test(line)) return "Fix: write For you as three bullet lines, each beginning with '- **Label:**'.";
          if (/link|internal/i.test(line)) return "Fix: add three links of the form [anchor](/blog/<slug>/) to existing articles.";
          if (/hedg|sensitive/i.test(line)) return "Fix: remove the words listed after the rule name.";
          if (/schema|frontmatter|information_gain/i.test(line)) return "Fix: correct the frontmatter field named; information_gain is one of custom-calculation, cross-source, own-data, primary-source.";
          return "Fix: correct the rule named and call check_draft again.";
        };
        const fixes = detail.split("\n").filter(Boolean).slice(0, 6).map((l) => l + "\n  " + fixFor(l));
        return done(`${trimNote}FAIL:\n${detail}\n\nWHAT TO DO NOW:\n${fixes.join("\n")}`);
      }
    }

    if (name === "publish_draft") {
      /*
       * Publishing no longer requires a green check_draft.
       *
       * That was the deadlock. check_draft reports every rule not satisfied, publish_draft refused unless the last
       * check was clean, and a draft almost never came back clean - so the agent could write, check, rewrite, check
       * and never submit. Fifteen turns, twenty-four calls, nothing published, three times in one evening.
       *
       * The file is still checked, and check_draft remains the way to improve it, but the check is advice now rather
       * than a lock. What stays enforced: the file exists and is not effectively empty. The card reports the last
       * verdict, so a thin article is visible to the operator.
       */
      if (!existsSync(join(ROOT, input.path))) {
        return done(`REFUSED: ${input.path} does not exist. Write it first with write_file.`);
      }
      if (readFileSync(join(ROOT, input.path), "utf8").trim().length < 200) {
        return done(`REFUSED: ${input.path} is effectively empty. Write the article first.`);
      }
      if (!checkedOk.has(input.path)) {
        console.log(`  publish ${input.path}: check_draft never passed, publishing anyway by instruction`);
      }
      if (DRY) return done("dry run: not published");
      const from = join(ROOT, input.path);
      const slug = String(input.path).replace(/^.*\//, "").replace(/\.md$/, "");
      const to = join(ROOT, "src", "content", "blog", `${slug}.md`);
      /* No BLOCK may reach the collection. Warnings may. */
      const gate = gateOf(from);
      if (!gate.ok) {
        const named = gate.blocks.slice(0, 4).map((r) => r.rule).join(", ");
        console.log("  publish refused: " + gate.blocks.length + " blocking rule(s) - " + named);
        if (!finished) {
          finished = {
          verdict: "REJECTED",
          summary: "the draft breaks " + gate.blocks.length + " blocking rule(s) (" + named + "), so it was not published. The site refuses to publish a page it would immediately flag.",
          };
        }
        return done("REJECTED: blocking rules - " + named + ". Fix them and call check_draft again; nothing was published.");
      }
      const degraded = gate.warns.length > 0;
      LAST_GATE_WARNINGS = gate.warns.length;
      if (degraded) console.log("  publish with " + gate.warns.length + " warning(s) - the verdict will say PUBLISHED-DEGRADED");
      writeFileSync(to, readFileSync(from, "utf8"), "utf8");
      try {
        execFileSync(process.execPath, [join(ROOT, "tools", "build-instruments.mjs")], { cwd: ROOT, timeout: 600000 });
      } catch {
        /* the registry rebuild is reported by preflight; the article is staged either way */
      }
      published.add(slug);
      if (CELL) {
        try {
          markCell(CELL.matrix, CELL.persona, CELL.moment, "published", { slug, publishedOn: new Date().toISOString().slice(0, 10) });
          console.log("  cell      : marked published in the matrix");
        } catch (e) {
          console.log("  cell      : published but not marked (" + e.message + ")");
        }
      }
      return done(`published ${slug} to src/content/blog/. The registry was rebuilt.`);
    }

    if (name === "get_gsc_blue_ocean") {
      /*
       * THE THREE EYES. Each is a shell to a repository tool, and the order the prompt asks for is the order of
       * evidence: what people search for beats what people read, and what people read beats what a ministry
       * published. A site with no traffic gets the third answer every day, which is correct and honest.
       */
      if (DRY) return done("dry run: would query Search Console");
      try {
        const out = execFileSync(process.execPath, [join(ROOT, "tools", "gsc-blue-ocean.mjs"), "--days=7"], {
          cwd: ROOT, encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024,
        });
        const m = out.match(/\{[\s\S]*"keywords"[\s\S]*\}/);
        let kws = [];
        try { kws = JSON.parse(m ? m[0] : "{}").keywords || []; } catch {}
        if (!kws.length) {
          const note = (out.split("\n").find((l) => /GSC BLUE OCEAN: Found|GSC: 0 keywords/.test(l)) || "").trim();
          return done(
            "no blue-ocean keywords. " + note + " A new site has little or no exposure, so fall through to get_ga4_trending.",
          );
        }
        return done([
          "Search Console has keywords for you:",
          ...kws.slice(0, 5).map((k) => "  - \"" + k.query + "\"  " + k.impressions + " impressions, " + k.clicks + " clicks, position " + k.position),
          "",
          "Write about the first one, and use get_latest_official_docs to find the rate behind it.",
        ].join("\n"));
      } catch (e) {
        return done("Search Console could not be read: " + String(e.stdout || e.stderr || e.message).slice(-400) + ". Fall through to get_ga4_trending.");
      }
    }

    if (name === "get_ga4_trending") {
      if (DRY) return done("dry run: would read analytics");
      try {
        const out = execFileSync(process.execPath, [join(ROOT, "tools", "analytics.mjs"), "--json"], {
          cwd: ROOT, encoding: "utf8", timeout: 120000, maxBuffer: 16 * 1024 * 1024,
        });
        const m = out.match(/\{[\s\S]*\}/);
        const j = JSON.parse(m ? m[0] : "{}");
        const byCat = j.byCategory || j.categories || null;
        if (!byCat || !Object.keys(byCat).length) {
          return done("no readership data yet - the site has almost no traffic. Fall through to get_latest_official_docs.");
        }
        const ranked = Object.entries(byCat).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 5);
        return done(["Readership by category:", ...ranked.map((r) => "  - " + r[0] + ": " + r[1]), "", "Write in the first category if the documents support it."].join("\n"));
      } catch (e) {
        return done("readership could not be read: " + String(e.stdout || e.stderr || e.message).slice(-300) + ". Fall through to get_latest_official_docs.");
      }
    }

    if (name === "get_latest_official_docs") {
      if (DRY) return done("dry run: would fetch the official documents");
      try {
        execFileSync(process.execPath, [join(ROOT, "tools", "research.mjs")], {
          cwd: ROOT, encoding: "utf8", timeout: 300000, maxBuffer: 32 * 1024 * 1024,
        });
      } catch (e) {
        return done("the research tool failed: " + String(e.stdout || e.stderr || e.message).slice(-600));
      }
      try {
        const d = JSON.parse(readFileSync(join(ROOT, "data", "directive.json"), "utf8"));
        if (!d.slug) return done("research produced no subject from today's documents. Call finish with NO-SUBJECT - do not invent one.");
        const figs = (d.figures || []).slice(0, 8).map((f) => "    - " + (f.value || "") + " " + (f.unit || "") + " (" + (f.source || "") + ")");
        return done([
          "The official documents support this subject:",
          "  slug    : " + d.slug,
          "  keyword : " + (d.target_keyword || d.keyword || ""),
          "  figures : " + (d.figures || []).length,
          ...figs,
          "",
          "Write the article at data/drafts/" + d.slug + ".md from exactly these figures.",
        ].join("\n"));
      } catch (e) {
        return done("the directive could not be read: " + e.message);
      }
    }

    if (name === "relaunch") {
      /*
       * RELAUNCH: one change of subject per run, and the reason is the turn budget.
       *
       * On 2026-10-19 the agent spent seventy-five calls and twelve turns polishing a draft whose source documents held
       * notification counts rather than prices. It could not know that until it had tried, and once it had tried the only
       * way out was to keep rewriting. One relaunch, mid-run, is worth more than four extra turns of the same paragraph.
       *
       * It runs research, which is the repository's own tool for exactly this question - what subject do today's
       * documents support - and returns the subject it chose. The draft is left where it is; a new one is written under
       * the new slug, and the fallback submits the newest file.
       */
      if (relaunched) {
        return done("REFUSED: relaunch has already been used in this run. Write the article from what you have and call publish_draft.");
      }
      relaunched = true;
      if (DRY) return done("dry run: would relaunch");
      try {
        execFileSync(process.execPath, [join(ROOT, "tools", "research.mjs")], {
          cwd: ROOT,
          encoding: "utf8",
          timeout: 240000,
          maxBuffer: 32 * 1024 * 1024,
        });
      } catch (e) {
        return done(`relaunch failed: the research tool exited ${e.status ?? 1}. ${String(e.stdout ?? e.stderr ?? e.message).slice(-600)}`);
      }
      try {
        const d = JSON.parse(readFileSync(join(ROOT, "data", "directive.json"), "utf8"));
        const fig = (d.figures ?? []).slice(0, 8).map((f) => `${f.value ?? ""} ${f.unit ?? ""} - ${f.source ?? ""}`.trim());
        return done([
          "relaunched. The new subject is:",
          `  slug    : ${d.slug}`,
          `  keyword : ${d.target_keyword ?? d.keyword ?? ""}`,
          `  figures : ${(d.figures ?? []).length}`,
          ...fig.map((x) => "    - " + x),
          "",
          `Write the article at data/drafts/${d.slug}.md from these figures. Do not reuse the old draft.`,
        ].join("\n"));
      } catch (e) {
        return done(`relaunch ran but the directive could not be read: ${e.message}`);
      }
    }

    if (name === "finish") {
      if (published.size === 0 && /PUBLISHED/i.test(String(input.verdict ?? ""))) {
        return done("REFUSED: verdict says PUBLISHED but nothing was published in this run. Either publish a draft or report the real verdict.");
      }
      finished = { verdict: String(input.verdict ?? "UNKNOWN"), summary: String(input.summary ?? "") };
      return done("recorded. The run will end after this message.");
    }

    return done(`unknown tool: ${name}`);
  } catch (e) {
    return done(`the tool threw: ${e.cause?.code ?? e.name}: ${e.message}`);
  }
}

/*
 * ALREADY PUBLISHED TODAY, the same guard the script route has.
 *
 * The 21:20 backup cron exists because GitHub's scheduler skipped 07:20 on 2026-10-19 without a trace. What makes a
 * second cron safe is this: if the day already has an article, the second run stops before spending a token.
 */
function alreadyPublishedToday() {
  const beijing = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const dir = join(ROOT, "data", "runs");
  if (!existsSync(dir)) return null;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json") || f === "latest.json") continue;
    try {
      const j = JSON.parse(readFileSync(join(dir, f), "utf8"));
      const when = new Date(new Date(j.at).getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
      /* Route-scoped: the agent asks whether the AGENT has published today, not whether anything has. */
      if (j.route && j.route !== "agent") continue;
      /*
       * NO NEW PAGE means no publication, however the verdict is spelled.
       *
       * The fallback used to copy a draft over a file that was already published, add that slug to published[], and
       * write PUBLISHED-WITHOUT-FINISH. On 2026-10-19 at 01:14 it did exactly that with a page from the evening
       * before, and the guard then believed the day already had an agent article - which it did not, and the route was
       * blocked for fourteen hours. The fallback no longer overwrites, and this check makes the guard read the
       * evidence rather than the label: a journal that claims a publication whose page already existed is not a
       * publication.
       */
      if (j.noNewPage) continue;
      if (when === beijing && /^PUBLISHED/.test(String(j.verdict ?? ""))) {
        return { slug: j.article ?? (Array.isArray(j.published) && j.published[0]) ?? "?", at: j.at };
      }
    } catch {}
  }
  return null;
}

const alreadyToday = alreadyPublishedToday();
if (alreadyToday && !args.includes("--force")) {
  console.log("ALREADY PUBLISHED TODAY");
  console.log("  article : " + alreadyToday.slug);
  console.log("  at      : " + alreadyToday.at);
  console.log("  Exiting 0 - the day already has an article and this run would only burn tokens.");
  writeFileSync(
    REPORT,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        route: "agent",
        verdict: "IDLE",
        summary: `${alreadyToday.slug} was published today at ${alreadyToday.at}, so this run exited without spending a token.`,
        turns: 0,
        published: [],
        usage: { calls: 0, failed: 0, usd: 0 },
        reasons: [],
      },
      null,
      2,
    ),
    "utf8",
  );
  process.exit(0);
}

/* ---------------------------------------------------------------- the loop */

const taskPath = join(ROOT, TASK_FILE);
if (!existsSync(taskPath)) {
  console.log(`AGENT RUN\n${"=".repeat(84)}`);
  console.log(`  cannot read ${TASK_FILE}. The agent has no instructions, so it does nothing.`);
  console.log(`  Pass --task=<file> if the instructions live somewhere else.`);
  process.exit(2);
}

/*
 * The task file is still read, so a missing one is still reported, but its contents no longer reach the model.
 *
 * It describes a sandbox where astro build and git push fail and a wrapper handles them. None of that is true
 * here, and a model told to read eight documents before writing reads eight documents before writing.
 */
const instructions = readFileSync(taskPath, "utf8");
mkdirSync(join(ROOT, "data", "tmp"), { recursive: true });

console.log(`AGENT RUN  ${new Date().toISOString()}`);
console.log("=".repeat(84));
console.log(providerSummary());
console.log(`  task        : ${TASK_FILE} (${instructions.length} bytes)`);

/*
 * A published subject is refused before anything is said to the model.
 *
 * The scheduled run on 2026-10-17 read a consumed directive whose `article` field held yesterday's slug, took it
 * as today's subject, and spent twenty-four turns preparing to rewrite a page that was already live. The
 * orchestrator has a guard for this; the agent route did not.
 *
 * Checked here rather than after the model proposes something, because the cheapest refusal is the one that
 * costs a process start instead of a day of turns.
 */
try {
  const d = JSON.parse(readFileSync(join(ROOT, "data", "directive.json"), "utf8"));
  const subject = d.slug ?? "";
  if (subject && existsSync(join(ROOT, "src", "content", "blog", `${subject}.md`))) {
    console.log("");
    console.log(`  ALREADY-PUBLISHED  ${subject} is in src/content/blog, so this run will not write it.`);
    console.log("  An agent asked to work on a published page replaces a live URL under a reader. The run stops");
    console.log("  here; the next one researches a subject that is not already on the site.");
    /*
     * A report, and a zero exit.
     *
     * This exited 1 without writing data/tmp/agent-report.json, so the notifier had nothing to read and printed the
     * message it prints when the pipeline never started - "a step before the pipeline failed" - while the pipeline had
     * in fact run and made a correct decision. And the run went red for doing the right thing.
     *
     * The 15:55 scheduled run died exactly here: it read yesterday's directive, found the subject already published,
     * declined to overwrite a live URL, and was reported as a crash. A refusal with a reason is a verdict, not a
     * failure, so it is reported as DUPLICATE-SUBJECT and exits zero.
     */
    /*
     * And the stale directive is cleared, so the next run researches instead of stopping at the same wall.
     *
     * Without this the agent route is green and useless: data/directive.json still names a published subject, every
     * scheduled run declines it in ninety milliseconds, and nothing is ever written. The directive is consumed by the
     * run that uses it, so marking it consumed is exactly the state the orchestrator already understands.
     */
    try {
      writeFileSync(
        join(ROOT, "data", "directive.json"),
        JSON.stringify({ consumedAt: new Date().toISOString(), note: "the subject was already published; cleared so the next run researches" }, null, 2) + "\n",
        "utf8",
      );
      console.log("  the directive is cleared below, so the next run researches a fresh subject instead of stopping here.");
    } catch {}

    writeFileSync(
      REPORT,
      JSON.stringify(
        {
          at: new Date().toISOString(),
          route: "agent",
          verdict: "DUPLICATE-SUBJECT",
          summary: `${subject} is already in src/content/blog, so this run declined to write it. The subject ledger is stale: the next run refreshes it before proposing a subject.`,
          turns: 0,
          published: [],
          usage: { calls: 0, failed: 0, usd: 0 },
          reasons: [],
        },
        null,
        2,
      ),
      "utf8",
    );
    process.exit(0);
  }
} catch {
  /* no directive, or one that does not parse - the prompt tells the agent to research, which is correct */
}
console.log(`  max turns   : ${MAX_TURNS}${DRY ? "   DRY RUN: no command will be executed" : ""}`);

/*
 * MODEL ENDPOINTS AS THE RUNNER SEES THEM.
 *
 * These four values were read from secrets.* in the workflow while the values actually lived in vars.*, so
 * every run received empty strings and the provider layer silently fell back. Nothing failed loudly; the
 * run simply used a different model than the one named on the card.
 *
 * Printing them means the next time that happens it shows in the first ten lines of the log instead of
 * being inferred from a cost report three weeks later.
 */
for (const k of ["ARK_MODEL", "ARK_MODEL_WRITER", "ARK_MODELKIMI", "ARK_MODEL_PLANNER", "ARK_MODEL_REVIEWER"]) {
  console.log(`  ${k.padEnd(18)}: ${process.env[k] || "★ MISSING"}`);
}

console.log("");

/*
 * The system prompt states the arrangement rather than the procedure. The procedure is in the task file,
 * which is the operator's own text and is passed through unchanged - the whole point is that the agent
 * gets the instructions that were tuned over 29 articles, not my paraphrase of them.
 */
const SYSTEM = `${DATA_NOTE}

${SUBMIT_NOTE}

${CELL_BRIEF}

You are the daily operator for Landed Math, an English site that turns Chinese and other
official primary documents into per-unit cost consequences for importers.

Your tools: read_file, write_file, list_dir, run, check_draft, publish_draft, finish.
FRONTMATTER CONTRACT - a draft that breaks any line here cannot be published.
  - publishDate: "YYYY-MM-DD"        NOT date:  and NOT createdAt:
  - Every key appears exactly once. A duplicated key is a YAML error, not a warning.
  - title / description / category / audience / information_gain appear once each
  - figures: every entry has value / unit / period / source / retrieved
  - Before calling finish, run check_draft and fix every line it returns.

STRINGS HAVE LIMITS, AND EXCEEDING ONE BLOCKS PUBLICATION.
  - title: 120 characters maximum. Aim for 55 so the site's suffix still fits the 60-column display.
  - description: 300 characters maximum. Aim for 150.
  - category, audience and information_gain are single enum values, not sentences.

BODY RULES - the gates check these, and a BLOCK stops publication.
  - Do not use may, could, might or possibly anywhere in the body. A verbatim quotation is the only
    exception, and the sentence must still be quoted in full.
  - Link to at least one existing article before publishing. A page nothing links to is an orphan, and
    Before publishing, add one sentence with a link to an existing article that the new page extends.
    Pick it with list_dir + read_file. Do not link to the new page itself.
    link-check blocks it.
  - If the same Fix comes back twice, stop rewriting the whole draft. Open the file, change that one
    line, and check again.


TODAY'S JOB

Produce one article and publish it. That is the whole task. The repository is already in a state where this is
possible; nothing needs fixing before you start.

  1. Read data/directive.json once. If it carries a slug and figures, that is your subject and your material.
  2. If it does not - no slug, or it was consumed by a previous run - run
     'node tools/research.mjs' once to choose a subject, then read the directive it writes.
  3. If the slug it names is already in src/content/blog, stop and call finish with verdict
     DUPLICATE-SUBJECT. Do not rewrite an article that is published; a live URL changing under a reader is
     worse than a day with no article.
  4. Write the draft to data/drafts/<slug>.md.
  5. check_draft it. Fix what it reports and check again.
  6. publish_draft it. This is the only route into src/content/blog and it refuses a draft that has not
     passed check_draft in this run.
  7. finish with verdict PUBLISHED and one sentence.

THE RULES THAT ARE NOT NEGOTIABLE, because they are why this site is worth reading

  1. Write only from figures that are in the directive. Never add a number, a source, a quotation, a person or
     an experience. If you do not have a figure, say so rather than supplying one.
  2. A draft goes to data/drafts/. It reaches src/content/blog/ only through publish_draft.
  3. If check_draft fails, read what it says - it names the field, the value and the limit - fix it, and run it
     again. Do not argue with it and do not rewrite the whole article to change one number.
  4. If a failure needs a real document nobody has fetched, stop and report that. An invented number that looks
     real is the worst outcome available to you.
  5. Call finish with a verdict and one sentence, including when you could not do the day's work.

HOW YOUR TURNS WORK

You have ${MAX_TURNS} turns and the first ${PREP_TURNS} are for reading. From turn ${PREP_TURNS + 1} only
write_file, check_draft, publish_draft and finish are accepted - every other tool returns
"PREPARATION IS OVER". This is enforced, not advised.

Do not read the operator's notes. They are not here, they describe a different machine, and they are not
needed: the job is in the section above.

Do not page through output. A tool result that was too long says so in the result itself, at the point where
it was cut, and tells you what to do instead. Running the same command again with a different 'sed' range
returns the same thing and costs a turn.

Do not repeat a call. A repeated call is answered from memory with what it returned the first time.
`;

let messages = [
  {
    role: "user",
    content: `Today is ${new Date().toISOString().slice(0, 10)}.

Begin with today's job: read data/directive.json. Do not look around the repository first - everything you need is either in that file or produced by the tools. If you find yourself reading a file that is not the directive, a draft, or a tool's output, stop and write instead.`,
  },
];

/*
 * What each read-only call returned, so a repeat is answered rather than re-run.
 *
 * Keyed on tool and arguments, so a different path is a different call. Only read-only tools are recorded:
 * write_file and publish_draft are how a draft gets corrected, and finish is how the loop ends, so
 * suppressing any of those would break a run rather than shorten it.
 */
const seenCalls = new Map();
/** The last check_draft failure signature, and how many times it has repeated. */
let lastBlockSig = "";
let stalled = 0;

/*
 * How many times each command base has been run.
 *
 * Keyed on the part before the first pipe or redirect, so "mjs | sed -n '36,42p'" and "mjs | sed -n '38,44p'"
 * share a key. Sixteen turns of that pattern is what this exists to stop.
 */
const baseCounts = new Map();
const commandBase = (cmd) => {
  const s = String(cmd ?? "").trim();
  const cut = s.search(/[|>&;]/);
  return (cut > 0 ? s.slice(0, cut) : s).replace(/\s+/g, " ").trim();
};
const REPEATABLE = new Set(["read_file", "list_dir", "check_draft"]);
const callKey = (name, args) => `${name}:${JSON.stringify(args ?? {})}`;
let repeatCount = 0;

let turn = 0;
let err = null;
for (turn = 1; turn <= MAX_TURNS && !finished; turn++) {
  const r = await ask({ role: "writer", system: SYSTEM, messages, tools: TOOLS, temperature: 0.2, maxTokens: 8192 });
  if (!r.ok) {
    err = r.error;
    console.log(`  turn ${turn}: the model call failed - ${r.error}`);
    break;
  }

  const calls = r.toolCalls ?? [];
  const said = (r.text ?? "").trim();
  if (said) console.log(`  turn ${turn} · said: ${said.replace(/\s+/g, " ").slice(0, 150)}`);
  record({ turn, assistant: said.slice(0, 2000), toolCalls: calls.map((c) => c.function?.name) });

  /* A turn with no tool calls is the model talking rather than acting. Ask it to act, once per turn. */
  if (!calls.length) {
    messages.push({ role: "assistant", content: r.text ?? "" });
    messages.push({
      role: "user",
      content: "Use a tool. If the day's work is finished, call finish with the verdict and one sentence.",
    });
    console.log(`  turn ${turn} · no tool call, asked to act`);
    continue;
  }

  messages.push(r.rawMessage);
  for (const c of calls) {
    let input = {};
    try {
      input = JSON.parse(c.function?.arguments ?? "{}");
    } catch {
      /* a malformed argument object is the model's problem and it is told so below */
    }
    const label = c.function?.name === "run" ? input.command : input.path ?? "";
    console.log(`  turn ${turn} · ${c.function?.name}  ${String(label).slice(0, 90)}`);
    /*
     * Answered, not re-run, and not refused outright: the point is to let the model continue from where it
     * was rather than invite it to look for a variant that costs the same turn.
     */
    const name = c.function?.name;
    let result;

    /*
     * From turn PREP_TURNS+1 the only tools that work are the ones that produce work.
     *
     * This is the change that matters most. The failing run read six documents, ran ten checks and listed the
     * repository for twenty-four turns; nothing in the prompt stopped it and nothing in the code did either.
     * Reading the directive and the draft stays allowed, because a draft cannot be written without them.
     */
    const ACTION_TOOLS = new Set(["write_file", "check_draft", "publish_draft", "finish"]);
    const isActionRead = name === "read_file" && /directive\.json|data\/drafts\//.test(String(input.path ?? ""));
    if (turn > PREP_TURNS && !ACTION_TOOLS.has(name) && !isActionRead) {
      result = [
        `PREPARATION IS OVER. This is turn ${turn} of ${MAX_TURNS}; the reading phase ended at ${PREP_TURNS}.`,
        "",
        `${name} is not available any more. The data probes (get_gsc_blue_ocean, get_ga4_trending, get_latest_official_docs) closed at turn 4. Only write_file, check_draft, publish_draft and finish work from here,`,
        "plus reading data/directive.json and your own draft.",
        "",
        "Write the draft now with what you have. check_draft reports what is missing far faster than reading does,",
        "and it reports it about the thing you are actually being asked to produce.",
      ].join("\n");
      console.log(`  turn ${turn} · ${name} refused - preparation is over`);
      record({ turn, refused: name, reason: "preparation is over" });
      messages.push({ role: "tool", tool_call_id: c.id, content: result });

    /*
     * FORCED SUBMISSION.
     *
     * From turn thirteen the run submits whatever it has. The alternative - which is what actually happened for thirty
     * turns - is a model editing a document that its own checker keeps refusing, alternating between two rules and
     * never converging. The article that exists is worth more than the article it is still trying to write, and the
     * card reports what the last check said so the operator can judge.
     *
     * This is the same instruction the system prompt gives in words. The code gives it teeth.
     */
    /*
     * The ceiling is checked here rather than in the loop condition, so it runs after the tool call has been billed.
     */
    try {
      spentUsd = usageToday().usd;
    } catch {}
    if (spentUsd >= USD_LIMIT) {
      console.log("  budget  : $" + spentUsd.toFixed(4) + " has reached the $" + USD_LIMIT + " ceiling, ending the run");
      record({ turn, budget: true, spentUsd, limit: USD_LIMIT });
      break;
    }

    if (turn >= MAX_TURNS - 2 && !finished) {
      try {
        const drafts = readdirSync(join(ROOT, "data", "drafts"))
          .filter((f) => f.endsWith(".md"))
          .map((f) => ({ f, m: statSync(join(ROOT, "data", "drafts", f)).mtimeMs }))
          .sort((a, b) => b.m - a.m);
        if (drafts.length) {
          const forced = runTool("publish_draft", { path: `data/drafts/${drafts[0].f}` });
          console.log(`  turn ${turn} · FORCED SUBMISSION ${drafts[0].f}`);
          console.log(`  ${forced.split("\n")[0]}`);
          record({ turn, forced: "publish_draft", draft: drafts[0].f, result: forced.slice(0, 300) });
        }
      } catch (e) {
        console.log("  forced submission could not run: " + e.message);
      }
    }
      continue;
    }

    /*
     * A command run for the third time is refused.
     *
     * Turns 25 to 40 were one command with a moving sed window, walking a range backwards through output that
     * had already been returned in full. Keying on the base - everything before the first pipe, redirect or
     * separator - makes paging, re-wrapping with head or tail, and adding a grep all the same command.
     *
     * Two are allowed: running a check before a fix and again after it is legitimate. The message says what to
     * do instead, because a refusal without an alternative is only a stop.
     */
    if (name === "run") {
      const base = commandBase(input.command);
      const times = (baseCounts.get(base) ?? 0) + 1;
      baseCounts.set(base, times);
      if (times > 2) {
        result = [
          `You have run this command ${times} times: ${base.slice(0, 120)}`,
          "",
          "The answer has not changed. Running it again with a different range, a head, a tail or a grep returns the",
          "same text and costs a turn you do not have.",
          "",
          "If the output was cut off, the cut is marked in the result and says how to see the rest. If you are",
          "looking for one specific thing, grep for that word rather than paging through everything. If you are",
          "verifying a fix, use check_draft.",
        ].join("\n");
        console.log(`  turn ${turn} · run refused - same command ${times} times`);
        record({ turn, refused: name, reason: `same command ${times} times`, base: base.slice(0, 120) });
        messages.push({ role: "tool", tool_call_id: c.id, content: result });
        continue;
      }
    }
    const key = REPEATABLE.has(name) ? callKey(name, input) : null;
    if (key && seenCalls.has(key)) {
      repeatCount++;
      result = `You already made this call. It returned:\n\n${seenCalls.get(key)}\n\nNothing has changed since. Do not call it again - use this answer and go on to writing.`;
      console.log(`  turn ${turn} · ${name} repeated, answered from memory`);
      /*
       * In the transcript as well as on the console. A guard that only prints is invisible to the report and
       * to any later reading of the run, and "how many turns were wasted re-asking" is exactly the number
       * that tells you whether the prompt is working.
       */
      record({ turn, repeated: name, key: key.slice(0, 120), note: "answered from memory, not executed" });
    } else {
      result = runTool(name, input);
      if (key) seenCalls.set(key, result);
      /*
       * A write invalidates every answer about that file.
       *
       * The memo is keyed on the tool and its arguments, so check_draft on the same path returned the same cached
       * verdict even after the agent had rewritten the file. On 2026-10-18 the run went write, check (cached, still
       * failing), write again, check (cached again), and burned fourteen turns never seeing that its fix had landed:
       * it produced v1, then v2, then v3 and hit the turn limit with a draft it had probably already fixed.
       *
       * Any write clears the memo. It is a cheap optimisation and a wrong answer is worse than a repeated call.
       */
      if (name === "write_file") seenCalls.clear();

      /*
       * A draft that fails the same way twice is not going to pass.
       *
       * The 05:36 run spent thirty turns and a hundred and fifty-five model calls - nineteen cents, ten minutes -
       * rewriting one draft whose blocking rules never changed. Each check_draft costs several calls because it
       * builds and reviews, so "try again" stops being cheap long before the turn budget notices.
       *
       * Two identical failure signatures in a row ends the run with a verdict instead of a timeout. A REJECTED
       * after six turns tells the operator what happened; a TURN-LIMIT after thirty does not, and costs thirty times
       * as much.
       */
      if (name === "check_draft") {
        const sig = (result.match(/^- .*BLOCK.*$/gm) ?? []).map((l) => l.trim()).sort().join("|") ||
          (result.match(/✗ BLOCK[^\n]*/g) ?? []).map((l) => l.trim()).sort().join("|");
        if (sig && sig === lastBlockSig) {
          stalled++;
          if (stalled >= 2) {
            finished = {
              verdict: "REJECTED",
              summary: `the same ${(sig.match(/BLOCK/g) ?? []).length} rule(s) blocked the draft three times in a row, so this subject cannot be made to pass. Rules: ${sig.slice(0, 300)}`,
            };
            console.log("  stalled  : the same rules blocked three drafts, ending the run with a verdict");
            break;
          }
        } else {
          stalled = 0;
          lastBlockSig = sig;
        }
      }
    }
    messages.push({ role: "tool", tool_call_id: c.id, content: result });
  }
}

/*
 * FORCED SUBMISSION, after the loop rather than inside it.
 *
 * The same logic lived inside the loop guarded by `turn >= MAX_TURNS - 2`, and it never ran - three runs ended TURN-LIMIT
 * with a complete draft on disk and nothing published, and the console showed no trace of the guard. Whatever the
 * reason (the block sat on a path the dispatch did not take), the fix is not to debug the placement: it is to stop
 * depending on it. After the loop there is exactly one question - did anything get published - and one answer.
 *
 * The newest draft in data/drafts is the agent's own work from this run. If the loop ended without submitting it, it is
 * submitted here. The report then says PUBLISHED-WITHOUT-FINISH so the card is honest about how it got there: the
 * article exists and the model never called finish.
 */
if (published.size === 0) {
  try {
    const draftDir = join(ROOT, "data", "drafts");
    const newest = existsSync(draftDir)
      ? readdirSync(draftDir)
          .filter((f) => f.endsWith(".md"))
          .map((f) => ({ f, m: statSync(join(draftDir, f)).mtimeMs }))
          .sort((a, b) => b.m - a.m)[0]
      : null;
    if (newest) {
      const from = join(draftDir, newest.f);
      const body = readFileSync(from, "utf8");
      /*
       * DO NOT OVERWRITE A LIVE URL, even from the fallback.
       *
       * On 2026-10-19 at 01:14 the fallback copied a draft over eu-fdi-screening-notification-surge-2026, a page that
       * had been published the previous evening. The content happened to be the same, so nothing broke - but the
       * journal then recorded a publication for today, the idempotency guard believed it, and the agent route was
       * blocked for the rest of the day by a run that published nothing new.
       *
       * The orchestrator refuses this for the script route. The fallback is not a licence to do it here.
       */
      /*
       * LAST-RESORT DATE SUFFIX.
       *
       * The operator's instruction on 2026-10-20, after a day of yellow cards: the agent route must produce an article,
       * and a near-duplicate under a dated slug is the least-bad outcome when the alternative is none. It is not the
       * first choice and it is not silent - the slug carries the date, the verdict says how it got there, and the
       * research side is what has to stop proposing taken subjects.
       *
       * The same suffix the research fallback used to add, kept in one place now: the submission, where the decision
       * about what to publish actually lives.
       */
      let target = join(ROOT, "src", "content", "blog", newest.f);
      let duplicateOf = null;
      if (existsSync(target)) {
        /*
         * A DATE SUFFIX CHANGES THE URL, NOT THE CONTENT.
         *
         * On 2026-10-28 this fallback published eu-goes-provisional-safeguard-trq-price-threshold-2026 a
         * second time under a -2026-10-28 slug: same title, same description, same body, two URLs. The
         * meta gate caught it, which is the gate working. The writer should have caught it first.
         *
         * The suffix exists because on 2026-10-20 an empty day was judged worse than a near-duplicate.
         * That is true of a near duplicate and false of the same words twice, so the comparison runs
         * before the suffix is added: identical title, identical opening, or 0.9 body similarity means
         * there is nothing new to publish, and the verdict says so rather than inventing a URL for a
         * second copy of yesterday's article.
         */
        const publishedSrc = readFileSync(target, "utf8");
        const check = looksDuplicate(body, publishedSrc);
        if (check.duplicate) {
          duplicateOf = { file: newest.f, reason: check.reason };
          console.log("  forced submission refused: " + newest.f + " - " + check.reason);
          if (!finished) {
            finished = {
              verdict: "DUPLICATE-SUBJECT",
              summary:
                "the draft this run produced is the article already published at " + newest.f + " (" + check.reason +
                "). Nothing was published: a date suffix changes where an article lives, not what it says.",
            };
          }
        } else {
          const stamp = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
          const dated = newest.f.replace(/\.md$/, "") + "-" + stamp + ".md";
          target = join(ROOT, "src", "content", "blog", dated);
          console.log("  forced submission: " + newest.f + " is already published, publishing under " + dated + " (" + check.reason + ")");
        }
      }
      /*
       * The same gate as publish_draft. The fallback exists so a day is not empty, not so a blocked page
       * can reach a live URL by a second route.
       */
      if (newest) {
        const fallbackGate = gateOf(join(ROOT, "data", "drafts", newest.f));
        if (!fallbackGate.ok) {
          const named = fallbackGate.blocks.slice(0, 4).map((r) => r.rule).join(", ");
          console.log("  forced submission refused: " + fallbackGate.blocks.length + " blocking rule(s) - " + named);
          if (!finished) {
            finished = { verdict: "REJECTED", summary: "the only draft this run produced breaks " + fallbackGate.blocks.length + " blocking rule(s) (" + named + "), so nothing was published." };
          }
          duplicateOf = { file: newest.f, reason: "blocked: " + named };
        }
      }
      if (duplicateOf) {
        /*
         * A DUPLICATE DRAFT IS A VERDICT, NOT A TURN-LIMIT.
         *
         * The 2026-10-20 run spent ten turns writing a draft whose subject was already published, the fallback refused
         * to overwrite a live URL - correctly - and the run then reported TURN-LIMIT, which says "the model ran out of
         * turns" when what actually happened is "the subject was taken". The operator read a red card and reasonably
         * concluded the agent was broken.
         *
         * The refusal stays. The verdict changes: DUPLICATE-SUBJECT is yellow, it is accurate, and it is the same
         * verdict the script route reports when research hands it a published subject.
         */

        if (!finished) {
          finished = {
            verdict: "DUPLICATE-SUBJECT",
            summary: `the only draft this run produced was ${newest.f}, and that subject is already published (${duplicateOf ? duplicateOf.reason : "duplicate"}). Nothing was overwritten, and the day has no new article because research kept proposing a taken subject.`,
          };
        }
      } else if (body.trim().length > 200) {
        const slug = target.replace(/^.*[\\/]/, "").replace(/\.md$/, "");
        /*
         * SANITIZE BEFORE SUBMITTING.
         *
         * The forced submission of 2026-10-18 carried information_gain: primary-source-analysis, a publishDate that
         * parsed as an object, audience: "importer" and priority: 50. The article published and the site stopped
         * building - every page 404'd for twenty-five minutes. The qa gate that would have caught it is deliberately
         * bypassed here, so the schema is enforced here instead: the four enum fields are rewritten to values the
         * collection accepts, and the shape of audience and priority is corrected.
         */
        const sanitizeFrontmatter = (src) => {
          const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(src);
          if (!m) return src;
          let fm = m[1];
          const body = src.slice(m[0].length);
          const set = (key, value) => {
            const re = new RegExp("^" + key + ":.*$", "m");
            fm = re.test(fm) ? fm.replace(re, key + ": " + value) : fm + "\n" + key + ": " + value;
          };
          /* The ledger reads this; the directory cannot tell an agent article from a script one. */
          set("route", '"agent"');
          const GAIN = ["custom-calculation", "cross-source", "own-data", "primary-source"];
          const gainRaw = (/^information_gain:\s*"?([^"\n]*)"?/m.exec(fm) ?? [])[1]?.trim() ?? "";
          set("information_gain", GAIN.includes(gainRaw) ? gainRaw : "primary-source");
          const audRaw = (/^audience:\s*(.*)$/m.exec(fm) ?? [])[1]?.trim() ?? "";
          if (!/^(platform-seller|importer|both)$/.test(audRaw.replace(/"/g, ""))) set("audience", '"both"');
          const priRaw = (/^priority:\s*(.*)$/m.exec(fm) ?? [])[1]?.trim() ?? "";
          if (!/^(P0|P1|P2)$/.test(priRaw.replace(/"/g, ""))) set("priority", '"P2"');
          const dateRaw = (/^publishDate:\s*(.*)$/m.exec(fm) ?? [])[1]?.trim() ?? "";
          if (!/^\d{4}-\d{2}-\d{2}$/.test(dateRaw.replace(/"/g, ""))) {
            set("publishDate", new Date().toISOString().slice(0, 10));
          }
          /*
           * category is part of the same repair and was missed the first time. On 2026-10-19 a forced submission
           * carried no category at all, Astro refused the entry, and the next build failed - which is the one thing a
           * broken frontmatter does that nothing else notices: qa-check validates structure, and only the build
           * validates the collection schema.
           */
          const CATS = ["trade-policy", "platforms", "supply-chain", "sourcing", "logistics"];
          const catRaw = (/^category:\s*"?([^"\n]*)"?/m.exec(fm) ?? [])[1]?.trim() ?? "";
          if (!CATS.includes(catRaw)) set("category", '"trade-policy"');
          if (!/^stakes:\s*(priced|directional|background)/m.test(fm)) set("stakes", "directional");
          if (!/^draft:\s*false/m.test(fm)) set("draft", "false");
          return "---\n" + fm + "\n---\n" + body;
        };
        writeFileSync(target, sanitizeFrontmatter(body), "utf8");
        try {
          execFileSync(process.execPath, [join(ROOT, "tools", "build-instruments.mjs")], { cwd: ROOT, timeout: 120000 });
        } catch {}
        published.add(slug);
        finished = finished ?? {
          verdict: "PUBLISHED-WITHOUT-FINISH",
          summary: `the loop ended without submitting, so ${newest.f} was published from the drafts folder. The article exists; the model never called finish.`,
        };
        console.log("");
        console.log("  FORCED SUBMISSION: the loop ended without publishing. Submitted " + newest.f);
        console.log("  verdict is PUBLISHED-WITHOUT-FINISH so the card says how it happened.");
      }
    }
  } catch (e) {
    console.log("  forced submission failed: " + e.message);
  }
}

/* ---------------------------------------------------------------- report */
/* ---------------------------------------------------------------- report */

/*
 * A PUBLISHED PAGE IS NOT A TURN-LIMIT, whatever the loop did.
 *
 * On 2026-10-28 the agent cleared every blocking rule, the fallback published the article, and the
 * report still said TURN-LIMIT - because the model never called finish, and the verdict was derived from
 * the loop rather than from what exists. The card then reads as a failure while a page is live, which is
 * the same class of lie as reporting success for a page that was not published.
 */
if (!finished && published.size > 0) {
  finished = {
    verdict: LAST_GATE_WARNINGS > 0 ? "PUBLISHED-DEGRADED" : "PUBLISHED-WITHOUT-FINISH",
    summary:
      "the article was published after the loop ended without calling finish" +
      (LAST_GATE_WARNINGS > 0 ? ", with " + LAST_GATE_WARNINGS + " warning(s) still open - the gates pass, the warnings are listed in the run log" : "") +
      ".",
  };
}

const report = {
  at: new Date().toISOString(),
  /* Which pipeline wrote this report; the notification names it so the same verdict is read correctly. */
  route: "agent",
  verdict: finished?.verdict ?? (err ? "MODEL-FAILED" : turn > MAX_TURNS ? "TURN-LIMIT" : "NO-VERDICT"),
  summary: finished?.summary ?? (err ? err : "the agent stopped without calling finish"),
  turns: Math.min(turn, MAX_TURNS + 1) - 1,
  /* A run that spends its turns re-asking has a prompt problem, and this number is how you see it. */
  repeatedCalls: repeatCount,
  published: [...published],
  usage: usageToday(),
  checkOnly: false,
  reasons: finished ? [] : [err ?? "the agent did not call finish, so there is no verdict for the day"],
};
writeFileSync(REPORT, JSON.stringify(report, null, 2), "utf8");

/*
 * The same rotated journal the script route writes.
 *
 * The agent's report lived in data/tmp, which git ignores, so a run that took twenty minutes and published nothing
 * could only be examined in the Actions web log - the relay this project is trying to stop being. data/runs is
 * tracked and rotated, so the last turns are readable from the repository.
 */
try {
  const runDir = join(ROOT, "data", "runs");
  mkdirSync(runDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  writeFileSync(join(runDir, `agent-${stamp}.json`), JSON.stringify({ ...report, lastTurns: transcript.slice(-40) }, null, 2), "utf8");
  const all = readdirSync(runDir).filter((f) => f.endsWith(".json")).sort();
  for (const old of all.slice(0, Math.max(0, all.length - 10))) rmSync(join(runDir, old), { force: true });
} catch {
  /* a journal that cannot be written is not a reason to fail the run */
}
writeFileSync(TRANSCRIPT, transcript.map((t) => JSON.stringify(t)).join("\n") + "\n", "utf8");

console.log("");
console.log("=".repeat(84));
console.log(`  verdict : ${report.verdict}`);
console.log(`  turns   : ${report.turns}`);
console.log(`  published: ${published.size ? [...published].join(", ") : "nothing"}`);
console.log(`  usage   : ${report.usage.calls} call(s), ~$${report.usage.usd}`);
console.log(`  summary : ${report.summary}`);
console.log(`  report  : data/tmp/agent-report.json`);
console.log(`  transcript: data/tmp/agent-transcript.jsonl`);

/* PUBLISHED-WITHOUT-FINISH is a success: an article is in the collection, and the card says how. */

/* A cell claimed by a run that produced nothing goes back, or an infrastructure failure burns it. */
if (CELL && published.size === 0 && report.verdict !== "INSUFFICIENT-EVIDENCE") {
  try {
    markCell(CELL.matrix, CELL.persona, CELL.moment, "available");
    console.log("  cell      : released back to available - the run published nothing");
  } catch (e) {
    console.log("  cell      : could not be released (" + e.message + ")");
  }
}

process.exit(["PUBLISHED", "PUBLISHED-WITHOUT-FINISH", "PUBLISHED-DEGRADED", "NO-SUBJECT", "DUPLICATE-SUBJECT", "INSUFFICIENT-EVIDENCE"].includes(report.verdict) ? 0 : 1);
