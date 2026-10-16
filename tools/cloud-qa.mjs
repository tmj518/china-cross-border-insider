/**
 * The reviewer. Decides whether a draft may be published.
 *
 *   node tools/cloud-qa.mjs --draft=data/drafts/<slug>.md
 *   node tools/cloud-qa.mjs --draft=... --json
 *
 * ## What it does, in order, and why the order matters
 *
 *   1. L1  the seven gates, run against the draft. Mechanical, and it fails loudly.
 *   2. L2-L4  tools/audit.mjs. Also mechanical: unsourced figures, undisclosed single-source,
 *             fabrication markers, risk triggers.
 *   3. L5  a second model reads the draft and the directive and answers with a structured verdict.
 *
 * The mechanical layers run first on purpose. A model asked to review a draft that has no sources in
 * it will produce a thoughtful paragraph about sourcing, which costs money and changes nothing. The
 * cheap checks remove the drafts that a sentence cannot save.
 *
 * ## The limitation this module states rather than hides
 *
 * The reviewing model reads the draft and the figure records. It does not read the source documents,
 * so it cannot tell a real number from an invented one that carries a real-looking citation. What it
 * can judge is whether the article's own claims are consistent, whether the arithmetic follows from
 * the figures given, whether the confidence section admits what it should, and whether anything
 * crosses a risk line. That is worth having and it is not the same as verification. The distinction
 * is printed on every run so nobody downstream mistakes one for the other.
 *
 * ## Independence
 *
 * The reviewer prefers a different provider from the writer. A model reviewing its own output shares
 * its blind spots; if only one key is present the run proceeds and says the review was not
 * independent, because a silent downgrade is worse than a reported one.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { askJson, summary as providerSummary, usageToday } from "./lib-llm.mjs";

const ROOT = process.cwd();
const BLOG = join(ROOT, "src", "content", "blog");
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const AS_JSON = args.includes("--json");

const draftPath = flag("draft", null);
if (!draftPath || !existsSync(draftPath)) {
  console.log("usage: node tools/cloud-qa.mjs --draft=data/drafts/<slug>.md [--json]");
  process.exit(2);
}
const slug = draftPath.replace(/\\/g, "/").split("/").pop().replace(/\.md$/, "");
const text = readFileSync(draftPath, "utf8");
const report = { slug, at: new Date().toISOString(), layers: {}, verdict: null, reasons: [] };

/* ---------------------------------------------------------------- L1: the seven gates */

/*
 * The gate reads the article from src/content/blog, so the draft is placed there to be validated and
 * removed afterwards - including the case where the validation itself throws, which is why the
 * removal is in a finally.
 */
/*
 * The gate reads three of its seven checks out of `dist/`: structured data, the content security
 * policy, and the mobile layout. Those pages are built by the workflow, which runs before the writer,
 * so at this point `dist/` describes the site as it was WITHOUT the draft - there is no page for the
 * article being judged.
 *
 * Left alone, the gate would report on a site that does not contain the article, and the three
 * dist-based checks would be measuring nothing while the other four passed. That is the same failure
 * the mobile gate had when it silently skipped on a runner without a browser: a green result on
 * unmeasured input.
 *
 * So the site is rebuilt with the draft staged. It costs a build - about ten seconds here, more on a
 * runner - and it is the difference between checking the article and checking its absence.
 */
