#!/usr/bin/env node
/**
 * GIVE A NEW ARTICLE INBOUND LINKS ON THE DAY IT PUBLISHES.
 *
 * A page that nothing links to is discovered only through the sitemap, and on a new domain the crawl budget for
 * that path is small. The publish path already guarantees two OUTBOUND links; nothing guaranteed inbound ones,
 * so a new article could sit unreachable while the rest of the site was crawled around it.
 *
 * This picks the newest published article and adds a sentence with a link to it inside the body of two older
 * articles that share the most distinctive words with it - only in the body, because the "Related reading" block
 * is a generated section that the link gate excludes.
 *
 *   node tools/link-new-article.mjs            link the newest article from two related pages
 *   node tools/link-new-article.mjs --dry-run  report what would change
 *   node tools/link-new-article.mjs --days=3   treat anything published in the last 3 days as new
 */
import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DRY = process.argv.includes("--dry-run");
const DAYS = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=2").split("=")[1]);

const pages = [];
for (const dir of ["blog", "guide"]) {
  for (const f of readdirSync(join(ROOT, "src", "content", dir))) {
    if (!f.endsWith(".md")) continue;
    const abs = join(ROOT, "src", "content", dir, f);
    const raw = readFileSync(abs, "utf8");
    if (/^draft:\s*true/m.test(raw)) continue;
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] ?? "";
    const date = (/^publishDate:\s*"?(\d{4}-\d\d-\d\d)/m.exec(fm) ?? [])[1] ?? "";
    pages.push({ dir, slug: f.replace(/\.md$/, ""), abs, raw, date });
  }
}

const cutoff = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
const fresh = pages.filter((p) => p.date >= cutoff).sort((a, b) => b.date.localeCompare(a.date));
if (!fresh.length) {
  console.log("LINK NEW ARTICLE\n" + "=".repeat(70));
  console.log(`  nothing published in the last ${DAYS} day(s); nothing to link`);
  process.exit(0);
}

/* The words that identify a page: its slug, minus generic trade vocabulary. */
const GENERIC = new Set(["china", "chinese", "the", "and", "for", "with", "from", "2026", "2027", "2028", "importer", "foreign", "buyers", "cost", "trade", "policy"]);
const tokens = (p) => p.slug.split("-").filter((w) => w.length > 3 && !GENERIC.has(w));

const results = [];
for (const target of fresh) {
  const mine = new Set(tokens(target));
  const scored = pages
    .filter((p) => p.slug !== target.slug)
    .map((p) => ({ p, shared: tokens(p).filter((w) => mine.has(w)) }))
    .filter((x) => x.shared.length >= 1)
    .filter((x) => !x.p.raw.includes(`/${target.dir}/${target.slug}`))
    /* A reciprocal pair is a gate failure: link-check keeps one direction only. Skip a page the target already links back to. */
    .filter((x) => !target.raw.includes(`/${x.p.dir}/${x.p.slug}`))
    .sort((a, b) => b.shared.length - a.shared.length)
    .slice(0, 3);
  for (const { p, shared } of scored) {
    const label = target.slug.replace(/-/g, " ").replace(/\b20\d\d\b/g, "").trim();
    const sentence = `For the same question approached from another angle, see [${label}](/${target.dir}/${target.slug}/).`;
    /* Put the sentence before the last section so it reads as prose, not as a footer. */
    const lines = p.raw.split("\n");
    let insertAt = lines.length;
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^##\s/.test(lines[i])) { insertAt = i; break; }
    }
    lines.splice(insertAt, 0, sentence, "");
    if (!DRY) writeFileSync(p.abs, lines.join("\n"), "utf8");
    results.push({ from: `${p.dir}/${p.slug}`, to: `${target.dir}/${target.slug}`, shared: shared.join("+") });
  }
}

console.log("LINK NEW ARTICLE\n" + "=".repeat(70));
for (const r of results) console.log(`  ${r.from}  ->  ${r.to}   (${r.shared})`);
console.log(`\n  ${results.length} link(s) ${DRY ? "would be added" : "added"}`);
