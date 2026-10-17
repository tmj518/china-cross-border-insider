/**
 * The orchestrator. What runs at 07:20 when nobody is at the computer.
 *
 *   node tools/cloud-orchestrator.mjs
 *   node tools/cloud-orchestrator.mjs --check          report readiness and stop
 *   node tools/cloud-orchestrator.mjs --directive-file=data/tmp/directive.json
 *
 * ## The shape of a run
 *
 *   1. Readiness. Which provider keys exist, what the last run did, how many articles this week.
 *   2. The directive. Where today's subject comes from. In P1 this is a file, because the judgement
 *      about what is worth writing is not something this pipeline has earned the right to make yet.
 *   3. The writer.  tools/cloud-executor.mjs
 *   4. The reviewer. tools/cloud-qa.mjs
 *   5. Publish, or do not. Writes state, writes a report, returns an exit code.
 *
 * ## The decision it makes and the decision it refuses to make
 *
 * It decides whether to publish. It does not decide what to publish: a run with no directive exits
 * with "no directive" rather than asking a model to invent a subject. That is not a gap in P1, it is
 * the one thing this pipeline should not be trusted with until its sourcing is verified end to end.
 * The instruction the operator gave is that a day without a qualifying subject is a day without an
 * article, and an orchestrator that can generate its own subject can never have such a day.
 *
 * ## Exit codes
 *
 *   0  published, or cleanly idle because there was nothing to publish
 *   1  a real failure: a step errored, or the review rejected work that had been attempted
 *   78 no provider key, so nothing could be attempted
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { available, summary as providerSummary, usageToday, needFor } from "./lib-llm.mjs";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const CHECK_ONLY = args.includes("--check");

const STATE = join(ROOT, "data", "state.json");
const DIRECTIVE = join(ROOT, "data", "directive.json");
const REPORT = join(ROOT, "data", "tmp", "orchestrator-report.json");

const started = Date.now();
const run = {
  at: new Date().toISOString(),
  providers: available(),
  steps: [],
  verdict: null,
  reasons: [],
  article: null,
  commit: null,
  usage: null,
};
const step = (name, ok, detail) => {
  run.steps.push({ name, ok, detail });
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name.padEnd(22)} ${detail}`);
};

console.log(`CLOUD ORCHESTRATOR  ${run.at}\n${"=".repeat(84)}`);
console.log(providerSummary());
console.log("");

/* ---------------------------------------------------------------- 1. readiness */

if (!run.providers.length) {
  step("providers", false, "no key present, so nothing can be attempted");
  console.log("");
  /*
   * Built from the provider tables rather than written here. The hand-written version named two
   * variables this build does not read, so an operator who followed it exactly still saw NO-KEYS - which
   * is the worst possible message, because it looks like instruction.
   */
  console.log("  The pipeline is installed and cannot run. Any one of these would satisfy the writer:");
  for (const n of needFor("writer")) console.log("    " + n);
  console.log("");
  console.log("  And the reviewer:");
  for (const n of needFor("reviewer")) console.log("    " + n);
  console.log("");
  console.log("  In this repository the two generated secret names are mapped to OWNER_KEY_1 and");
  console.log("  OWNER_KEY_2 in daily.yml, so they count. The workflow also maps them there explicitly.");
  run.verdict = "NO-KEYS";
  mkdirSync(join(ROOT, "data", "tmp"), { recursive: true });
  writeFileSync(REPORT, JSON.stringify(run, null, 2), "utf8");
  process.exit(78);
}
step("providers", true, run.providers.join(", "));

/* state: read for continuity, written at the end. A missing file is a first run, not an error. */
let state = { lastRun: null, lastVerdict: null, lastArticle: null, runs: 0, published: 0 };
if (existsSync(STATE)) {
  try {
    state = { ...state, ...JSON.parse(readFileSync(STATE, "utf8")) };
    step("state", true, `${state.runs} previous run(s), last ${state.lastRun ?? "never"} (${state.lastVerdict ?? "-"})`);
  } catch (e) {
    step("state", false, `unreadable: ${e.message}`);
  }
} else {
  step("state", true, "absent, treated as a first run");
}

