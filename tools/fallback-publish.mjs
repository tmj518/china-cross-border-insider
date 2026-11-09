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
import { readFileSync, readdirSync, existsSync } from "node:fs";
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

/*
 * DURING THE REPAIR WINDOW, ONLY THE GUIDE LINE PUBLISHES.
 *
 * On 2026-11-09 the fallback and the guide line both ran and published near-identical residence guides, because
 * the fallback's journal check could not see a run whose data/runs entry had not been committed yet. While
 * data/a-line-paused exists, the fallback stands down: the guide line at 15:20 is the publisher, and one route
 * that works is worth more than two that race.
 */
try {
  if (existsSync(join(ROOT, "data", "a-line-paused"))) {
    console.log("FALLBACK PUBLISH\n" + "=".repeat(78));
    console.log("  A line is paused: the guide line publishes today. The fallback stands down.");
    process.exit(0);
  }
} catch {}

/* Did anything reach the content collections in the last twelve hours? */
let recentlyPublished = false;
let lastTs = 0;
/*
 * The run journal, not git history.
 *
 * A git log with a pathspec needs history, and the runner checks out shallow: on 2026-11-09 that call
 * returned the head commit's own timestamp, so the fallback believed the day was covered by the commit
 * that had just added this file. data/runs/ is committed by every pipeline and carries `at` and `verdict`,
 * which is exactly the question being asked and needs no history at all.
 */
try {
  const dir = join(ROOT, "data", "runs");
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {   /* dated and latest-* both count */
    try {
      const j = JSON.parse(readFileSync(join(dir, f), "utf8"));
      if (!/^PUBLISHED/.test(String(j.verdict ?? ""))) continue;
      const ts = Date.parse(j.at);
      if (Number.isFinite(ts) && ts > lastTs) lastTs = ts;
    } catch {}
  }
  if (lastTs) recentlyPublished = Date.now() - lastTs < 12 * 3600;
} catch {}

console.log("FALLBACK PUBLISH\n" + "=".repeat(78));
console.log("  pipeline verdict   : " + (verdict || "(no report)"));
console.log("  last published run : " + (lastTs ? new Date(lastTs).toISOString().slice(0, 16).replace("T", " ") + "Z" : "(none)"));
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
