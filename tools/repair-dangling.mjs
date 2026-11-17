#!/usr/bin/env node
/**
 * REPAIR DANGLING LINKS ACROSS THE TREE.
 *
 * A link to a page that does not exist - or to one still marked draft - is a defect in whichever article
 * carries it. The publish path used to fail the whole run when it found one anywhere, which on 2026-11-17
 * cost the day: the new draft was fine, an older article pointed at a draft page, and the run was recorded
 * DANGLING-LINK before the writer's article was even kept.
 *
 * This rewrites the offending links to plain text, leaves everything else untouched, and reports how many.
 *
 *   node tools/repair-dangling.mjs          repair and print the count
 *   node tools/repair-dangling.mjs --check  count only, change nothing
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHECK = process.argv.includes("--check");

/* A page is real when a file exists for it and it is not a draft. */
const pages = new Set();
for (const dir of ["blog", "guide"]) {
  for (const f of readdirSync(join(ROOT, "src", "content", dir))) {
    if (!f.endsWith(".md")) continue;
    const raw = readFileSync(join(ROOT, "src", "content", dir, f), "utf8");
    if (/^draft:\s*true/m.test(raw)) continue;
    pages.add(dir + "/" + f.replace(/\.md$/, ""));
  }
}

const LINK = /\[([^\]]+)\]\(\/(blog|guide)\/([a-z0-9-]+)\/?\)/g;
let repaired = 0;
const touched = [];
for (const dir of ["blog", "guide"]) {
  for (const f of readdirSync(join(ROOT, "src", "content", dir))) {
    if (!f.endsWith(".md")) continue;
    const p = join(ROOT, "src", "content", dir, f);
    const before = readFileSync(p, "utf8");
    let after = before;
    for (const m of before.matchAll(LINK)) {
      if (pages.has(m[2] + "/" + m[3])) continue;
      after = after.split(m[0]).join(m[1]);
      repaired++;
    }
    if (after !== before) {
      if (!CHECK) writeFileSync(p, after, "utf8");
      touched.push(dir + "/" + f);
    }
  }
}

console.log("REPAIR DANGLING\n" + "=".repeat(70));
console.log("  pages that exist: " + pages.size);
console.log("  repaired " + repaired + (CHECK ? " (check only, nothing written)" : ""));
for (const t of touched.slice(0, 8)) console.log("   · " + t);
process.exit(0);