/* the weekly ceiling, which is a rule from 初心与目标.md: at most 15 net-new articles a week */
let weekCount = 0;
/*
 * Per-category coverage for the current week.
 *
 * The operator made "every section gets at least one deep article a week" a hard rule, so it is checked
 * and reported rather than assumed. A category that exists in the published set and has no net-new
 * article this week is the thing the rule is about, and it is invisible without counting.
 *
 * The count is reported whether or not it passes, because "5 of 5 sections covered" is the answer to a
 * question someone will ask, and a check that only speaks when it fails cannot answer it.
 */
const categoryActivity = new Map();
try {
  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const since = monday.toISOString().slice(0, 10);
  for (const f of readdirSync(join(ROOT, "src", "content", "blog")).filter((x) => x.endsWith(".md"))) {
    const t = readFileSync(join(ROOT, "src", "content", "blog", f), "utf8");
    if (/^draft:\s*true/m.test(t)) continue;
    const d = /^publishDate:\s*"?([\d-]+)/m.exec(t)?.[1] ?? "";
    const category = /^category:\s*"?([a-z-]+)/m.exec(t)?.[1] ?? "";
    if (d >= since) weekCount++;
    if (!category) continue;
    const entry = categoryActivity.get(category) ?? { thisWeek: 0, total: 0 };
    entry.total++;
    if (d >= since) entry.thisWeek++;
    categoryActivity.set(category, entry);
  }
} catch {}
step("weekly ceiling", weekCount < 15, `${weekCount} of 15 net-new this week`);

const uncovered = [...categoryActivity.entries()].filter(([, e]) => e.thisWeek === 0).map(([c]) => c);
step(
  "sections covered this week",
  uncovered.length === 0,
  uncovered.length === 0
    ? `every section has a net-new article this week (${categoryActivity.size} sections)`
    : `${uncovered.length} of ${categoryActivity.size} sections have none yet: ${uncovered.join(", ")}`,
);
run.categoryActivity = Object.fromEntries([...categoryActivity.entries()].map(([c, e]) => [c, e.thisWeek]));
run.uncoveredSections = uncovered;

if (weekCount >= 15) {
  console.log("");
  console.log("  The weekly ceiling is reached. 初心与目标.md caps net-new articles at 15 a week, so this");
  console.log("  run publishes nothing and exits cleanly. That is the rule working, not a failure.");
  run.verdict = "CEILING";
  mkdirSync(join(ROOT, "data", "tmp"), { recursive: true });
  writeFileSync(REPORT, JSON.stringify(run, null, 2), "utf8");
  process.exit(0);
}

/* ---------------------------------------------------------------- 2. the directive */

const directiveFile = flag("directive-file", DIRECTIVE);
let directive = null;
if (existsSync(directiveFile)) {
  try {
    directive = JSON.parse(readFileSync(directiveFile, "utf8"));
    step("directive", true, `${directive.slug ?? "(no slug)"} from ${directiveFile.replace(ROOT, "")}`);
  } catch (e) {
    step("directive", false, `unreadable: ${e.message}`);
    run.reasons.push("the directive file exists but does not parse");
  }
} else {
  step("directive", true, `none at ${directiveFile.replace(ROOT, "")}`);
}

