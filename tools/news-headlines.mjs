#!/usr/bin/env node
/**
 * Today's headlines from the news wires, as candidate subjects.
 *
 * The operator's point on 2026-11-09: a country publishing hundreds of thousands of items a day cannot be
 * short of subjects, so "the documented measures are exhausted" means we are reading the wrong pages.
 * Ministry index pages are stable by design; news home pages are not.
 *
 * This reads the four English-language wires the site already trusts, takes their headline links, and
 * writes them to data/news/<date>.json. tools/guide-topics.mjs reads that file, so a headline can become a
 * guide the same day without any model call.
 *
 *   node tools/news-headlines.mjs            fetch and write
 *   node tools/news-headlines.mjs --print    print what it found
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "data", "news");
const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const OUT = join(OUT_DIR, `${today}.json`);

const WIRES = [
  ["https://english.news.cn/", "xinhua-en"],
  ["https://www.chinadaily.com.cn/china", "china-daily"],
  ["https://www.globaltimes.cn/china", "globaltimes"],
  ["https://en.people.cn/", "peoples-daily"],
];

const SKIP = /^(home|china|world|business|opinion|video|photo|more|news|subscribe|about|contact|login|search|menu|sports|culture|life|tech|travel|weather|jobs|privacy|terms)$/i;

/*
 * A FATAL FIRE IS NOT A HOW-TO.
 *
 * On 2026-11-09 this feed carried "fourteen confirmed dead in Taiyuan apartment fire" and the guide line
 * published it as an article. Real news, wrong site: it monetises a disaster and there is no procedure in it.
 * Crime, accidents, deaths, disasters, protests and court cases are dropped here, before anything is scored.
 */
const GRIM = /\b(dead|death|deaths|killed|kills|dies|died|dying|fire|blaze|crash|collision|accident|earthquake|flood|typhoon|landslide|explosion|attack|shooting|murder|arrest|arrested|jailed|sentenced|probe|corruption|protest|riot|victim|casualt\w*|injur\w*|missing|funeral|obituar\w*|toll)\b/i;

async function headlines(url) {
  try {
    const res = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0 (compatible; landedmath-research/1.0)" },
      signal: AbortSignal.timeout(25000),
    });
    if (!res.ok) return { url, status: res.status, items: [] };
    const html = await res.text();
    const items = [];
    const seen = new Set();
    for (const m of html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]{4,160}?)<\/a>/gi)) {
      const href = m[1];
      const text = m[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
      if (text.length < 18 || text.length > 140) continue;
      if (SKIP.test(text)) continue;
      if (!/[a-z]/i.test(text)) continue;
      if (GRIM.test(text)) continue;   /* a disaster is not a how-to */
      if (!/\/\d{4}|\/c_\d|\.html?|\.shtml/i.test(href)) continue;
      if (seen.has(text)) continue;
      seen.add(text);
      items.push({ title: text, url: href.startsWith("http") ? href : new URL(href, url).toString() });
      if (items.length >= 25) break;
    }
    return { url, status: res.status, items };
  } catch (e) {
    return { url, status: 0, items: [], error: String(e.message).slice(0, 80) };
  }
}

const wires = [];
for (const [url, label] of WIRES) {
  const r = await headlines(url);
  wires.push({ label, ...r });
  console.log(`  ${String(r.status).padStart(3)}  ${label.padEnd(14)} ${String(r.items.length).padStart(2)} headline(s)`);
}

const items = wires.flatMap((w) => w.items.map((i) => ({ ...i, wire: w.label })));
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), date: today, wires: wires.map((w) => ({ label: w.label, status: w.status, n: w.items.length })), items }, null, 2) + "\n", "utf8");
console.log(`\n  ${items.length} headline(s) written to ${OUT.replace(ROOT, "").replace(/\\/g, "/")}`);
if (process.argv.includes("--print")) {
  for (const i of items.slice(0, 15)) console.log(`   · [${i.wire}] ${i.title.slice(0, 90)}`);
}
if (!items.length) {
  console.log("  None of the wires answered with usable headlines. That is a fact about reach, not a subject list.");
  process.exit(1);
}
