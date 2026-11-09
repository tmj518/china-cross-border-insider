#!/usr/bin/env node
/**
 * INBOUND PRECHECK - a dangling link is caught before the article is published, not by CI afterwards.
 *
 * The failure this exists for: on 2026-11-09 an article was removed and two others still carried
 * "> Also read: [...](/blog/<removed>/)". The site was fine, the pipeline was fine, and CI went red on the
 * next push with `broken targets : 2`. The gate was right; it was simply the first thing to look.
 *
 * What it does, and only this:
 *   - walks src/content/{blog,guide}
 *   - treats a link target as real only when a file exists for it AND that file is not draft:true
 *     (the same rule link-check.mjs applies, so the two cannot disagree about what a broken link is)
 *   - exits 1 with the list when anything dangles
 *
 *   node tools/check-inbound-precheck.mjs                        whole tree
 *   node tools/check-inbound-precheck.mjs --staged=/abs/x.md     the tree plus one candidate file
 *   node tools/check-inbound-precheck.mjs --json
 *
 * It changes no gate, no threshold and no assertion. It is a second reader of the same rule, placed where
 * the publishing happens, so a day's work is not thrown away by a link nobody meant to leave behind.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const flag = (n, d = null) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const STAGED = flag("staged");
const AS_JSON = args.includes("--json");

const DIRS = ["blog", "guide"];

/* Every page that exists and is not a draft. A draft is not a URL. */
function realPages() {
  const pages = new Set();
  for (const dir of DIRS) {
    let files = [];
    try {
      files = readdirSync(join(ROOT, "src", "content", dir)).filter((f) => f.endsWith(".md"));
    } catch {
      continue;
    }
    for (const f of files) {
      let src = "";
      try {
        src = readFileSync(join(ROOT, "src", "content", dir, f), "utf8");
      } catch {
        continue;
      }
      if (/^draft:\s*true/m.test(src)) continue;
      pages.add(`${dir}/${f.replace(/\.md$/, "")}`);
    }
  }
  return pages;
}

const LINK = /\]\(\/(blog|guide)\/([a-z0-9-]+)\/?\)/g;

function scan(text) {
  const out = [];
  for (const m of text.matchAll(LINK)) out.push(`${m[1]}/${m[2]}`);
  return out;
}

const pages = realPages();
const broken = [];

for (const dir of DIRS) {
  let files = [];
  try {
    files = readdirSync(join(ROOT, "src", "content", dir)).filter((f) => f.endsWith(".md"));
  } catch {
    continue;
  }
  for (const f of files) {
    const self = `${dir}/${f.replace(/\.md$/, "")}`;
    let src = "";
    try {
      src = readFileSync(join(ROOT, "src", "content", dir, f), "utf8");
    } catch {
      continue;
    }
    for (const target of scan(src)) {
      if (target === self) continue;
      if (!pages.has(target)) broken.push({ from: self, to: target });
    }
  }
}

/* A candidate file that is not in the tree yet: judge its links too. */
if (STAGED) {
  if (!existsSync(STAGED)) {
    console.log(`INBOUND PRECHECK\n${"=".repeat(78)}\n  the staged file does not exist: ${STAGED}`);
    process.exit(1);
  }
  const text = readFileSync(STAGED, "utf8");
  const self = `${basename(dirname(dirname(dirname(STAGED)))) === "content" ? basename(dirname(STAGED)) : "blog"}/${basename(STAGED).replace(/\.md$/, "")}`;
  for (const target of scan(text)) {
    if (target === self) continue;
    if (!pages.has(target) && !broken.some((b) => b.from === self && b.to === target)) {
      broken.push({ from: self, to: target });
    }
  }
}

if (AS_JSON) {
  console.log(JSON.stringify({ pages: pages.size, broken }, null, 2));
} else {
  console.log("INBOUND PRECHECK\n" + "=".repeat(78));
  console.log(`  pages that exist and are not drafts: ${pages.size}`);
  if (STAGED) console.log(`  staged file judged                 : ${STAGED}`);
  if (!broken.length) {
    console.log("\nRESULT: PASS - every internal link points at a page that exists.");
    process.exit(0);
  }
  console.log(`\n  ${broken.length} dangling link(s):`);
  for (const b of broken.slice(0, 20)) console.log(`    ${b.from}  ->  ${b.to}`);
  if (broken.length > 20) console.log(`    … and ${broken.length - 20} more`);
  console.log("\nRESULT: FAIL - a link points at a page that does not exist or is still a draft.");
  console.log("Fix: restore the target, or remove the link and keep the sentence.");
  process.exit(1);
}