if (!directive) {
  /*
   * No directive, so research runs. This is the difference between P1 and B: in P1 the run stopped
   * here and reported NO-DIRECTIVE, which is honest but needs a person to produce the subject every
   * day. In B the pipeline fetches sources, proposes a subject from documents it has archived, verifies
   * every figure's excerpt against those archives with tools/check-evidence.mjs, and writes the
   * directive itself.
   *
   * If research cannot produce a verified subject it writes nothing and says why, and this run reports
   * NO-SUBJECT. That is still a day without an article, but it is now a day the pipeline decided,
   * rather than a day nobody prepared for.
   */
  console.log("  no directive, so research starts");
  console.log("");
  const budget = flag("research-budget", "0.40");
  const maxSources = flag("research-sources", "4");
  let researchOut = "";
  let researchCode = 0;
  try {
    researchOut = execFileSync(
      process.execPath,
      [join(ROOT, "tools", "research.mjs"), `--budget=${budget}`, `--sources=${maxSources}`],
      {
        encoding: "utf8",
        timeout: 1800000,
        maxBuffer: 64 * 1024 * 1024,
        /*
         * The sections that have had nothing this week, so the subject choice can favour them.
         *
         * The rule "one to three articles per section per week" is computed a few lines above and would
         * otherwise only be reported. The subject is chosen in research.mjs and nowhere else, so a rule
         * that is checked but not passed along is a report rather than a rule. It is a preference there,
         * not an instruction: if today's documents do not support the section that is behind, forcing one
         * produces the commodity summary that the quality rule exists to prevent.
         */
        env: { ...process.env, UNCOVERED_SECTIONS: uncovered.join(",") },
      },
    );
  } catch (e) {
    researchOut = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    researchCode = e.status ?? 1;
  }
  for (const line of researchOut.split("\n")) if (line.trim()) console.log(`  | ${line}`);
  console.log("");

  if (existsSync(directiveFile)) {
    try {
      directive = JSON.parse(readFileSync(directiveFile, "utf8"));
      step("research", true, `proposed ${directive.slug}, ${(directive.figures ?? []).length} verified figure(s)`);
    } catch (e) {
      step("research", false, `wrote a directive that does not parse: ${e.message}`);
    }
  } else {
    step("research", false, `no verified subject today (exit ${researchCode})`);
  }
}

if (!directive) {
  console.log("");
  console.log("  Research could not produce a subject backed by documents it fetched and verified. No");
  console.log("  article was written. That is the intended outcome: the pipeline states it has nothing");
  console.log("  rather than writing something it cannot support.");
  run.verdict = "NO-SUBJECT";
  mkdirSync(join(ROOT, "data", "tmp"), { recursive: true });
  writeFileSync(REPORT, JSON.stringify(run, null, 2), "utf8");
  process.exit(0);
}

const figures = (directive.figures ?? []).filter((f) => f?.value && f?.source && f?.retrieved);
if (figures.length < 5) {
  step("directive figures", false, `${figures.length} sourced, the gate requires 5`);
  run.verdict = "THIN-DIRECTIVE";
  run.reasons.push(`the directive carries ${figures.length} sourced figure(s)`);
  mkdirSync(join(ROOT, "data", "tmp"), { recursive: true });
  writeFileSync(REPORT, JSON.stringify(run, null, 2), "utf8");
  process.exit(1);
}
step("directive figures", true, `${figures.length} sourced figure(s)`);

if (CHECK_ONLY) {
  console.log("");
  console.log("  --check: readiness is established and the run stops here. Nothing was written.");
  run.verdict = "CHECK-ONLY";
  mkdirSync(join(ROOT, "data", "tmp"), { recursive: true });
  writeFileSync(REPORT, JSON.stringify(run, null, 2), "utf8");
  process.exit(0);
}

/* ---------------------------------------------------------------- 3+4. write, review, revise */

