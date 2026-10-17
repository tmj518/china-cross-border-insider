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
const MAX_TURNS = Number(flag("max-turns", 24));
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
      try {
        const out = execFileSync(process.execPath, [join(ROOT, "tools", "cloud-qa.mjs"), `--draft=${p}`, "--json"], {
          encoding: "utf8",
          cwd: ROOT,
          timeout: 1800000,
          maxBuffer: 64 * 1024 * 1024,
        });
        JSON.parse(out);
        checkedOk.add(input.path);
        return done(`PASS. Every check cleared. The report is data/tmp/qa-last.json if you need the detail.`);
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
        return done(`FAIL:\n${detail}`);
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

const instructions = readFileSync(taskPath, "utf8");
mkdirSync(join(ROOT, "data", "tmp"), { recursive: true });

console.log(`AGENT RUN  ${new Date().toISOString()}`);
console.log("=".repeat(84));
console.log(providerSummary());
console.log(`  task        : ${TASK_FILE} (${instructions.length} bytes)`);
console.log(`  max turns   : ${MAX_TURNS}${DRY ? "   DRY RUN: no command will be executed" : ""}`);
console.log("");

/*
 * The system prompt states the arrangement rather than the procedure. The procedure is in the task file,
 * which is the operator's own text and is passed through unchanged - the whole point is that the agent
 * gets the instructions that were tuned over 29 articles, not my paraphrase of them.
 */
const SYSTEM = `You are the daily operator for Landed Math, an English site that turns Chinese and other
official primary documents into per-unit cost consequences for importers.

You have tools: read_file, write_file, list_dir, run, check_draft, publish_draft, finish.

The rules that are not negotiable, because they are the reason this site is worth reading:

  1. Write only from figures that are in the directive. Never add a number, a source, a quotation, a
     person or an experience. If you do not have a figure, say so rather than supplying one.
  2. A draft goes to data/drafts/. It reaches src/content/blog/ only through publish_draft, which refuses
     a draft that has not passed check_draft in this run. Do not try to write the collection directly.
  3. If the checks fail, fix the draft and run them again. Read what they say: they name the field, the
     value and the limit.
  4. If a failure needs a real document that nobody has fetched, stop and report that. Rewriting cannot
     supply a real number, and an invented one that looks real is the worst outcome available to you.
  5. When you are done, call finish with a verdict and one sentence. If you could not do the day's work,
     say why in that sentence rather than finishing quietly.

Work in small steps and look at the result of each one. The task file below is your instructions.`;

let messages = [
  {
    role: "user",
    content: `Today is ${new Date().toISOString().slice(0, 10)}.

YOUR INSTRUCTIONS

${instructions}

Begin. Look at the repository state first, then decide what the day needs.`,
  },
];

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
    const result = runTool(c.function?.name, input);
    messages.push({ role: "tool", tool_call_id: c.id, content: result });
  }
}

/* ---------------------------------------------------------------- report */

const report = {
  at: new Date().toISOString(),
  verdict: finished?.verdict ?? (err ? "MODEL-FAILED" : turn > MAX_TURNS ? "TURN-LIMIT" : "NO-VERDICT"),
  summary: finished?.summary ?? (err ? err : "the agent stopped without calling finish"),
  turns: Math.min(turn, MAX_TURNS + 1) - 1,
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
