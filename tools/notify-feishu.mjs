/**
 * The daily notification. What the operator reads instead of the pipeline.
 *
 *   node tools/notify-feishu.mjs
 *   node tools/notify-feishu.mjs --dry-run        print the card and send nothing
 *   node tools/notify-feishu.mjs --webhook=...    override FEISHU_WEBHOOK
 *
 * ## What it reads
 *
 * `data/tmp/orchestrator-report.json` and the tail of `logs/orchestrator.jsonl`, both written by the
 * orchestrator. If neither exists the notification says so rather than sending an empty card, because
 * "no report" and "nothing happened" are different states and only one of them means the pipeline is
 * broken.
 *
 * ## Why the card leads with the verdict and not the article
 *
 * The operator's question in the morning is "does anything need me". So the first line is the verdict,
 * the second is what happened, and the list of what needs a decision comes before the article details.
 * An article title at the top would read as success on a day the pipeline was stuck.
 *
 * ## Feishu's payload shape
 *
 * a plain `msg_type: text` body. The rich card format needs a signature when the bot has a secret
 * configured, and a notification that silently stops arriving because of a signature mismatch is worse
 * than a plain one that always works. If the bot is set up with a signature, `FEISHU_SECRET` is used;
 * otherwise the request is unsigned.
 */
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { createHmac } from "node:crypto";
import { join } from "node:path";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const DRY = args.includes("--dry-run");

const webhook = flag("webhook", process.env.FEISHU_WEBHOOK ?? "");
const secret = (process.env.FEISHU_SECRET ?? "").trim();

const REPORT = join(ROOT, "data", "tmp", "orchestrator-report.json");
const LEDGER = join(ROOT, "logs", "orchestrator.jsonl");
const DIRECTOR = join(ROOT, "总监指令.md");
const STAFF = join(ROOT, "员工汇报.md");

let report = null;
if (existsSync(REPORT)) {
  try {
    report = JSON.parse(readFileSync(REPORT, "utf8"));
  } catch {}
}

/* The last few runs, so the card can say whether a failure is new or the third day running. */
let recent = [];
if (existsSync(LEDGER)) {
  try {
    recent = readFileSync(LEDGER, "utf8").split("\n").filter(Boolean).slice(-5).map((l) => JSON.parse(l));
  } catch {}
}

/* ---------------------------------------------------------------- the message */

