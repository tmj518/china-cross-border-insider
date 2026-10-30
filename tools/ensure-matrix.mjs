/**
 * Keep the demand matrix fresh, cheaply.
 *
 * The matrix is what the agent route selects cells from, and it stopped updating on 2026-10-28: the radar
 * had a monthly GitHub cron, that cron was disabled when the clock moved to the Cloudflare worker, and the
 * worker only dispatches the three daily lines. So the subject pool froze while every run kept selecting
 * from the same twenty-five cells.
 *
 * Re-running the radar on its own schedule needs a cron that does not exist. Running it from the guide line,
 * which is already on a daily cron, costs one attempt a week and nothing on the other six days.
 *
 *   node tools/ensure-matrix.mjs [--max-age-days=7] [--force]
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const MAX_AGE_DAYS = Number(flag("max-age-days", "7"));
const FORCE = args.includes("--force");
const DIR = join(ROOT, "data", "demand");

let files = [];
try {
  files = readdirSync(DIR).filter((f) => /^matrix-cells-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
} catch {
  console.log("  no data/demand directory - the radar has never run here");
}

const newest = files.at(-1);
if (newest) {
  const ageDays = (Date.now() - statSync(join(DIR, newest)).mtimeMs) / 86_400_000;
  console.log(`  newest matrix: ${newest} (${ageDays.toFixed(1)} days old, limit ${MAX_AGE_DAYS})`);
  if (!FORCE && ageDays < MAX_AGE_DAYS) {
    console.log("  fresh enough - the radar is not run");
    process.exit(0);
  }
} else {
  console.log("  no matrix on disk - running the radar");
}

/*
 * The radar is a network harvest with its own pacing. A failure here must not stop the guide line: a stale
 * matrix is a worse subject pool, not a broken run.
 */
try {
  const out = execFileSync(process.execPath, ["tools/demand-radar.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 15 * 60 * 1000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const tail = out.trim().split("\n").slice(-4).join(" | ");
  console.log("  radar finished: " + tail.slice(0, 300));
} catch (e) {
  console.log("  radar failed, the old matrix stands: " + String(e.stdout || e.message).slice(-300));
}
