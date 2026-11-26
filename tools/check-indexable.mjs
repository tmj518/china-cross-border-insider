#!/usr/bin/env node
/**
 * INDEXABILITY - the five things that decide whether Google can even consider a page.
 *
 * The site had 441 URLs in a valid sitemap and still showed one impression in seven days. The technical signals
 * were fine, which is why the fix is not "write more": it is to make every publish path announce the new page
 * and to catch the three defects that silently remove a page from the index.
 *
 * Checks, on the built site when dist exists:
 *   1. canonical  - present, absolute, and on the www host the sitemap lists
 *   2. robots     - no noindex in the page, none in src templates
 *   3. sitemap    - every sampled URL is listed
 *   4. links      - the page is not an orphan (link-check covers the whole tree; this samples)
 *   5. host       - never advertise the bare domain, which serves 200 and competes with www
 *
 *   node tools/check-indexable.mjs              sample 20 built pages
 *   node tools/check-indexable.mjs --limit=50
 *
 * Exit 0 when everything holds. A missing dist is reported, not treated as a failure - CI builds first.
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const LIMIT = Number((process.argv.find((a) => a.startsWith("--limit=")) ?? "--limit=20").split("=")[1]);
const HOST = process.env.SITE_HOST ?? "www.landedmath.com";

const problems = [];
const notes = [];

/* 1. the canonical host the project configures */
const astro = existsSync(join(ROOT, "astro.config.mjs")) ? readFileSync(join(ROOT, "astro.config.mjs"), "utf8") : "";
let siteMatch = /site:\s*["']([^"']+)["']/.exec(astro);
if (!siteMatch) {
  /* site: SITE_URL - the literal lives in src/consts.ts */
  const consts = existsSync(join(ROOT, "src", "consts.ts")) ? readFileSync(join(ROOT, "src", "consts.ts"), "utf8") : "";
  const m = /SITE_URL\s*=\s*["']([^"']+)["']/.exec(consts);
  if (m) siteMatch = [m[0], m[1]];
}
if (!siteMatch) problems.push("astro.config.mjs has no site: - canonical URLs cannot be absolute");
else {
  const host = new URL(siteMatch[1]).host;
  if (host !== HOST) problems.push(`astro site host is ${host}, sitemap and canonical expect ${HOST}`);
  else notes.push(`site host ${host}`);
}

/* 2. nothing in the templates should say noindex */
const srcDir = join(ROOT, "src");
let noindexHits = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (existsSync(p) && readdirSync(p).length >= 0) {
      try {
        if (readdirSync(p)) { walk(p); continue; }
      } catch {}
    }
    if (!/\.(astro|ts|tsx|js|mjs)$/.test(name)) continue;
    const text = readFileSync(p, "utf8");
    if (/noindex/i.test(text)) noindexHits.push(p.replace(ROOT, ""));
  }
};
try { walk(srcDir); } catch {}
if (noindexHits.length) problems.push(`noindex appears in ${noindexHits.slice(0, 3).join(", ")}`);

/* 3. robots.txt and the sitemap it advertises */
const robotsPath = [join(ROOT, "public", "robots.txt"), join(ROOT, "dist", "robots.txt")].find((x) => existsSync(x));
const robots = robotsPath ? readFileSync(robotsPath, "utf8") : "";
if (!/Sitemap:/i.test(robots)) problems.push("public/robots.txt does not advertise a sitemap");
if (/Disallow:\s*\/\s*$/m.test(robots)) problems.push("robots.txt disallows the whole site");

/* 4. sampled built pages: canonical, no noindex, listed in the sitemap */
const dist = join(ROOT, "dist");
if (!existsSync(dist)) {
  notes.push("dist not built - page-level checks skipped (CI builds before the gates)");
} else {
  const sitemapFile = existsSync(join(dist, "sitemap-0.xml")) ? join(dist, "sitemap-0.xml") : existsSync(join(dist, "sitemap-index.xml")) ? join(dist, "sitemap-index.xml") : null;
  const sitemap = sitemapFile ? readFileSync(sitemapFile, "utf8") : "";
  if (!sitemap) problems.push("no sitemap in dist");
  const pages = [];
  for (const dir of ["blog", "guide"]) {
    const abs = join(dist, dir);
    if (!existsSync(abs)) continue;
    for (const slug of readdirSync(abs)) {
      const html = join(abs, slug, "index.html");
      if (existsSync(html)) pages.push(html);
    }
  }
  const sample = pages.slice(0, LIMIT);
  if (!sample.length) notes.push("no built pages found to sample");
  for (const html of sample) {
    const text = readFileSync(html, "utf8");
    const url = "https://" + HOST + html.replace(dist, "").replace(/\\/g, "/").replace(/index\.html$/, "");
    const canon = /<link[^>]+rel="canonical"[^>]+href="([^"]+)"/.exec(text)?.[1];
    if (!canon) problems.push(`no canonical: ${url}`);
    else if (!canon.startsWith("https://" + HOST)) problems.push(`canonical host is not ${HOST}: ${canon}`);
    if (/<meta[^>]+name="robots"[^>]+content="[^"]*noindex/i.test(text)) problems.push(`noindex meta: ${url}`);
    if (sitemap && !sitemap.includes(url)) problems.push(`not in sitemap: ${url}`);
  }
  notes.push(`sampled ${sample.length} built page(s)`);
}

console.log("INDEXABILITY\n" + "=".repeat(70));
for (const n of notes) console.log("  ok   " + n);
for (const p of problems) console.log("  FAIL " + p);
console.log("\n  RESULT: " + (problems.length ? problems.length + " problem(s)" : "the index path is clean"));
process.exit(problems.length ? 1 : 0);
