#!/usr/bin/env node
/**
 * FRONTMATTER MUST PARSE.
 *
 * On 2026-11-27 the A line staged an article with two "route:" keys. js-yaml rejects a duplicate mapping key, so
 * Astro's build failed, Cloudflare Pages kept the previous build, and the run reported PUBLISHED-DEGRADED for a
 * page that answered 404. The gate never saw it: the run builds before it stages, and a bot push does not
 * re-trigger the CI workflow.
 *
 * This parses every article's frontmatter with the same parser the build uses. A duplicate key, a tab where a
 * space belongs, or an unclosed quote becomes a gate failure here rather than a silent 404 in production.
 *
 *   node tools/check-frontmatter-yaml.mjs          every published article
 *   node tools/check-frontmatter-yaml.mjs --all    include drafts
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
/*
 * js-yaml is a transitive dependency of Astro, not a direct one, so it is imported from the workspace root path
 * that pnpm creates. If that ever moves, the fallback is a duplicate-key scan, which catches the 2026-11-27 defect
 * even without a parser.
 */
let yaml = null;
try { yaml = (await import("js-yaml")).default; } catch {
  try { yaml = (await import(join(ROOT, "node_modules", ".pnpm", "js-yaml@4.3.2", "node_modules", "js-yaml", "dist", "js-yaml.mjs"))).default; } catch { yaml = null; }
}

const ALL = process.argv.includes("--all");
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const problems = [];
let checked = 0;

for (const dir of ["blog", "guide"]) {
  const abs = join(ROOT, "src", "content", dir);
  let files = [];
  try { files = readdirSync(abs).filter((f) => f.endsWith(".md")); } catch { continue; }
  for (const f of files) {
    const raw = readFileSync(join(abs, f), "utf8");
    if (!ALL && /^draft:\s*true/m.test(raw)) continue;
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
    if (!m) { problems.push(`${dir}/${f}: no frontmatter block`); continue; }
    checked++;
    try {
      if (yaml) yaml.load(m[1]);
      else {
        /* No parser: a duplicate top-level key is the defect this exists to catch. */
        const keys = [...m[1].matchAll(/^([a-zA-Z_]+):/gm)].map((x) => x[1]);
        const dup = keys.filter((k, i) => keys.indexOf(k) !== i);
        if (dup.length) throw new Error("duplicate key: " + [...new Set(dup)].join(", "));
      }
    } catch (e) {
      problems.push(`${dir}/${f}: ${String(e.message).split("\n")[0]}`);
    }
  }
}

console.log("FRONTMATTER\n" + "=".repeat(70));
console.log(`  parsed ${checked} article(s)`);
for (const p of problems.slice(0, 20)) console.log("  FAIL " + p);
console.log(`\n  RESULT: ${problems.length ? problems.length + " file(s) will not build" : "every frontmatter block parses"}`);
process.exit(problems.length ? 1 : 0);
