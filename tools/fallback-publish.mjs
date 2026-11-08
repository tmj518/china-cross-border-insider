#!/usr/bin/env node
/**
 * Publish something today, even if the trade pipeline had nothing.
 *
 * The operator's rule, 2026-11-08: the site publishes every day, and "the documents held nothing new" is
 * allowed to be a reason for a weaker article but not for an empty day. The trade pipeline can end a run
 * with NO-SUBJECT, DUPLICATE-SUBJECT or WRITE-FAILED for reasons that are all correct and all leave the
 * day empty.
 *
 * The guide route is the fallback because it is the reliable one: seven runs, seven publications in the
 * week to 2026-11-08, and it needs no verified figure to write a procedure. So when the trade run did not
 * publish, this runs the guide line once.
 *
 *   node tools/fallback-publish.mjs            # act only if today published nothing
 *   node tools/fallback-publish.mjs --force    # run the guide line regardless
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const today = new Date().toISOString().slice(0, 10);
const FORCE = process.argv.includes("--force");
const DRY = process.argv.includes("--dry-run");

/* What did the pipeline say it did? */
let verdict = "";
try {
  verdict = JSON.parse(readFileSync(join(ROOT, "data", "tmp", "orchestrator-report.json"), "utf8")).verdict ?? "";
} catch {}
const published = /^PUBLISHED/.test(verdict);

/* And is there already an article dated today, whoever wrote it? */
let alreadyToday = false;
for (const dir of ["blog", "guide"]) {
  try {
    for (const f of readdirSync(join(ROOT, "src", "content", dir)).filter((x) => x.endsWith(".md"))) {
      const t = readFileSync(join(ROOT, "src", "content", dir, f), "utf8");
      const d = (/^publishDate:\s*"?([\d-]{10})/m.exec(t.split("---")[1] ?? "") ?? [])[1];
      if (d === today && !/^draft:\s*true/m.test(t)) alreadyToday = true;
    }
  } catch {}
}

console.log("FALLBACK PUBLISH\n" + "=".repeat(78));
console.log("  today             : " + today);
console.log("  pipeline verdict  : " + (verdict || "(no report)"));
console.log("  published today   : " + (alreadyToday ? "yes" : "no"));

if ((published || alreadyToday) && !FORCE) {
  console.log("\n  Nothing to do: the day already has an article.");
  process.exit(0);
}

console.log("\n  The day is empty, so the guide line runs once. It fetches its own sources and");
console.log("  verifies every figure against them, which is why it is the fallback and not the writer.");
try {
  const out = execFileSync(process.execPath, [join(ROOT, "tools", "c-line-orchestrator.mjs")], {
    encoding: "utf8", timeout: 1800000, maxBuffer: 64 * 1024 * 1024, cwd: ROOT,
  });
  console.log(out.split("\n").filter((l) => /verdict|PUBLISHED|NO-SUBJECT|FAIL|published/i.test(l)).map((l) => "  " + l.trim()).join("\n"));
  process.exit(0);
} catch (e) {
  console.log("  the guide line did not publish either: " + String(e.message).slice(0, 120));
  console.log(String(e.stdout ?? "").split("\n").slice(-6).map((l) => "  " + l.trim()).join("\n"));
  process.exit(1);
}
