/*
 * Which pages does Google already rank, and which of them nobody clicks.
 *
 * Search Console on 2026-10-20, three months: clicks 7, impressions 718, CTR 1%, average position 6.3.
 * Position 6.3 with a 1% click rate is not a content problem - Google already thinks those pages are relevant,
 * and position six is normally clicked four to eight times per hundred impressions. One per hundred means the
 * title and description are not earning the click, which is the cheapest work on the site: no research, no
 * writing, no tokens.
 *
 * THIS SCRIPT ONLY READS. It never writes a markdown file, never publishes, never commits. The rewrite step stays
 * behind a human eye, because a title is the only part of an article a reader sees before deciding.
 *
 *   node tools/optimize-titles.mjs
 *   node tools/optimize-titles.mjs --min-imp=20 --max-pos=8 --max-ctr=0.01
 *   node tools/optimize-titles.mjs --all
 */
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? Number(hit.slice(n.length + 3)) : d;
};
const MIN_IMP = arg("min-imp", 50);
const MAX_POS = arg("max-pos", 10);
const MAX_CTR = arg("max-ctr", 0.02);
const ALL = argv.includes("--all");
/*
 * Ninety days, not the default twenty-eight.
 *
 * The first run of this audit asked Search Console for a month and got nothing back, because the site's 718
 * impressions are spread over three months and almost none of them fall in the last four weeks. A window narrower
 * than the traffic is a filter that reports "no work to do" while the work sits there.
 */
const DAYS = arg("days", 90);

console.log("");
console.log("TITLE OPTIMISER  -  read only, nothing is written");
console.log("=".repeat(94));
console.log(`  filter : ${DAYS}d   impressions > ${MIN_IMP}   position < ${MAX_POS}   ctr < ${(MAX_CTR * 100).toFixed(1)}%`);
console.log("");

let payload;
try {
  const out = execSync(`${process.execPath} tools/gsc-report.mjs --json --days=${DAYS}`, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const a = out.indexOf("{");
  const b = out.lastIndexOf("}");
  if (a < 0 || b < 0) throw new Error("gsc-report printed no JSON object");
  payload = JSON.parse(out.slice(a, b + 1));
} catch (e) {
  const detail = String(e.stdout ?? "") + String(e.stderr ?? e.message ?? "");
  console.log("  could not read Search Console:");
  console.log("  " + detail.trim().split("\n").slice(-4).join("\n  ").slice(0, 600));
  console.log("");
  console.log("  Nothing was changed. This script only reads.");
  process.exit(1);
}

const pages = Array.isArray(payload?.pages) ? payload.pages : [];
console.log(`  window : ${payload?.days ?? "?"} day(s)     site : ${payload?.site ?? "?"}     pages : ${pages.length}`);
console.log("");
if (!pages.length) {
  console.log("  No page rows for this window. On a site this young that is the expected state, not a fault.");
  process.exit(0);
}

const dir = join(ROOT, "src", "content", "blog");
const fmOf = (file) => {
  try {
    const text = readFileSync(file, "utf8");
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
    const pick = (k) => (new RegExp(`^${k}:\\s*"?(.*?)"?\\s*$`, "m").exec(fm) ?? [])[1] ?? "";
    return { title: pick("title"), description: pick("description") };
  } catch {
    return null;
  }
};
const slugOf = (u) => (/\/blog\/([^/?#]+)/.exec(String(u ?? "")) ?? [])[1] ?? "";

const rows = pages
  .map((r) => ({
    page: String(r.page ?? ""),
    slug: slugOf(r.page),
    impressions: Number(r.impressions ?? 0),
    clicks: Number(r.clicks ?? 0),
    ctr: Number(r.ctr ?? 0),
    position: Number(r.position ?? 0),
  }))
  .filter((r) => r.page);

const short = (ALL
  ? rows
  : rows.filter((r) => r.impressions > MIN_IMP && r.position < MAX_POS && r.ctr < MAX_CTR)
).sort((x, y) => y.impressions - x.impressions);

console.log(`  shortlist : ${short.length} page(s)`);
console.log("");
if (!short.length) {
  console.log("  Nothing qualifies. Either the pages earn their clicks, or the floor is too high");
  console.log("  for a site this young - try --min-imp=20.");
  process.exit(0);
}

const shown = short.map((r) => {
  const p = existsSync(join(dir, `${r.slug}.md`)) ? fmOf(join(dir, `${r.slug}.md`)) : null;
  return { ...r, title: p?.title || "(no local file for this slug)" };
});
const w = Math.min(62, Math.max(20, ...shown.map((r) => r.title.length)));
const head = "  " + "imp".padStart(6) + "  " + "clk".padStart(4) + "  " + "ctr".padStart(6) + "  " + "pos".padStart(5) + "  " + "title".padEnd(w);
console.log(head);
console.log("  " + "-".repeat(head.length - 2));
for (const r of shown) {
  console.log(
    "  " + String(r.impressions).padStart(6) + "  " + String(r.clicks).padStart(4) + "  " +
    `${(r.ctr * 100).toFixed(1)}%`.padStart(6) + "  " + r.position.toFixed(1).padStart(5) + "  " +
    r.title.slice(0, w).padEnd(w),
  );
}
console.log("");
console.log("  What to do with this list, in order:");
console.log("    1. read the top description the way a stranger would, in a search result");
console.log("    2. rewrite the title to promise a consequence, not to name a subject");
console.log("    3. keep it under 60 characters - fitTitle() drops the qualifier rather than truncating");
console.log("");
console.log("  Nothing was written. The rewrite step is next, and it stays behind the gate.");