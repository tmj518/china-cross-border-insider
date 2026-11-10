#!/usr/bin/env node
/**
 * WRITE THE INTEGRATIONS FILE THE NOTIFICATION CARD READS.
 *
 * The card used to be assembled by a one-line `node -e` inside daily.yml, and that line hard-coded
 * "readership: configured:false, pageviews 0" whenever the Cloudflare fetch printed "cannot fetch". The
 * Cloudflare account cannot read the RUM dataset - the probe says so - while GA4 holds the real numbers
 * for the same window. Two attempts to edit the inline string failed on shell quoting, so the logic lives
 * here, where it can be read and tested.
 *
 *   node tools/write-integrations.mjs
 *
 * Reads:  data/analytics/readership-<date>.json   (written by tools/analytics.mjs from the GA4 snapshot)
 * Writes: data/tmp/integrations.json              ({ readership: { configured, pageviews, days, articles, source } })
 *
 * Exit code is always 0: a card that says "no readership data" is better than a pipeline that stops
 * because the analytics file was missing.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ANALYTICS = join(ROOT, "data", "analytics");
const OUT_DIR = join(ROOT, "data", "tmp");
const OUT = join(OUT_DIR, "integrations.json");

function newestReadership() {
  try {
    const files = readdirSync(ANALYTICS).filter((f) => /^readership-.*\.json$/.test(f)).sort();
    if (!files.length) return null;
    return JSON.parse(readFileSync(join(ANALYTICS, files[files.length - 1]), "utf8"));
  } catch {
    return null;
  }
}

const snap = newestReadership();
const readership = snap
  ? {
      configured: true,
      pageviews: Number(snap.totalPageviews ?? 0),
      days: Number(snap.windowDays ?? 7),
      articles: Array.isArray(snap.pages) ? snap.pages.filter((p) => String(p.path).startsWith("/blog/")).length : 0,
      source: snap.source ?? "cloudflare",
    }
  : { configured: false, missing: "CF_ACCOUNT_ID, CF_API_TOKEN" };

try {
  mkdirSync(OUT_DIR, { recursive: true });
  let current = {};
  if (existsSync(OUT)) {
    try {
      current = JSON.parse(readFileSync(OUT, "utf8"));
    } catch {
      current = {};
    }
  }
  /* Keep whatever the other steps put here: this file is shared, not owned. */
  writeFileSync(OUT, JSON.stringify({ ...current, readership }, null, 2), "utf8");
  console.log(
    "  readership     " +
      (readership.configured
        ? `${readership.pageviews} pageview(s) over ${readership.days} day(s), source ${readership.source}`
        : "not configured - no analytics snapshot"),
  );
} catch (e) {
  console.log("  readership     could not be written: " + e.message);
}
process.exit(0);