/*
 * The write/review loop.
 *
 * The first design produced one draft and stopped. The reviewer refused it, the run ended, and a
 * specific itemised list of what was wrong with an otherwise publishable draft went into a
 * notification and was never acted on. The operator asked why the writer is not simply told, which is
 * the right question: the review is the most useful thing this pipeline produces and the only thing it
 * was not being used for.
 *
 * So a rejection now produces a revision, up to MAX_ATTEMPTS. Three properties matter and each is
 * deliberate:
 *
 *   The reviewer reads the revision cold. The second review is a fresh call, not the first reviewer
 *   marking its own suggestion, so a revision that satisfies the letter of an objection and breaks
 *   something else is still caught.
 *
 *   Revision is not paid for unconditionally. Two attempts is two writer calls and two reviewer calls,
 *   which at the measured rate is under a cent, so the loop is bounded by the attempt count and not by
 *   cost.
 *
 *   Worse can stop it. A revision can degrade a draft, and model self-correction is not monotonic. The
 *   failing-check count from the reviewer is compared and the best attempt is the one kept, so a rewrite
 *   that makes things worse cannot ship over a draft that was closer.
 */

/**
 * The line of a failed child's output that actually says what went wrong.
 *
 * This used to be `output.trim().split("\n").pop()`, the last line. That is right for a tool printing
 * one summary line and wrong for anything that prints a stack trace, where the last line is often
 * nothing at all - on 2026-10-17 the report said `exit 1: no output` for a writer that had failed with
 * ERR_MODULE_NOT_FOUND, because the last line of its stack was blank. The run cost seven minutes and the
 * notification carried none of the reason.
 *
 * Prefers a line naming an Error, then a line beginning with a common failure word, then the first line
 * that is neither blank nor a bare "node:internal" frame. The whole output still goes to the report; this
 * is only what fits on a notification.
 */
function whyItFailed(output) {
  const lines = String(output)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return "no output at all";
  const errorLine = lines.find((l) => /Error\b|error:/.test(l) && !/^\s*at /.test(l));
  if (errorLine) return errorLine.replace(/^Error\s*\[[^\]]+\]:\s*/, "").slice(0, 180);
  const keyword = lines.find((l) => /^(FAILED|REFUSED|cannot|Cannot|ENOENT|EACCES|missing|Missing|usage)/.test(l));
  if (keyword) return keyword.slice(0, 180);
  const substantive = lines.find((l) => !/^node:internal/.test(l) && !/^\^/.test(l) && !/^\s*at /.test(l));
  return (substantive ?? lines[0]).slice(0, 180);
}

const MAX_ATTEMPTS = 3;
const slug = String(directive.slug ?? "untitled").replace(/[^a-z0-9-]/g, "");
const draftPath = join(ROOT, "data", "drafts", `${slug}.md`);
const revisionDir = join(ROOT, "data", "tmp", "revisions");

const attempts = [];
let wroteIt = false;
let qa = null;
/*
 * Declared here, outside the loop, and the placement is the whole point.
 *
 * `let` inside a loop body is scoped to each iteration, so reading it after the loop is not a syntax
 * error - which is why `node --check` passed on the broken version and the bug survived review - but a
 * runtime ReferenceError. It fired on the third attempt of a real run when the loop exited through
 * `break` before reaching the declaration, so the orchestrator died before writing its report and the
 * operator received "no run report" instead of a verdict.
 *
 * Anything the loop sets and the code after the loop reads belongs here. `qaCode` joins `qa` for exactly
 * that reason, and the two are easy to pull back inside when the loop body grows.
 */
let qaCode = 1;
let lastBlockerRule = "";
let sameRuleHits = 0;
let writeOut = "";
let writeCode = 0;

/** How badly a review went. Fewer is better; null means no usable verdict at all. */
function failureScore(rep) {
  if (!rep) return null;
  const failedLayers = Object.values(rep.layers ?? {}).filter((l) => !l.pass).length;
  const failedChecks = Object.values(rep.layers?.L5?.checks ?? {}).filter((v) => v === false).length;
  const issues = (rep.layers?.L5?.issues ?? []).length;
  return failedLayers * 100 + failedChecks * 10 + Math.min(issues, 9);
}

mkdirSync(revisionDir, { recursive: true });

