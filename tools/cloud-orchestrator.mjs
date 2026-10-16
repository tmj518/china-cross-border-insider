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
import { available, summary as providerSummary, usageToday } from "./lib-llm.mjs";

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
  console.log("  The pipeline is installed and cannot run. Set these as repository secrets:");
  console.log("    DEEPSEEK_API_KEY   the default provider for planning and writing");
  console.log("    OPENAI_API_KEY     used when a second, different model is the point of the review");
  console.log("  With only one of the two the pipeline runs and reports that its review was not");
  console.log("  independent, because a silent downgrade is worse than a reported one.");
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
try {
  const today = new Date();
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
  const since = monday.toISOString().slice(0, 10);
  for (const f of readdirSync(join(ROOT, "src", "content", "blog")).filter((x) => x.endsWith(".md"))) {
    const t = readFileSync(join(ROOT, "src", "content", "blog", f), "utf8");
    const d = /^publishDate:\s*"?([\d-]+)/m.exec(t)?.[1] ?? "";
    if (d >= since) weekCount++;
  }
} catch {}
step("weekly ceiling", weekCount < 15, `${weekCount} of 15 net-new this week`);

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
      { encoding: "utf8", timeout: 1800000, maxBuffer: 64 * 1024 * 1024 },
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

/* ---------------------------------------------------------------- 3. write, 4. review */

const slug = String(directive.slug ?? "untitled").replace(/[^a-z0-9-]/g, "");
const draftPath = join(ROOT, "data", "drafts", `${slug}.md`);

let writeOut = "";
let writeCode = 0;
try {
  writeOut = execFileSync(process.execPath, [join(ROOT, "tools", "cloud-executor.mjs"), `--directive-file=${directiveFile}`], { encoding: "utf8", timeout: 1800000, maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  writeOut = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  writeCode = e.status ?? 1;
}
const wroteIt = existsSync(draftPath);
step("writer", wroteIt, wroteIt ? `draft at ${draftPath.replace(ROOT, "")}` : `exit ${writeCode}: ${writeOut.trim().split("\n").pop()?.slice(0, 120) ?? "no output"}`);
if (!wroteIt) {
  run.verdict = "WRITE-FAILED";
  run.reasons.push(`the writer did not produce ${slug}.md`);
}

let qaCode = 1;
let qa = null;
if (wroteIt) {
  let qaOut = "";
  try {
    qaOut = execFileSync(process.execPath, [join(ROOT, "tools", "cloud-qa.mjs"), `--draft=${draftPath}`, "--json", `--writer-provider=${run.providers.includes("deepseek") ? "deepseek" : run.providers[0]}`], { encoding: "utf8", timeout: 1800000, maxBuffer: 64 * 1024 * 1024 });
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
  step("reviewer", qaCode === 0, qa ? `${qa.verdict}: ${Object.entries(qa.layers).filter(([, l]) => !l.pass).map(([k, l]) => `${k} ${l.detail}`).join("; ") || "all layers clear"}` : "no parseable verdict");
  run.qa = qa ? { verdict: qa.verdict, layers: Object.fromEntries(Object.entries(qa.layers).map(([k, l]) => [k, { pass: l.pass, detail: l.detail }])) } : null;
  if (qaCode !== 0) {
    run.verdict = "REJECTED";
    run.reasons.push(...(qa?.reasons ?? ["the reviewer did not approve"]));
  }
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