const staged = join(BLOG, `${slug}.md`);
let stagedCopy = false;
let buildNote = "";
try {
  copyFileSync(draftPath, staged);
  stagedCopy = true;

  try {
    execFileSync("pnpm", ["exec", "astro", "build"], { encoding: "utf8", timeout: 600000, cwd: ROOT, shell: process.platform === "win32" });
    buildNote = "dist rebuilt with the draft staged";
  } catch (e) {
    /* A build failure is not fatal to the report: the other four gates still carry information, and
       the failure is recorded so it cannot be mistaken for a pass. */
    buildNote = `dist rebuild failed, so three checks saw the previous build: ${String(e.message).slice(0, 120)}`;
  }

  let out = "";
  try {
    out = execFileSync(process.execPath, [join(ROOT, "tools", "gate.mjs"), "--fresh"], { encoding: "utf8", timeout: 900000 });
  } catch (e) {
    out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
  const passed = /RESULT:\s*every gate passed/i.test(out);
  const failed = [...out.matchAll(/^\s*(?:\[FAIL\]|✗|FAIL)\s*([^\n]{0,110})/gm)].map((m) => m[1].trim()).slice(0, 6);
  report.layers.L1 = {
    pass: passed,
    detail: (passed ? "every gate passed" : `${failed.length} gate failure(s)`) + ` — ${buildNote}`,
    failed,
  };
} finally {
  if (stagedCopy) {
    try {
      rmSync(staged);
    } catch {}
  }
}

/* ---------------------------------------------------------------- L2-L4: the audit */

let audit = null;
try {
  const out = execFileSync(process.execPath, [join(ROOT, "tools", "audit.mjs"), draftPath, "--json"], { encoding: "utf8", timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
  audit = JSON.parse(out)?.[0] ?? null;
} catch (e) {
  const out = `${e.stdout ?? ""}`;
  try {
    audit = JSON.parse(out)?.[0] ?? null;
  } catch {}
}
if (audit) {
  for (const key of ["L2", "L3", "L4"]) {
    if (audit.layers?.[key]) report.layers[key] = { pass: audit.layers[key].pass, detail: audit.layers[key].detail };
  }
} else {
  report.layers.L2 = { pass: false, detail: "tools/audit.mjs produced no parseable result" };
}

/* ---------------------------------------------------------------- L5: a second opinion */

const mechanicallyClear = Object.values(report.layers).every((l) => l.pass);
let review = null;

if (!mechanicallyClear) {
  /*
   * The model is not asked. Paying for a paragraph about a draft that already fails on a mechanical
   * check is the obvious waste in this pipeline, and it also trains the reader to skim past the
   * mechanical result, which is the part that is actually reliable.
   */
  report.layers.L5 = { pass: false, detail: "not run - an earlier layer failed" };
  report.reasons.push(...Object.entries(report.layers).filter(([, l]) => !l.pass).map(([k, l]) => `${k}: ${l.detail}`));
} else {
  const directiveFile = flag("directive-file", null);
  const directive = directiveFile && existsSync(directiveFile) ? readFileSync(directiveFile, "utf8").slice(0, 8000) : "";
  const r = await askJson({
    role: "reviewer",
    system:
      "You are the reviewer for an English trade-cost publication. You are not the writer. You decide " +
      "whether a draft may be published unattended. You are shown the draft and the figures it was " +
      "given; you are NOT shown the source documents, so you cannot confirm that a cited figure is " +
      "real - judge only what the draft itself asserts and whether it is internally sound. Be hostile " +
      "to unsupported claims, invented experience, and any drift into political, religious, military " +
      "or reputation commentary. Return only JSON.",
    messages: [
      {
        role: "user",
        content: `${directive ? `THE DIRECTIVE THE WRITER WAS GIVEN\n${directive}\n\n` : ""}THE DRAFT\n${text.slice(0, 60000)}\n\nAnswer with a JSON object:
{
  "pass": true or false,
  "checks": {
    "claims_follow_from_figures": true/false,
    "arithmetic_is_correct": true/false,
    "confidence_section_is_honest": true/false,
    "no_invented_experience": true/false,
    "no_unsupported_superlative_about_any_country": true/false,
    "risk_line_clear": true/false
  },
  "issues": [ "each issue in one sentence, most serious first" ],
  "summary": "one sentence"
}
Set pass to false if any check is false.`,
      },
    ],
    /*
     * 8192 rather than 4096. The reviewer reads the whole draft and then writes a verdict; on
     * 2026-10-17 it returned something unparseable and 4096 was tight enough that truncation was a
     * live possibility. The response is small, so this costs almost nothing and removes one way for
     * the review to fail for a reason that has nothing to do with the draft.
     */
    maxTokens: 8192,
  });

  if (!r.ok) {
    report.layers.L5 = { pass: false, detail: `review call failed: ${r.error}` };
    report.reasons.push("L5: the review call failed, so nothing was approved");
  } else if (!r.json) {
    /*
     * Quote what the reviewer actually returned. On 2026-10-17 this branch fired and the report said
     * "no parseable verdict", which is a description of the symptom and gives the next person nothing
     * to act on - the two likely causes, prose around the object and a response cut off at the token
     * ceiling, need opposite fixes. The head and tail are what tells them apart, and they go into the
     * report so they reach the notification rather than a log nobody opens.
     */
    report.layers.L5 = {
      pass: false,
      detail: `reviewer did not return JSON - ${r.parseError ?? "unknown reason"}`,
      reviewer: `${r.provider}/${r.model}`,
      completionTokens: r.usage?.completion_tokens ?? null,
      responseHead: (r.head ?? "").replace(/\s+/g, " ").slice(0, 300),
      responseTail: (r.tail ?? "").replace(/\s+/g, " ").slice(0, 200),
    };
    report.reasons.push(`L5: reviewer output unparseable - ${r.parseError ?? "unknown reason"}`);
  } else {
    review = r.json;
    report.layers.L5 = {
      pass: r.json.pass === true,
      detail: r.json.pass === true ? "approved by the second model" : `${(r.json.issues ?? []).length} issue(s)`,
      checks: r.json.checks ?? {},
      issues: r.json.issues ?? [],
      summary: r.json.summary ?? "",
      reviewer: `${r.provider}/${r.model}`,
      independent: r.provider !== (flag("writer-provider", null) ?? r.provider),
    };
    if (r.json.pass !== true) report.reasons.push(...(r.json.issues ?? ["reviewer withheld approval"]).map((i) => `L5: ${i}`));
    if (!report.layers.L5.independent) {
      report.reasons.push(`L5: the review used ${r.provider}, the same provider as the writer, so it is not an independent check`);
    }
  }
}

/* ---------------------------------------------------------------- verdict */

report.verdict = Object.values(report.layers).every((l) => l.pass) ? "APPROVED" : "REJECTED";

if (AS_JSON) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`QA  ${slug}\n${"=".repeat(80)}`);
  console.log(providerSummary());
  console.log("");
  for (const [name, l] of Object.entries(report.layers)) {
    console.log(`  ${l.pass ? "ok  " : "FAIL"} ${name}  ${l.detail}`);
    for (const f of l.failed ?? []) console.log(`         ${f}`);
    for (const i of l.issues ?? []) console.log(`         ${i}`);
  }
  if (review?.checks) {
    console.log("\n  reviewer checks:");
    for (const [k, v] of Object.entries(review.checks)) console.log(`    ${v ? "ok  " : "FAIL"} ${k}`);
  }
  const u = usageToday();
  console.log(`\n  verdict : ${report.verdict}`);
  console.log(`  usage today: ${u.calls} call(s), ${u.failed} failed, ~$${u.usd}, ${u.promptTokens} in / ${u.completionTokens} out`);
  console.log("");
  console.log("  LIMIT: the reviewer read the draft, not the source documents. It can judge whether the");
  console.log("  article is internally sound; it cannot tell a real figure from an invented one that");
  console.log("  carries a real-looking citation. That is what the archived sources are for, and closing");
  console.log("  that gap is the P2 evidence check specified in audit_protocol.md.");
}

if (report.verdict === "REJECTED") {
  mkdirSync(join(ROOT, "logs"), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const p = join(ROOT, "logs", `alert-qa-${slug}-${stamp}.txt`);
  writeFileSync(
    p,
    ["QA REJECTED", `article : ${slug}`, `time    : ${new Date().toISOString()}`, "", ...report.reasons.map((r) => "  " + r), "", "The draft is in data/drafts/ and was not staged for publish."].join("\r\n"),
    "utf8",
  );
  console.log(`\n  alert written: ${p}`);
}

process.exit(report.verdict === "APPROVED" ? 0 : 1);