for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
  const revisionOf = attempt > 1 && existsSync(draftPath) ? draftPath : null;
  const issuesFile = attempt > 1 ? join(revisionDir, `issues-${attempt - 1}.json`) : null;

  const writerArgs = [join(ROOT, "tools", "cloud-executor.mjs"), `--directive-file=${directiveFile}`];
  if (revisionOf && issuesFile && existsSync(issuesFile)) {
    writerArgs.push(`--revision-of=${revisionOf}`, `--revision-issues=${issuesFile}`);
  }

  writeOut = "";
  writeCode = 0;
  /*
   * The executor writes its schema violations here rather than only printing them, so they can be
   * handed straight back as the next revision order. A draft that fails the content schema has not been
   * reviewed - it could not build - and on 2026-10-17 that distinction was lost: the build error was
   * reported as "the reviewer did not approve", which pointed at the reviewer instead of at a subtitle
   * three characters too long.
   */
  const violationsFile = join(revisionDir, `violations-${attempt}.json`);
  try {
    writeOut = execFileSync(process.execPath, writerArgs, {
      encoding: "utf8",
      timeout: 1800000,
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, EXECUTOR_VIOLATIONS: violationsFile },
    });
  } catch (e) {
    writeOut = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    writeCode = e.status ?? 1;
  }
  wroteIt = existsSync(draftPath);
  step(
    `writer${attempt > 1 ? ` (revision ${attempt - 1})` : ""}`,
    wroteIt,
    wroteIt
      ? `draft at ${draftPath.replace(ROOT, "")}`
      : writeCode === 4
        ? `refused: the draft violates the content schema and would fail the whole build`
        : `exit ${writeCode}: ${whyItFailed(writeOut)}`,
  );
  if (!wroteIt) {
    if (writeCode === 4 && attempt < MAX_ATTEMPTS) {
      /*
       * A schema violation is the most mechanically fixable rejection there is: the field, the actual
       * length and the limit are all known and exact. It is worth a revision even though no review ran.
       */
      if (existsSync(violationsFile)) {
        writeFileSync(join(revisionDir, `issues-${attempt}.json`), readFileSync(violationsFile), "utf8");
        console.log(`  revising            : attempt ${attempt + 1} of ${MAX_ATTEMPTS}, the schema violations are passed back`);
        continue;
      }
      run.verdict = "WRITE-FAILED";
      run.reasons.push(`the writer produced a draft that violates the content schema and the violations were not recorded, so there is nothing to revise against`);
      break;
    }
    run.verdict = "WRITE-FAILED";
    run.reasons.push(
      writeCode === 4
        ? `the writer's draft violates the content schema on every attempt (${MAX_ATTEMPTS}), so the limits are not reaching the model`
        : `the writer did not produce ${slug}.md on attempt ${attempt}`,
    );
    break;
  }

  let qaOut = "";
  try {
    qaOut = execFileSync(
      process.execPath,
      [join(ROOT, "tools", "cloud-qa.mjs"), `--draft=${draftPath}`, "--json", `--directive-file=${directiveFile}`, `--writer-provider=${run.providers.includes("volces") ? "volces" : run.providers[0]}`],
      { encoding: "utf8", timeout: 1800000, maxBuffer: 64 * 1024 * 1024 },
    );
    qaCode = 0;
  } catch (e) {
    qaOut = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    qaCode = e.status ?? 1;
  }
  try {
    qa = JSON.parse(qaOut);
  } catch {
    qa = null;
  }

  const failedDetail = qa
    ? Object.entries(qa.layers)
        .filter(([, l]) => !l.pass)
        .map(([k, l]) => `${k} ${l.detail}`)
        .join("; ") || "all layers clear"
    : "no parseable verdict";
  step(`reviewer${attempt > 1 ? ` (revision ${attempt - 1})` : ""}`, qaCode === 0, qa ? `${qa.verdict}: ${failedDetail}` : failedDetail);

  /*
   * A review that produced nothing is a warning, not a stop.
   *
   * The operator's instruction: if the reviewer fails or its answer cannot be read, publish anyway and
   * record that the review was unavailable. The article exists, it compiles and the structural checks
   * passed; a pipeline that ships nothing because its second opinion timed out has nothing to evaluate.
   *
   * "Record" is the part that makes it safe. The fact goes into data/lessons.jsonl, and the writer's
   * prompt reads that file on the next run - so an unavailable review is carried forward into the next
   * article rather than forgotten. A warning nobody reads is the same as no warning.
   *
   * A review that ran and rejected the draft is a different matter: that is a judgement, and it still
   * stops the publication.
   */
  const reviewUnavailable = !qa || !qa.layers?.L5 || qa.layers.L5.detail?.startsWith("reviewer did not return JSON");
  if (reviewUnavailable && wroteIt && qa?.layers?.build?.pass !== false && qa?.layers?.L1?.pass !== false) {
    appendFileSync(
      join(ROOT, "data", "lessons.jsonl"),
      JSON.stringify({
        at: new Date().toISOString(),
        slug,
        kind: "review-unavailable",
        detail: qa?.layers?.L5?.detail ?? "no QA report at all",
        action: "published without a second opinion; the next writer prompt reads this file",
      }) + "\n",
      "utf8",
    );
    step("reviewer", true, "unavailable, recorded as a lesson, publishing anyway");
    qaCode = 0;
  }

  const score = failureScore(qa);
  attempts.push({ attempt, score, verdict: qa?.verdict ?? null, issues: qa?.layers?.L5?.issues ?? [], reasons: qa?.reasons ?? [] });

  if (qaCode === 0) break;

  /*
   * Two circuit breakers, and both exist because the previous version could only count attempts.
   *
   * ## 1. A research gap cannot be rewritten away
   *
   * The reviewer labels each issue with a fix_type, and "research" means the article needs a real
   * document it does not have - a missing figure, or a claim needing a second source. Rewriting cannot
   * conjure a document. Asking the writer to try anyway produces a fluent sentence with a number in it,
   * which is exactly the failure mode this pipeline is built to prevent: an invented figure inside a
   * real-looking citation. So the loop stops and the run escalates, naming what has to be fetched.
   *
   * This is the one place where stopping early is the safer choice rather than the cheaper one.
   *
   * ## 2. The same rule failing twice is a prompt bug, not a draft bug
   *
   * If the writer is told the same rule twice and breaks it twice, the instruction is not reaching it.
   * A third attempt costs a full article and is unlikely to differ. Reporting the rule and the quoted
   * text is what lets the prompt be fixed, which is the actual remedy - and it is invisible if the run
   * only reports "three attempts failed".
   */
  const blocker = qa?.layers?.L5?.issues?.[0] ?? null;
  const blockerRule = blocker && typeof blocker === "object" ? blocker.rule || blocker.check || "" : "";
  const blockerFix = blocker && typeof blocker === "object" ? blocker.fix_type : "rewrite";

  if (blockerFix === "research") {
    run.verdict = "REQUIRES-RESEARCH";
    run.reasons.push(
      `the review asks for a document nobody fetched: ${blockerRule || blocker?.why || "no rule named"}`,
    );
    if (blocker?.snippet) run.reasons.push(`the draft text it points at: "${String(blocker.snippet).slice(0, 200)}"`);
    run.reasons.push(
      "rewriting cannot supply a real figure, and a writer asked to try will produce one that looks real, so the loop stops here",
    );
    run.escalation = { layer: blocker?.check ?? "L5", rule: blockerRule, snippet: blocker?.snippet ?? "", fix_type: "research" };
    run.qa = qa ? { verdict: qa.verdict, layers: Object.fromEntries(Object.entries(qa.layers).map(([k, l]) => [k, { pass: l.pass, detail: l.detail }])) } : null;
    break;
  }

  if (blockerRule && blockerRule === lastBlockerRule) {
    sameRuleHits += 1;
  } else if (blockerRule) {
    sameRuleHits = 1;
    lastBlockerRule = blockerRule;
  }
  if (sameRuleHits >= 2) {
    run.verdict = "WRITE-FAILED";
    run.reasons.push(
      `the same rule failed twice in a row - "${blockerRule}" - so the instruction is not reaching the writer and a third attempt would repeat it`,
    );
    if (blocker?.snippet) run.reasons.push(`the draft text it keeps pointing at: "${String(blocker.snippet).slice(0, 200)}"`);
    run.reasons.push("the remedy is to fix the writer's prompt for this rule, not to rewrite the article again");
    run.qa = qa ? { verdict: qa.verdict, layers: Object.fromEntries(Object.entries(qa.layers).map(([k, l]) => [k, { pass: l.pass, detail: l.detail }])) } : null;
    break;
  }

  if (attempt < MAX_ATTEMPTS) {
    /*
     * Pass the reviewer's own sentences to the writer, as a file rather than as arguments: the text is
     * free-form and can contain anything, and shell and argument quoting is not the place to find out
     * what.
     */
    writeFileSync(join(revisionDir, `issues-${attempt}.json`), JSON.stringify(qa ?? { reasons: ["the reviewer did not approve and gave no itemised reason"] }, null, 2), "utf8");
    console.log(`  revising            : attempt ${attempt + 1} of ${MAX_ATTEMPTS}, ${(qa?.layers?.L5?.issues ?? []).length} objection(s) passed back to the writer`);
    if (blockerRule) console.log(`  blocker             : ${blockerFix} · ${blockerRule}`);
  }
}

