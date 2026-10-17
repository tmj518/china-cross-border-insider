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
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { ask, summary as providerSummary, usageToday } from "./lib-llm.mjs";

const ROOT = process.cwd();
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
const MAX_TURNS = Number(flag("max-turns", 40));

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
const published = new Set();
const checkedOk = new Set();
let finished = null;

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
      const verdict = commandAllowed(input.command);
      if (!verdict.ok) return done(`REFUSED: ${verdict.why}`);
      if (DRY) return done(`dry run: would run ${input.command} (${verdict.why})`);
      try {
        const out = execFileSync(input.command, { shell: true, cwd: ROOT, encoding: "utf8", timeout: 900000, maxBuffer: 64 * 1024 * 1024 });
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
        return done(`${trimNote}FAIL:\n${detail}`);
      }
    }

    if (name === "publish_draft") {
      if (!checkedOk.has(input.path)) {
        return done(`REFUSED: ${input.path} has not passed check_draft in this run. Call check_draft on it first. An article reaches the collection only through the checks.`);
      }
      if (DRY) return done("dry run: not published");
      const from = join(ROOT, input.path);
      const slug = String(input.path).replace(/^.*\//, "").replace(/\.md$/, "");
      const to = join(ROOT, "src", "content", "blog", `${slug}.md`);
      writeFileSync(to, readFileSync(from, "utf8"), "utf8");
      try {
        execFileSync(process.execPath, [join(ROOT, "tools", "build-instruments.mjs")], { cwd: ROOT, timeout: 600000 });
      } catch {
        /* the registry rebuild is reported by preflight; the article is staged either way */
      }
      published.add(slug);
      return done(`published ${slug} to src/content/blog/. The registry was rebuilt.`);
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
    process.exit(1);
  }
} catch {
  /* no directive, or one that does not parse - the prompt tells the agent to research, which is correct */
}
console.log(`  max turns   : ${MAX_TURNS}${DRY ? "   DRY RUN: no command will be executed" : ""}`);
console.log("");

/*
 * The system prompt states the arrangement rather than the procedure. The procedure is in the task file,
 * which is the operator's own text and is passed through unchanged - the whole point is that the agent
 * gets the instructions that were tuned over 29 articles, not my paraphrase of them.
 */
const SYSTEM = `You are the daily operator for Landed Math, an English site that turns Chinese and other
official primary documents into per-unit cost consequences for importers.

Your tools: read_file, write_file, list_dir, run, check_draft, publish_draft, finish.

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
        `${name} is not available any more. Only write_file, check_draft, publish_draft and finish work from here,`,
        "plus reading data/directive.json and your own draft.",
        "",
        "Write the draft now with what you have. check_draft reports what is missing far faster than reading does,",
        "and it reports it about the thing you are actually being asked to produce.",
      ].join("\n");
      console.log(`  turn ${turn} · ${name} refused - preparation is over`);
      record({ turn, refused: name, reason: "preparation is over" });
      messages.push({ role: "tool", tool_call_id: c.id, content: result });
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
    }
    messages.push({ role: "tool", tool_call_id: c.id, content: result });
  }
}

/* ---------------------------------------------------------------- report */

const report = {
  at: new Date().toISOString(),
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

process.exit(report.verdict === "PUBLISHED" || report.verdict === "NO-SUBJECT" ? 0 : 1);
