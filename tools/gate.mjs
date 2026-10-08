#!/usr/bin/env node
/**
 * Run every gate once, in parallel where that is safe, and cache the network-bound ones.
 *
 * Why this exists. A full gate pass was measured at 5.5 minutes, and 99 per cent of that
 * was three checks that go to the network: serp-check (270s, fetching competitor pages
 * for all 23 articles), check-mobile (60s, launching a browser), and the rest (0.9s
 * combined). The agent runs the gates after each edit to an article, so a run that
 * touches one article several times spent most of its wall clock re-fetching the same
 * unchanged competitor pages and re-launching the same browser.
 *
 * That is not a bug in the tools. It is a design fault in how they are called: the
 * expensive checks are pure functions of files on disk, and were being recomputed every
 * time regardless of whether those files changed.
 *
 * So: hash the inputs, reuse the last verdict when the hash matches, and run the cheap
 * checks concurrently because they are independent processes reading the same files.
 *
 * Usage:
 *   node tools/gate.mjs              # cached; re-runs only what changed
 *   node tools/gate.mjs --fresh      # ignore the cache and recompute everything
 *   node tools/gate.mjs --json       # machine-readable summary
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const CACHE_DIR = join(ROOT, ".cache");
const CACHE_FILE = join(CACHE_DIR, "gates.json");
const FRESH = process.argv.includes("--fresh");
const JSON_OUT = process.argv.includes("--json");
const NODE = process.execPath;

/* ------------------------------------------------------------------ caching */

function loadCache() {
  try { return JSON.parse(readFileSync(CACHE_FILE, "utf8")); } catch { return {}; }
}
function saveCache(c) {
  try { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(CACHE_FILE, JSON.stringify(c, null, 0), "utf8"); } catch { /* non-fatal */ }
}

/** Hash a set of paths: contents for files, a sorted listing for directories. */
function hashPaths(paths) {
  const h = createHash("sha256");
  for (const p of paths.sort()) {
    const abs = join(ROOT, p);
    if (!existsSync(abs)) { h.update(p + ":missing"); continue; }
    const st = statSync(abs);
    if (st.isDirectory()) {
      for (const f of readdirSync(abs).sort()) {
        try { h.update(f).update(readFileSync(join(abs, f))); } catch { h.update(f + ":unreadable"); }
      }
    } else {
      h.update(p).update(readFileSync(abs));
    }
  }
  return h.digest("hex").slice(0, 16);
}

/* ------------------------------------------------------------------ the gates */

/** Articles and their frontmatter, which most gates depend on. */
const ARTICLES = readdirSync(join(ROOT, "src", "content", "blog")).filter((f) => f.endsWith(".md")).map((f) => `src/content/blog/${f}`);

const GATES = [
  {
    id: "qa-check",
    label: "structural gates",
    args: ["tools/qa-check.mjs", "--all"],
    inputs: ARTICLES,
    fast: true,
  },
  {
    id: "reviewer-check",
    label: "reviewer agent",
    args: ["tools/reviewer-check.mjs", "--all"],
    inputs: ARTICLES,
    fast: true,
  },
  {
    id: "link-check",
    label: "internal links",
    args: ["tools/link-check.mjs"],
    inputs: ARTICLES,
    fast: true,
  },
  {
    id: "check-structured-data",
    label: "structured data",
    args: ["tools/check-structured-data.mjs"],
    inputs: ["dist"],
    fast: true,
  },
  {
    id: "check-csp",
    label: "content security policy",
    args: ["tools/check-csp.mjs"],
    inputs: ["dist"],
    fast: true,
  },
  {
    id: "serp-check",
    label: "information gain (network)",
    args: ["tools/serp-check.mjs", "--all", "--serp=file:data/serp"],
    inputs: [...ARTICLES, "data/serp"],
    fast: false,
  },
  {
    id: "check-mobile",
    label: "mobile layout (browser)",
    args: ["tools/check-mobile.mjs"],
    inputs: ["dist"],
    fast: false,
  },
];

/* ------------------------------------------------------------------ run them */

const cache = FRESH ? {} : loadCache();

function runOne(gate) {
  const key = hashPaths(gate.inputs);
  const hit = cache[gate.id];
  if (!FRESH && hit && hit.key === key) {
    return { ...gate, ms: 0, status: hit.status, cached: true, out: hit.out ?? "" };
  }
  const t = Date.now();
  const r = spawnSync(NODE, gate.args, { cwd: ROOT, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const ms = Date.now() - t;
  cache[gate.id] = { key, status: r.status ?? 1, out: out.slice(-4000) };
  return { ...gate, ms, status: r.status ?? 1, cached: false, out };
}

const start = Date.now();
const results = [];

// The cheap ones are independent processes reading the same files: run them together.
const fastGates = GATES.filter((g) => g.fast);
const slowGates = GATES.filter((g) => !g.fast);

const pending = fastGates.map(
  (g) => new Promise((resolve) => {
    const key = hashPaths(g.inputs);
    const hit = cache[g.id];
    if (!FRESH && hit && hit.key === key) { resolve({ ...g, ms: 0, status: hit.status, cached: true, out: hit.out ?? "" }); return; }
    const t = Date.now();
    const child = spawn(NODE, g.args, { cwd: ROOT });
    let buf = "";
    child.stdout.on("data", (d) => (buf += d));
    child.stderr.on("data", (d) => (buf += d));
    child.on("close", (code) => {
      cache[g.id] = { key, status: code ?? 1, out: buf.slice(-4000) };
      resolve({ ...g, ms: Date.now() - t, status: code ?? 1, cached: false, out: buf });
    });
  }),
);

for (const r of await Promise.all(pending)) results.push(r);
for (const g of slowGates) results.push(runOne(g));

saveCache(cache);

/* ------------------------------------------------------------------ report */

const totalMs = Date.now() - start;
const failed = results.filter((r) => r.status !== 0);

if (JSON_OUT) {
  console.log(JSON.stringify({ totalMs, results: results.map(({ id, label, status, ms, cached }) => ({ id, label, status, ms, cached })) }, null, 2));
} else {
  console.log("GATES\n" + "=".repeat(78));
  for (const r of results.sort((a, b) => b.ms - a.ms)) {
    const mark = r.status === 0 ? "ok  " : "FAIL";
    const tag = r.cached ? "cached" : `${(r.ms / 1000).toFixed(1)}s`;
    console.log(`  ${mark} ${tag.padStart(7)}  ${r.label}`);
  }
  console.log(`\n  total ${(totalMs / 1000).toFixed(1)}s   cached ${results.filter((r) => r.cached).length}/${results.length}`);

  if (failed.length) {
    console.log(`\n${failed.length} GATE(S) FAILED:\n`);
    for (const r of failed) {
      const tail = r.out.split("\n").filter((l) => /BLOCK|FAIL|UNSUPPORTED|problem|✗/.test(l)).slice(0, 5);
      console.log(`  --- ${r.label} (exit ${r.status}) ---`);
      for (const l of tail) console.log(`     ${l.trim().slice(0, 120)}`);
      console.log("");
    }
  } else {
    console.log("\nRESULT: every gate passed");
  }
}

process.exit(failed.length ? 1 : 0);