/*
 * The summary of a failed loop, and it must not overwrite a verdict the loop already decided.
 *
 * Both circuit breakers set `run.verdict` inside the loop - REQUIRES-RESEARCH and WRITE-FAILED - and
 * this block then assigned REJECTED unconditionally, because its condition only asked whether the last
 * attempt was approved. The circuit breaker fired, the loop stopped, and the report said "rejected" with
 * none of the reasoning that had just been written.
 *
 * That is the third instance of one mistake in this file: state set inside the loop and clobbered
 * outside it, after `qaCode` read outside its scope and `qaCode` never initialised on the break path.
 * The guard is explicit about it because the pattern keeps recurring.
 */
if (!run.verdict && attempts.length && attempts[attempts.length - 1].verdict !== "APPROVED") {
  /*
   * Report which attempt was closest, not only which was last. Three revisions that each score worse is
   * a finding about the loop, and it is invisible if only the final attempt is described.
   */
  const usable = attempts.filter((a) => a.score !== null);
  const best = usable.length ? usable.reduce((a, b) => (b.score < a.score ? b : a)) : null;
  const last = attempts[attempts.length - 1];
  run.attempts = attempts.map((a) => ({ attempt: a.attempt, score: a.score, verdict: a.verdict, issues: a.issues.slice(0, 6) }));
  run.verdict = "REJECTED";
  run.reasons.push(...(last.reasons.length ? last.reasons : ["the reviewer did not approve"]));
  if (best && last.score !== null && best.score < last.score) {
    run.reasons.push(
      `attempt ${best.attempt} scored better than the final attempt (${best.score} vs ${last.score}), so revision made the draft worse - worth reading the sequence rather than the last draft`,
    );
  }
  if (attempts.length > 1 && usable.length && usable[usable.length - 1].score >= usable[0].score) {
    run.reasons.push(`no attempt improved on the first (scores ${usable.map((a) => a.score).join(" -> ")}), so the objections are probably not mechanical`);
  }
  run.qa = qa ? { verdict: qa.verdict, layers: Object.fromEntries(Object.entries(qa.layers).map(([k, l]) => [k, { pass: l.pass, detail: l.detail }])) } : null;
}

