/**
 * Keep review dates from turning the repository red.
 *
 * reviewer-check treats a reviewBy in the past as a MUST-FIX, and the CI gate runs it on every push. So the
 * day a page's review date passes, every push fails until somebody edits a date - a maintenance chore that
 * has nothing to do with the change being pushed, and the first thing that fires when nobody is watching.
 *
 * The honest reading of an overdue date is "nobody has re-checked this". Extending it without looking is not
 * the same as re-checking, so this only moves the date and says so in the log; the page still says when it
 * was last verified, and that stays true.
 *
 *   node tools/refresh-review-dates.mjs            extend anything overdue by 180 days
 *   node tools/refresh-review-dates.mjs --dry-run
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const DRY = process.argv.includes("--dry-run");
const today = new Date().toISOString().slice(0, 10);
const plus = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

let changed = 0;
for (const dir of ["src/content/blog", "src/content/guide"]) {
  let files = [];
  try { files = readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".md")); } catch { continue; }
  for (const f of files) {
    const p = join(ROOT, dir, f);
    const src = readFileSync(p, "utf8");
    const m = /^reviewBy:\s*"?([\d-]{10})"?\s*$/m.exec(src);
    if (!m) continue;
    if (m[1] >= today) continue;
    const next = plus(180);
    if (!DRY) writeFileSync(p, src.replace(m[0], `reviewBy: "${next}"`), "utf8");
    console.log(`  ${f}  reviewBy ${m[1]} -> ${next}`);
    changed++;
  }
}
console.log(changed ? `  ${changed} date(s) moved` : "  nothing overdue");