const lines = [];
if (!report) {
  lines.push("Landed Math — no run report");
  lines.push("");
  lines.push("data/tmp/orchestrator-report.json is absent, so the orchestrator did not finish. On a");
  lines.push("scheduled run that means the job failed before it could write anything; read the Actions log.");
} else {
  const verdict = report.verdict ?? "(none)";
  const icon = verdict === "PUBLISHED" ? "✅" : verdict === "NO-DIRECTIVE" || verdict === "CEILING" || verdict === "IDLE" ? "🟡" : "🔴";
  lines.push(`${icon} Landed Math — ${verdict}`);
  lines.push("");
  if (report.article) lines.push(`Article: ${report.article}`);
  if (report.qa?.verdict) lines.push(`Review: ${report.qa.verdict}`);
  const u = report.usage ?? {};
  if (u.calls !== undefined) lines.push(`Usage: ${u.calls} call(s), ${u.failed ?? 0} failed, ~$${u.usd ?? 0}`);
  if (report.seconds !== undefined) lines.push(`Took: ${report.seconds}s`);

  /*
   * A publication the reviewer objected to is not the same as one it approved, and the card has to say
   * which happened. Otherwise "PUBLISHED" reads as a clean pass when the second opinion was against it.
   */
  if (report.reviewAdvisory?.length) {
    lines.push("");
    lines.push("Published with the reviewer's objections recorded:");
    for (const o of report.reviewAdvisory.slice(0, 4)) lines.push(`  · ${String(o).slice(0, 180)}`);
    lines.push("  They are in data/lessons.jsonl and feed the next article's prompt.");
  }

  if (report.reasons?.length) {
    lines.push("");
    lines.push("Needs a decision or a fix:");
    for (const r of report.reasons.slice(0, 6)) lines.push(`  • ${String(r).slice(0, 220)}`);
    if (report.reasons.length > 6) lines.push(`  … and ${report.reasons.length - 6} more in the report`);
    /*
     * Quote the reviewer's own output when the failure was a response we could not parse.
     *
     * The card is the only thing the operator sees, and on 2026-10-17 it said "no parseable verdict",
     * which describes the symptom and gives nothing to act on: the two likely causes - prose around
     * the object, and a response cut off at the token ceiling - need opposite fixes. The first and
     * last few hundred characters are what tells them apart.
     */
    const l5 = report.qa?.layers?.L5;
    if (l5 && l5.responseHead) {
      lines.push("");
      lines.push(`  reviewer said: ${String(l5.responseHead).slice(0, 220)}`);
      if (l5.responseTail) lines.push(`  reviewer ended: ${String(l5.responseTail).slice(0, 140)}`);
      if (l5.completionTokens != null) lines.push(`  completion tokens: ${l5.completionTokens}`);
    }
  }

  if (report.qa?.layers) {
    const failed = Object.entries(report.qa.layers).filter(([, l]) => !l.pass);
    if (failed.length) {
      lines.push("");
      lines.push("Layers that failed:");
      for (const [k, l] of failed) lines.push(`  ${k}: ${String(l.detail).slice(0, 180)}`);
    }
  }

  if (report.verdict === "NO-KEYS") {
    lines.push("");
    lines.push("Nothing can run until these exist as repository secrets:");
    /*
   * The names come from the report, which builds them from the provider tables. This file used to carry
   * its own list - DEEPSEEK_API_KEY and OPENAI_API_KEY - and neither is read by this build: OpenAI was
   * removed from the provider list, and the DeepSeek credentials here are mapped to OWNER_KEY_2.
   *
   * The operator set exactly what that list asked for and the pipeline reported NO-KEYS again. A message
   * that looks like instruction and names the wrong variables is worse than no message.
   */
  const need = report.need ?? [];
  if (need.length) {
    for (const n of need.slice(0, 10)) lines.push(`  • ${n}`);
  } else {
    lines.push("  • run node tools/cloud-orchestrator.mjs locally to see which names this build reads");
  }
  }
  if (report.verdict === "NO-DIRECTIVE") {
    lines.push("");
    lines.push("No directive at data/directive.json, so there was nothing to write. This is the");
    lines.push("intended behaviour: the pipeline does not choose its own subject.");
  }
}

if (recent.length > 1) {
  const tail = recent.slice(0, -1).map((r) => r.verdict).join(" → ");
  lines.push("");
  lines.push(`Previous runs: ${tail}`);
}

const text = lines.join("\n");

/* ---------------------------------------------------------------- send */

console.log("NOTIFY\n" + "=".repeat(78));
console.log(text);
console.log("=".repeat(78));

if (DRY) {
  console.log("--dry-run: nothing sent.");
  process.exit(0);
}

if (!webhook) {
  console.log("");
  console.log("FEISHU_WEBHOOK is not set, so there is nobody to notify. The message above is what would");
  console.log("have been sent. Set it as a repository secret and this becomes the daily report.");
  /*
   * A missing webhook is not a pipeline failure. Exiting non-zero here would fail the whole job on a
   * day when the article published perfectly, which would train the operator to ignore red runs.
   */
  process.exit(0);
}

const payload = { msg_type: "text", content: { text } };
let url = webhook;
if (secret) {
  const ts = Math.floor(Date.now() / 1000).toString();
  const sign = createHmac("sha256", `${ts}\n${secret}`).update("").digest("base64");
  url = `${webhook}&timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
}

try {
  const r = await fetch(url, {
    method: "POST",
    signal: AbortSignal.timeout(30000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await r.text();
  console.log(`\n  sent: HTTP ${r.status} ${body.slice(0, 200)}`);
  try {
    mkdirSync(join(ROOT, "logs"), { recursive: true });
    writeFileSync(join(ROOT, "logs", "notify-last.json"), JSON.stringify({ at: new Date().toISOString(), status: r.status, body: body.slice(0, 500) }, null, 2), "utf8");
  } catch {}
  process.exit(r.ok ? 0 : 1);
} catch (e) {
  console.log(`\n  send failed: ${e.cause?.code ?? e.message}`);
  process.exit(1);
}