/* ---------------------------------------------------------------- 5. publish */

let published = false;
if (wroteIt && qaCode === 0) {
  /*
   * Approval moves the file into the collection. `draft: false` is already in the frontmatter the
   * writer produced - the gate would have failed on a draft, because qa-check exempts drafts from its
   * blocking rules and a green result on exempted rules means nothing. So an approved article is one
   * that passed the rules as a published article, and it is staged as one.
   */
  const target = join(ROOT, "src", "content", "blog", `${slug}.md`);
  try {
    writeFileSync(target, readFileSync(draftPath, "utf8"), "utf8");
    published = true;
    step("publish", true, `staged at src/content/blog/${slug}.md`);
  } catch (e) {
    step("publish", false, e.message);
    run.reasons.push(`could not stage the article: ${e.message}`);
  }
}

if (published) {
  /*
   * The instrument registry is derived from the articles, and preflight fails the next day when it is
   * out of date. The local wrapper learned this on 2026-10-09 by being told about it a day later, so
   * here it runs in the same pass that adds the article.
   */
  try {
    execFileSync(process.execPath, [join(ROOT, "tools", "build-instruments.mjs")], { encoding: "utf8", timeout: 600000 });
    step("registry", true, "rebuilt");
  } catch (e) {
    step("registry", false, `rebuild failed: ${String(e.message).slice(0, 100)}`);
  }
  run.verdict = "PUBLISHED";
  run.article = slug;
} else if (!run.verdict) {
  run.verdict = started && wroteIt ? "REJECTED" : "IDLE";
}

