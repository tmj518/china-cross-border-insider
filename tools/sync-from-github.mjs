#!/usr/bin/env node
/**
 * PULL THE CLOUD BACK INTO THIS FOLDER.
 *
 * The cloud commits on its own: every run stages an article, rewrites data/runs/*, updates the ledger.
 * This folder only changes when someone writes to it. Left alone for a day the two drift, and then a
 * judgement is made from a file that is hours behind the site - which is exactly how a fallback
 * publication was mistaken for a trade-line success on 2026-11-10.
 *
 *   node tools/sync-from-github.mjs            mirror the repository over this folder
 *   node tools/sync-from-github.mjs --check    report how far behind, change nothing
 *
 * What is mirrored: tools/, src/, docs/, data/, .github/, and the config files.
 * What is never touched: node_modules/, dist/, .astro/, out/, .git/, and anything written by hand in
 * the repository root that the repository itself does not track.
 *
 * Exit 0 when this folder matches GitHub afterwards, 1 when it cannot be made to match.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = "tmj518/china-cross-border-insider";
const CHECK = process.argv.includes("--check");
const MIRROR = ["tools", "src", "docs", "data", ".github"];
const FILES = ["package.json", "astro.config.mjs", "tsconfig.json", ".gitignore", "README.md", "wrangler.toml"];

function token() {
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", timeout: 30000 }).trim();
  } catch {
    return "";
  }
}

function head() {
  for (let i = 0; i < 4; i++) {
    try {
      const out = execFileSync("gh", ["api", `repos/${REPO}/commits?per_page=1`, "--jq", ".[0].sha"], {
        encoding: "utf8",
        timeout: 60000,
      }).trim();
      if (out) return out;
    } catch {
      /* the API drops connections; try again */
    }
  }
  return "";
}

/* What this folder claims to be: the commit recorded at the last successful mirror. */
const markerPath = join(ROOT, ".sync-state.json");
let marker = null;
try {
  marker = JSON.parse(readFileSync(markerPath, "utf8"));
} catch {
  marker = null;
}

const remoteSha = head();
if (!remoteSha) {
  console.log("SYNC\n" + "=".repeat(70) + "\n  cannot read GitHub - no token or the API is unreachable");
  process.exit(1);
}

if (CHECK) {
  const behind = marker?.sha === remoteSha ? 0 : 1;
  console.log("SYNC CHECK\n" + "=".repeat(70));
  console.log(`  this folder  ${marker?.sha ? marker.sha.slice(0, 7) + "  " + (marker.at ?? "") : "(never synced)"}`);
  console.log(`  github main  ${remoteSha.slice(0, 7)}`);
  console.log(`\n  ${behind ? "BEHIND - run node tools/sync-from-github.mjs" : "up to date"}`);
  process.exit(behind ? 1 : 0);
}

const tarballUrl = `https://api.github.com/repos/${REPO}/tarball/main`;
const work = mkdtempSync(join(tmpdir(), "sync-"));
const tgz = join(work, "main.tgz");
let ok = true;

try {
  const res = await fetch(tarballUrl, {
    headers: { authorization: `Bearer ${token()}`, accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(180000),
  });
  if (!res.ok) throw new Error(`tarball HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(tgz, buf);

  execFileSync("tar", ["-xzf", tgz, "-C", work], { timeout: 180000 });
  const top = readdirSync(work).find((n) => statSync(join(work, n)).isDirectory() && n !== "main.tgz");
  if (!top) throw new Error("the tarball did not contain a directory");
  const src = join(work, top);

  let copied = 0;
  const failed = [];
  /* Copy file by file: cpSync throws on one locked file and leaves the rest undone. */
  const SKIP = ["docs/collab"];   /* the live channel is not a mirror */
  const walkCopy = (from, to) => {
    if (!existsSync(from)) return;
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) {
      if (SKIP.some((k) => (from + "/" + name).replace(/\\/g, "/").includes(k))) continue;
      const a = join(from, name);
      const b = join(to, name);
      const st = statSync(a);
      if (st.isDirectory()) walkCopy(a, b);
      else {
        try { copyFileSync(a, b); copied++; } catch (e) { failed.push(b.replace(ROOT, "") + " (" + (e.code ?? e.message) + ")"); }
      }
    }
  };
  for (const dir of MIRROR) walkCopy(join(src, dir), join(ROOT, dir));
  for (const f of FILES) {
    const from = join(src, f);
    if (!existsSync(from)) continue;
    try { copyFileSync(from, join(ROOT, f)); copied++; } catch (e) { failed.push(f + " (" + (e.code ?? e.message) + ")"); }
  }

  writeFileSync(markerPath, JSON.stringify({ sha: remoteSha, at: new Date().toISOString() }, null, 2), "utf8");
  console.log("SYNC\n" + "=".repeat(70));
  console.log(`  mirrored ${copied} file(s) from ${remoteSha.slice(0, 7)}`);
  if (failed.length) console.log(`  skipped ${failed.length}: ` + failed.slice(0, 3).join(", "));
  console.log(`  marker   .sync-state.json`);
} catch (e) {
  ok = false;
  console.log("SYNC FAILED: " + e.message);
} finally {
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {}
}

process.exit(ok ? 0 : 1);
