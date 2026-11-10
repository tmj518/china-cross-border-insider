#!/usr/bin/env node
/**
 * FOUR LAYERS, ONE ANSWER.
 *
 * The failure this exists for: on 2026-11-10 a judgement was made from a local file that was three commits
 * behind GitHub, about a run whose result had already been overwritten by a fallback step, on a site whose
 * live page had not been checked at all. Three of the four layers disagreed and nothing said so.
 *
 *   layer 1  the code on this disk
 *   layer 2  the code on GitHub main
 *   layer 3  what the last Actions run actually did
 *   layer 4  what the public site serves now
 *
 *   node tools/verify-four-layers.mjs
 *   node tools/verify-four-layers.mjs --slug=china-foreign-trade-first-ten-months-2026-import-growth
 *
 * Exit 0 only when every layer answers, and when the article the run reports is live and in the sitemap.
 * A layer that cannot be read is printed as UNREAD, never as agreement.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "tmj518/china-cross-border-insider";
const SITE = "https://www.landedmath.com";
const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const rows = [];
const add = (layer, ok, note) => rows.push({ layer, ok, note });

function gh(apiArgs) {
  for (let i = 0; i < 4; i++) {
    try {
      return JSON.parse(execFileSync("gh", apiArgs, { encoding: "utf8", timeout: 60000, maxBuffer: 32 * 1024 * 1024 }));
    } catch {
      /* try again: the API drops connections during long runs */
    }
  }
  return null;
}

function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/* ---------------------------------------------------------------- layer 1 vs 2 */
const WATCHED = ["tools", ".github"];
let localCount = 0;
const behind = [];
for (const dir of WATCHED) {
  if (!existsSync(join(ROOT, dir))) continue;
  for (const file of walk(join(ROOT, dir))) {
    const rel = relative(ROOT, file).replace(/\\/g, "/");
    const r = gh(["api", `repos/${REPO}/contents/${rel}?ref=main`]);
    if (!r) {
      behind.push(`${rel} (not on GitHub)`);
      continue;
    }
    localCount++;
    if (Buffer.from(r.content, "base64").toString("utf8") !== readFileSync(file, "utf8")) behind.push(rel);
  }
}
add("1 code on disk vs 2 GitHub main", behind.length === 0 && localCount > 0, behind.length ? `${behind.length} of ${localCount} differ: ${behind.slice(0, 3).join(", ")}` : `${localCount} file(s) identical`);

/* ---------------------------------------------------------------- layer 2 head */
const commits = gh(["api", `repos/${REPO}/commits?per_page=1`]);
add("2 GitHub main", Boolean(commits?.[0]), commits?.[0] ? `${commits[0].sha.slice(0, 7)} ${new Date(commits[0].commit.committer.date).toISOString().slice(0, 16)}Z` : "UNREAD");

/* ---------------------------------------------------------------- layer 3 run */
let slug = flag("slug");
const runFile = join(ROOT, "data", "runs", "latest.json");
let runVerdict = null;
if (existsSync(runFile)) {
  try {
    const j = JSON.parse(readFileSync(runFile, "utf8"));
    runVerdict = j.verdict;
    slug = slug ?? j.article;
    add("3 last Actions run", Boolean(j.verdict), `${j.verdict} at ${String(j.at).slice(0, 16)}Z -> ${j.article ?? "(no article)"}`);
  } catch {
    add("3 last Actions run", false, "data/runs/latest.json does not parse");
  }
} else {
  add("3 last Actions run", false, "data/runs/latest.json is missing - run the pipeline once");
}

/* ---------------------------------------------------------------- layer 4 site */
async function head(url) {
  try {
    const r = await fetch(url, { method: "GET", signal: AbortSignal.timeout(30000) });
    return { status: r.status, text: await r.text() };
  } catch (e) {
    return { status: 0, error: e.message };
  }
}

if (slug) {
  const url = `${SITE}/blog/${slug}/`;
  const page = await head(url);
  add("4 live page", page.status === 200, page.status === 200 ? `200 ${url}` : `${page.status || page.error} ${url}`);

  const sm = await head(`${SITE}/sitemap-0.xml`);
  const listed = sm.status === 200 && sm.text.includes(slug);
  add("4 sitemap", listed, listed ? "listed in sitemap-0.xml" : `not listed (sitemap status ${sm.status})`);
} else {
  add("4 live page", false, "no slug to check - the last run published nothing");
}

/* ---------------------------------------------------------------- report */
console.log("FOUR LAYERS\n" + "=".repeat(78));
for (const r of rows) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.layer.padEnd(32)} ${r.note}`);
const failed = rows.filter((r) => !r.ok);
console.log("\n" + (failed.length ? `RESULT: ${failed.length} layer(s) disagree or are unread.` : "RESULT: all four layers agree - the pipeline holds from disk to the public page."));
process.exit(failed.length ? 1 : 0);