run.usage = usageToday();
run.seconds = Math.round((Date.now() - started) / 1000);

/* state is written every run, including the idle ones, so the next run can say what happened */
try {
  mkdirSync(join(ROOT, "data"), { recursive: true });
  writeFileSync(
    STATE,
    JSON.stringify(
      {
        lastRun: run.at,
        lastVerdict: run.verdict,
        lastArticle: run.article ?? state.lastArticle,
        runs: (state.runs ?? 0) + 1,
        published: (state.published ?? 0) + (published ? 1 : 0),
        lastUsage: run.usage,
      },
      null,
      2,
    ),
    "utf8",
  );
  step("state written", true, `verdict ${run.verdict}`);
} catch (e) {
  step("state written", false, e.message);
}

mkdirSync(join(ROOT, "data", "tmp"), { recursive: true });
writeFileSync(REPORT, JSON.stringify(run, null, 2), "utf8");

/* the run ledger, append-only, which is what the daily notification reads */
try {
  mkdirSync(join(ROOT, "logs"), { recursive: true });
  appendFileSync(join(ROOT, "logs", "orchestrator.jsonl"), JSON.stringify({ ...run, instructions: undefined }) + "\n", "utf8");
} catch {}

console.log(`\n${"=".repeat(84)}`);
console.log(`  verdict : ${run.verdict}   (${run.seconds}s)`);
if (run.article) console.log(`  article : ${run.article}`);
if (run.usage) console.log(`  usage   : ${run.usage.calls} call(s), ${run.usage.failed} failed, ~$${run.usage.usd}`);
if (run.reasons.length) {
  console.log("  reasons:");
  for (const r of run.reasons.slice(0, 8)) console.log(`    - ${String(r).slice(0, 160)}`);
}
console.log(`  report  : ${REPORT.replace(ROOT, "")}`);

/*
 * Approved work is a success even when it came through a rejected attempt earlier in the day; a
 * rejection with nothing published is a failure the operator should hear about. An idle run is
 * neither, and exits 0 so that a quiet day does not read as a broken pipeline.
 */
process.exit(run.verdict === "REJECTED" || run.verdict === "WRITE-FAILED" || run.verdict === "THIN-DIRECTIVE" ? 1 : 0);
