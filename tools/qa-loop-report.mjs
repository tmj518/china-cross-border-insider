#!/usr/bin/env node
/**
 * QA LOOP REPORT - read data/qa-loop.jsonl and say what actually happened.
 *
 *   node tools/qa-loop-report.mjs                last 14 days, grouped by article
 *   node tools/qa-loop-report.mjs --days=30
 *   node tools/qa-loop-report.mjs --rules        which rule costs the most attempts
 *
 * The operator asked for a backtest loop on 2026-11-05: when a draft fails, the log must say which check
 * failed, on what text, what kind of repair it needed, and whether the next attempt cleared it. This is the
 * reader for that log.
 */
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(ROOT, "data", "qa-loop.jsonl");
const days = Number((process.argv.find((a) => a.startsWith("--days=")) ?? "--days=14").split("=")[1]);
const byRule = process.argv.includes("--rules");

if (!existsSync(FILE)) {
  console.log("QA LOOP\n" + "=".repeat(80) + "\n  no attempts recorded yet - the file appears after the first run");
  process.exit(0);
}

const since = Date.now() - days * 86400000;
const rows = readFileSync(FILE, "utf8").split("\n").filter(Boolean).map((l) => {
  try { return JSON.parse(l); } catch { return null; }
}).filter(Boolean).filter((r) => new Date(r.at).getTime() >= since);

if (!rows.length) {
  console.log("QA LOOP\n" + "=".repeat(80) + "\n  nothing in the last " + days + " day(s)");
  process.exit(0);
}

if (byRule) {
  const counts = new Map();
  for (const r of rows) {
    for (const reason of r.reasons ?? []) {
      const key = String(reason).split(":")[0].trim();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  console.log("QA LOOP - WHICH LAYER COSTS THE MOST\n" + "=".repeat(80));
  for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1])) {
    console.log("  " + String(v).padStart(3) + "  " + k);
  }
  process.exit(0);
}

const bySlug = new Map();
for (const r of rows) {
  if (!bySlug.has(r.slug)) bySlug.set(r.slug, []);
  bySlug.get(r.slug).push(r);
}

console.log("QA LOOP - LAST " + days + " DAY(S)\n" + "=".repeat(80));
for (const [slug, list] of bySlug) {
  list.sort((a, b) => (a.attempt ?? 0) - (b.attempt ?? 0));
  const passed = list.some((r) => r.pass);
  console.log("\n  " + (passed ? "PASSED" : "no pass") + "  " + slug);
  for (const r of list) {
    const first = (r.reasons ?? [])[0] ?? (r.pass ? "every layer passed" : "no reason recorded");
    console.log("    attempt " + (r.attempt ?? "?") + "  " + String(r.pass ? "ok  " : "FAIL") + "  " + String(first).slice(0, 100));
    for (const i of (r.issues ?? []).slice(0, 2)) {
      if (!i.rule) continue;
      console.log("               reviewer: " + i.rule.slice(0, 60) + "  [" + (i.fixType || "?") + "]");
      if (i.snippet) console.log("               text    : " + i.snippet.slice(0, 80));
    }
  }
  const attempts = list.length;
  console.log("    -> " + (passed ? "cleared after " + attempts + " attempt(s)" : "still failing after " + attempts + " attempt(s)"));
}
