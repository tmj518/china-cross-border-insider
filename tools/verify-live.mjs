#!/usr/bin/env node
/**
 * Verify the live site after a deploy.
 *
 * Run by tools/run-daily.ps1 as the last step, and safe to run by hand:
 *     node tools/verify-live.mjs
 *     node tools/verify-live.mjs --slug eu-cbam-cost-per-tonne-chinese-steel-aluminium-2026
 *
 * Two things are checked, and the first one has already been wrong once:
 *
 *   1. Every article in the sitemap answers 200. A single read during a deployment
 *      window returned 404 for a page that was already serving, so each URL is
 *      retried before it is called broken.
 *   2. Each published article is on the live site with its own figures present. The
 *      blog URL list is compared against the repository, so a piece that never
 *      deployed is visible rather than counted as fine.
 *
 * Exit 0 only if both pass.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const BASE = "https://landedmath.com";
const SLUG_ARG = (() => {
  const i = process.argv.indexOf("--slug");
  return i >= 0 ? process.argv[i + 1] : null;
})();

const bust = () => "?cb=" + Date.now() + Math.random().toString(36).slice(2, 7);

/** GET with retries: a deploy window makes a single read unreliable. */
async function get(url, attempts = 5) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await fetch(url + bust());
      if (r.status === 200) return { ok: true, text: await r.text(), attempt: i };
    } catch { /* retry */ }
    if (i < attempts) await new Promise((x) => setTimeout(x, 6000));
  }
  return { ok: false };
}

// What the repository says should be live.
const DIR = "src/content/blog";
const published = [];
for (const f of readdirSync(DIR).filter((x) => x.endsWith(".md"))) {
  const raw = readFileSync(join(DIR, f), "utf8");
  const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw)?.[1] ?? "";
  if (/^draft:\s*true/m.test(fm)) continue;
  const title = /^title:\s*"?(.*?)"?\s*$/m.exec(fm)?.[1] ?? "";
  const figures = [...fm.matchAll(/^\s*-\s*value:\s*"?(.*?)"?\s*$/gm)].map((m) => m[1].replace(/["']/g, ""));
  published.push({ slug: f.replace(/\.md$/, ""), title, figures });
}

console.log(`LIVE VERIFICATION — ${published.length} published articles`);
console.log("=".repeat(74));

const targets = SLUG_ARG ? published.filter((p) => p.slug === SLUG_ARG) : published;
if (SLUG_ARG && targets.length === 0) {
  console.log(`  no published article matches --slug ${SLUG_ARG}`);
  process.exit(1);
}

let down = 0;
let missingFigures = 0;

// 1. Every live article answers.
for (const p of targets) {
  const r = await get(`${BASE}/blog/${p.slug}/`);
  if (!r.ok) {
    down++;
    console.log(`  DOWN  ${p.slug}`);
    continue;
  }
  // 2. Its figures are present on the page.
  const text = r.text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const absent = p.figures.filter((f) => {
    const n = f.replace(/,/g, "");
    return n.length >= 3 && !text.replace(/,/g, "").includes(n);
  });
  if (absent.length) {
    missingFigures++;
    console.log(`  FIGURES MISSING  ${p.slug}  -> ${absent.slice(0, 4).join(", ")}`);
  } else {
    console.log(`  ok[${r.attempt}]  ${p.slug}  (${p.figures.length} figures present)`);
  }
}

// 3. The sitemap agrees with the repository.
const sm = await get(`${BASE}/sitemap-0.xml`);
let inSitemap = 0;
let absentFromSitemap = [];
if (sm.ok) {
  const urls = [...sm.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const blogUrls = urls.filter((u) => u.includes("/blog/"));
  inSitemap = blogUrls.length;
  for (const p of published) if (!blogUrls.some((u) => u.includes(p.slug))) absentFromSitemap.push(p.slug);
  console.log(`\n  sitemap: ${urls.length} urls, ${blogUrls.length} blog urls`);
} else {
  console.log(`\n  sitemap: NOT REACHABLE`);
}

console.log("\n" + "=".repeat(74));
console.log(`  checked        : ${targets.length}`);
console.log(`  down           : ${down}`);
console.log(`  figures missing: ${missingFigures}`);
console.log(`  not in sitemap : ${absentFromSitemap.length}${absentFromSitemap.length ? " -> " + absentFromSitemap.join(", ") : ""}`);

const bad = down + missingFigures + absentFromSitemap.length + (sm.ok ? 0 : 1);
console.log(`\nRESULT: ${bad === 0 ? "the live site matches the repository" : `${bad} problem(s)`}`);
process.exit(bad === 0 ? 0 : 1);
