#!/usr/bin/env node
/**
 * INDEX STATUS - how many of the published pages Google actually holds.
 *
 * The operator asked the question the dashboard answers only by hand: "看看收录情况". Search Console has no
 * bulk "indexed count" endpoint, but the URL Inspection API answers per URL, and a sample is enough to tell
 * the difference between "not crawled yet" and "crawled and rejected".
 *
 *   node tools/gsc-index-status.mjs                 20 newest pages + 10 random
 *   node tools/gsc-index-status.mjs --limit=50
 *
 * Credentials: GSC_CREDENTIALS_BASE64, the same service-account key the other GSC tools use. Without it the
 * tool says so and exits 0 - a missing credential must never break the pipeline.
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createSign } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const LIMIT = Number((args.find((a) => a.startsWith("--limit=")) ?? "--limit=30").split("=")[1]);
/* --recent-days=7 samples the pages published inside that window, which is how "indexed this week" is measured. */
const RECENT_DAYS = Number((args.find((a) => a.startsWith("--recent-days=")) ?? "--recent-days=0").split("=")[1]);
const SITE = process.env.GSC_SITE_URL ?? "sc-domain:landedmath.com";
/*
 * ASK ABOUT THE HOST THE SITE ACTUALLY SERVES.
 *
 * The property is sc-domain:landedmath.com, so the bare domain is not the canonical host: every page is served
 * from www.landedmath.com and the sitemap lists the www form. Inspecting the bare-domain URL returned
 * "URL is unknown to Google" for 29 of 30 pages and "alternate page with proper canonical tag" for the one that
 * resolved - a measurement artefact, not a site problem. The host comes from SITE_HOST when set.
 */
const RAW_DOMAIN = SITE.replace(/^sc-domain:/, "");
const DOMAIN = process.env.SITE_HOST ?? (/^www\./.test(RAW_DOMAIN) ? RAW_DOMAIN : "www." + RAW_DOMAIN);

const b64url = (b) => Buffer.from(b).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function token() {
  /*
   * The secret holds the key document two different ways depending on how it was pasted: raw JSON, or that
   * JSON base64-encoded. The GSC tools accept both; this one only accepted base64 and therefore reported
   * "no credentials" in a run whose log shows the variable set.
   */
  const raw = (process.env.GSC_CREDENTIALS_BASE64 ?? process.env.GSC_CREDENTIALS ?? "").trim();
  if (!raw) return null;
  let creds;
  try {
    creds = raw.startsWith("{") ? JSON.parse(raw) : JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
  } catch { return null; }
  if (!creds.client_email || !creds.private_key) return null;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: creds.client_email,
    scope: "https://www.googleapis.com/auth/webmasters.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claim}`);
  return `${header}.${claim}.${b64url(signer.sign(creds.private_key))}`;
}

/* Newest pages first, then a slice of the rest: recency is where "not indexed yet" is expected. */
const pages = [];
for (const dir of ["blog", "guide"]) {
  for (const f of readdirSync(join(ROOT, "src", "content", dir))) {
    if (!f.endsWith(".md")) continue;
    const raw = readFileSync(join(ROOT, "src", "content", dir, f), "utf8");
    if (/^draft:\s*true/m.test(raw)) continue;
    const date = (/^publishDate:\s*"?(\d{4}-\d\d-\d\d)/m.exec(raw) ?? [])[1] ?? "";
    pages.push({ url: `https://${DOMAIN}/${dir}/${f.replace(/\.md$/, "")}/`, date });
  }
}
pages.sort((a, b) => String(b.date).localeCompare(String(a.date)));
let sample = pages.slice(0, LIMIT);
if (RECENT_DAYS > 0) {
  const cutoff = new Date(Date.now() - RECENT_DAYS * 86400000).toISOString().slice(0, 10);
  const recent = pages.filter((p) => p.date >= cutoff);
  sample = recent.slice(0, LIMIT);
}

const assertion = token();
if (!assertion) {
  console.log("INDEX STATUS\n" + "=".repeat(70));
  console.log("  no GSC credentials in this environment - nothing checked");
  process.exit(0);
}

const tok = await (await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  signal: AbortSignal.timeout(30000),
})).json();
if (!tok.access_token) {
  console.log("  token exchange failed: " + (tok.error ?? "unknown"));
  process.exit(0);
}

const counts = new Map();
const rows = [];
for (const p of sample) {
  try {
    const r = await fetch("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect", {
      method: "POST",
      headers: { authorization: "Bearer " + tok.access_token, "content-type": "application/json" },
      body: JSON.stringify({ inspectionUrl: p.url, siteUrl: SITE }),
      signal: AbortSignal.timeout(30000),
    });
    const j = await r.json();
    const res = j.inspectionResult?.indexStatusResult ?? {};
    const state = res.coverageState ?? (j.error?.message ? "error: " + j.error.message.slice(0, 40) : "unknown");
    counts.set(state, (counts.get(state) ?? 0) + 1);
    rows.push({ url: p.url, state, verdict: res.verdict ?? "", lastCrawl: res.lastCrawlTime ?? "" });
  } catch (e) {
    counts.set("request failed", (counts.get("request failed") ?? 0) + 1);
    rows.push({ url: p.url, state: "request failed: " + String(e.message).slice(0, 40) });
  }
}

const out = { at: new Date().toISOString(), site: SITE, recentDays: RECENT_DAYS, sampled: sample.length, counts: Object.fromEntries(counts), rows };
mkdirSync(join(ROOT, "data", "gsc"), { recursive: true });
writeFileSync(join(ROOT, "data", "gsc", `index-status-${new Date().toISOString().slice(0, 10)}.json`), JSON.stringify(out, null, 2), "utf8");

console.log("INDEX STATUS\n" + "=".repeat(70));
console.log(`  site: ${SITE}   sampled: ${sample.length} of ${pages.length} published pages`);
for (const [k, v] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
const indexed = [...counts].filter(([k]) => /indexed/i.test(k) && !/not indexed/i.test(k)).reduce((s, [, v]) => s + v, 0);
console.log(`\n  RESULT: ${indexed}/${sample.length} of the sample are indexed`);
