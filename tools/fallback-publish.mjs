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
 * publish, and nothing has reached src/content recently, this runs the guide line once.
 *
 *   node tools/fallback-publish.mjs            # act only if the day looks empty
 *   node tools/fallback-publish.mjs --dry-run  # say what it would do, touch nothing
 *   node tools/fallback-publish.mjs --force    # run the guide line regardless
 *
 * "Empty" is judged by the commit clock, not by publishDate. The pipelines run at 23:20 UTC, which is
 * already the next day in Beijing, and publishDate is written in UTC - so comparing dates is wrong by a
 * day exactly when it matters. git log is the same clock that scheduled the job.
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FORCE = process.argv.includes("--force");
const DRY = process.argv.includes("--dry-run");

let verdict = "";
try {
  verdict = JSON.parse(readFileSync(join(ROOT, "data", "tmp", "orchestrator-report.json"), "utf8")).verdict ?? "";
} catch {}
const published = /^PUBLISHED/.test(verdict);

/* Did anything reach the content collections in the last twelve hours? */
let recentlyPublished = false;
let lastTs = 0;
try {
  const out = execFileSync("git", ["log", "-1", "--format=%ct", "--", "src/content/blog", "src/content/guide"], {
    encoding: "utf8",
    cwd: ROOT,
    timeout: 30000,
  }).trim();
  lastTs = Number(out) || 0;
  if (lastTs) recentlyPublished = Date.now() / 1000 - lastTs < 12 * 3600;
} catch {}

console.log("FALLBACK PUBLISH\n" + "=".repeat(78));
console.log("  pipeline verdict   : " + (verdict || "(no report)"));
console.log("  last content commit: " + (lastTs ? new Date(lastTs * 1000).toISOString().slice(0, 16).replace("T", " ") + "Z" : "(none)"));
console.log("  published in 12h   : " + (recentlyPublished ? "yes" : "no"));

if ((published || recentlyPublished) && !FORCE) {
  console.log("\n  Nothing to do: the day already has an article.");
  process.exit(0);
}

if (DRY) {
  console.log("\n  --dry-run: would run the guide line now. Nothing was touched.");
  process.exit(0);
}

console.log("\n  The day is empty, so the guide line runs once. It fetches its own sources and verifies");
console.log("  every figure against them, which is why it is the fallback and not the trade writer.");
try {
  const out = execFileSync(process.execPath, [join(ROOT, "tools", "c-line-orchestrator.mjs")], {
    encoding: "utf8",
    timeout: 1800000,
    maxBuffer: 64 * 1024 * 1024,
    cwd: ROOT,
  });
  const keep = out.split("\n").filter((l) => /verdict|PUBLISHED|NO-SUBJECT|FAIL|published/i.test(l));
  console.log(keep.slice(-8).map((l) => "  " + l.trim()).join("\n"));
  process.exit(0);
} catch (e) {
  console.log("  the guide line did not publish either: " + String(e.message).slice(0, 120));
  const tail = String(e.stdout ?? "").split("\n").slice(-6);
  console.log(tail.map((l) => "  " + l.trim()).join("\n"));
  process.exit(1);
}
