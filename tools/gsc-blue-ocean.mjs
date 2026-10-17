#!/usr/bin/env node
/**
 * Blue-ocean keywords from Search Console: high impressions, low click-through, ranking on page one or two.
 *
 *   node tools/gsc-blue-ocean.mjs              last 7 days, write data/blue-ocean/<date>.json
 *   node tools/gsc-blue-ocean.mjs --days=28    a wider window
 *   node tools/gsc-blue-ocean.mjs --dry-run    show the shape of the request, call nothing
 *
 * ## Why this is the honest source of "blue ocean"
 *
 * A third-party volume figure is somebody else's estimate of a market. Search Console reports what actually
 * happened on this site: how often a query showed a page, how often the page was clicked, and where it ranked.
 *
 * The filter finds the specific gap worth writing for:
 *
 *   impressions > 1000   people are searching this and seeing us
 *   CTR < 1%             they are not clicking, so the title or the promise is wrong
 *   position 5-20        we are on page one or two, so the page can be made to rank
 *
 * That combination is a page that already earns its impression with a title nobody clicks. Writing a better
 * article for the query is the cheapest win available, and no keyword tool can tell you it exists.
 *
 * ## No dependency, and no secret in the tree
 *
 * The service-account credentials arrive as GSC_CREDENTIALS_BASE64 and are decoded in memory. A JWT is signed
 * with node:crypto and exchanged for an access token, which is forty lines and avoids adding googleapis (a
 * hundred megabytes) to a site whose whole JavaScript budget is nine kilobytes.
 *
 * ## Degrading is the normal path
 *
 * A new site has no Search Console history, a service account may not be invited to the property, and the API
 * may be rate-limited. Every one of those is an ordinary state, so the script exits 0 with `available: false`
 * and a reason, writes that to the same file, and the pipeline falls back to official-document subject choice.
 * It never fails a publishing run.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createSign } from "node:crypto";

const ROOT = process.cwd();
const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};

const DAYS = Number(flag("days", "7"));
const DRY = args.includes("--dry-run");
const OUT_DIR = join(ROOT, "data", "blue-ocean");
const OUT = join(OUT_DIR, `${new Date().toISOString().slice(0, 10)}.json`);

/* The property as Search Console names it. A Domain property is sc-domain:<host>. */
const SITE = flag("site", "") || (process.env.GSC_SITE ?? "").trim() || "sc-domain:landedmath.com";

/** Thresholds, in one place so the report can state what it filtered on. */
const FILTER = { minImpressions: 1000, maxCtr: 0.01, minPosition: 5, maxPosition: 20, top: 3 };

const log = (s) => console.log(s);

function finish(obj, code = 0) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), site: SITE, windowDays: DAYS, filter: FILTER, ...obj }, null, 2), "utf8");
  log("");
  log(`  written: ${OUT.replace(ROOT, "").replace(/\\/g, "/")}`);
  process.exit(code);
}

log("GSC BLUE OCEAN");
log("=".repeat(78));
log(`  site      : ${SITE}`);
log(`  window    : ${DAYS} day(s)`);
log(`  filter    : impressions > ${FILTER.minImpressions}, ctr < ${FILTER.maxCtr * 100}%, position ${FILTER.minPosition}-${FILTER.maxPosition}`);
log("");

/* ── credentials ───────────────────────────────────────────────────────────────────────────────── */
const B64 = (process.env.GSC_CREDENTIALS_BASE64 ?? "").trim();

if (DRY) {
  log("  credentials : " + (B64 ? `${B64.length} base64 characters present` : "GSC_CREDENTIALS_BASE64 is not set"));
  log("  request     : POST https://searchconsole.googleapis.com/webmasters/v3/sites/<site>/searchAnalytics/query");
  log("  body        : { startDate, endDate, dimensions: [\"query\"], rowLimit: 25000 }");
  log("");
  log("  --dry-run: nothing called, nothing written.");
  process.exit(0);
}

if (!B64) {
  log("  credentials : GSC_CREDENTIALS_BASE64 is not set");
  log("");
  log("  This is not a failure. The pipeline falls back to choosing a subject from the official documents,");
  log("  which is what it did before this existed. To enable it:");
  log("");
  log("    Google Cloud -> IAM -> Service accounts -> create -> Keys -> add key -> JSON");
  log("    base64 -w0 key.json            (PowerShell: [Convert]::ToBase64String([IO.File]::ReadAllBytes('key.json')))");
  log("    GitHub -> Settings -> Secrets -> GSC_CREDENTIALS_BASE64");
  log("    Search Console -> Settings -> Users and permissions -> add the service-account email as a user");
  finish({ available: false, reason: "GSC_CREDENTIALS_BASE64 is not set", keywords: [] }, 0);
}

let creds;
try {
  creds = JSON.parse(Buffer.from(B64, "base64").toString("utf8"));
} catch (e) {
  log(`  credentials : GSC_CREDENTIALS_BASE64 does not decode to JSON - ${e.message.slice(0, 80)}`);
  finish({ available: false, reason: "credentials are not valid base64 JSON", keywords: [] }, 0);
}

if (!creds.client_email || !creds.private_key) {
  log("  credentials : the JSON has no client_email or private_key - is this a service-account key?");
  finish({ available: false, reason: "credentials are not a service-account key", keywords: [] }, 0);
}
log(`  credentials : ${creds.client_email}`);

/* ── a token, signed with node:crypto ──────────────────────────────────────────────────────────── */
const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function serviceAccountToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(
    JSON.stringify({
      iss: creds.client_email,
      scope: "https://www.googleapis.com/auth/webmasters.readonly",
      aud: "https://oauth2.googleapis.com/token",
      iat: now,
      exp: now + 3600,
    }),
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claim}`);
  const signature = b64url(signer.sign(creds.private_key));
  return `${header}.${claim}.${signature}`;
}

let token;
try {
  const assertion = serviceAccountToken();
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    signal: AbortSignal.timeout(30000),
  });
  const j = await res.json();
  if (!res.ok || !j.access_token) {
    log(`  token       : FAILED - HTTP ${res.status} ${j.error ?? ""} ${String(j.error_description ?? "").slice(0, 120)}`);
    finish({ available: false, reason: `token exchange failed: ${j.error ?? res.status}`, keywords: [] }, 0);
  }
  token = j.access_token;
  log("  token       : ok");
} catch (e) {
  log(`  token       : FAILED - ${e.cause?.code ?? e.message}`);
  finish({ available: false, reason: `token exchange failed: ${e.cause?.code ?? e.message}`, keywords: [] }, 0);
}

/* ── the query ─────────────────────────────────────────────────────────────────────────────────── */
const end = new Date(Date.now() - 2 * 86400000); /* Search Console lags two to three days. */
const start = new Date(end.getTime() - DAYS * 86400000);
const body = {
  startDate: start.toISOString().slice(0, 10),
  endDate: end.toISOString().slice(0, 10),
  dimensions: ["query"],
  rowLimit: 25000,
  dataState: "final",
};

log(`  range       : ${body.startDate} .. ${body.endDate}`);

let rows = [];
try {
  const res = await fetch(`https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(SITE)}/searchAnalytics/query`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const j = await res.json();
  if (!res.ok) {
    const msg = String(j.error?.message ?? JSON.stringify(j).slice(0, 160));
    log(`  query       : FAILED - HTTP ${res.status} ${msg.slice(0, 140)}`);
    const reason = /not (?:found|verified)|permission|403/i.test(msg)
      ? "the service account is not a user on this Search Console property"
      : `query failed: ${msg.slice(0, 120)}`;
    finish({ available: false, reason, keywords: [] }, 0);
  }
  rows = j.rows ?? [];
  log(`  query       : ok - ${rows.length} query row(s)`);
} catch (e) {
  log(`  query       : FAILED - ${e.cause?.code ?? e.message}`);
  finish({ available: false, reason: `query failed: ${e.cause?.code ?? e.message}`, keywords: [] }, 0);
}

/* ── the filter ───────────────────────────────────────────────────────────────────────────────── */
const all = rows.map((r) => ({
  query: String(r.keys?.[0] ?? ""),
  impressions: Math.round(r.impressions ?? 0),
  clicks: Math.round(r.clicks ?? 0),
  ctr: Number(r.ctr ?? 0),
  position: Math.round((r.position ?? 0) * 10) / 10,
}));

const blue = all
  .filter(
    (r) =>
      r.query &&
      r.impressions > FILTER.minImpressions &&
      r.ctr < FILTER.maxCtr &&
      r.position >= FILTER.minPosition &&
      r.position <= FILTER.maxPosition,
  )
  .sort((a, b) => b.impressions - a.impressions)
  .slice(0, FILTER.top);

log("");
log(`  total rows  : ${all.length}`);
log(`  matched     : ${blue.length}`);
log("");

for (const [i, r] of blue.entries()) {
  log(`  ${i + 1}. ${r.query}`);
  log(`     impressions ${r.impressions}  clicks ${r.clicks}  ctr ${(r.ctr * 100).toFixed(2)}%  position ${r.position}`);
}

if (!blue.length) {
  /*
   * An empty result is information, not a failure. Four hundred impressions total means there is not yet a
   * query with a thousand of them, and the filter is doing exactly what it says.
   */
  const top = all.sort((a, b) => b.impressions - a.impressions).slice(0, 5);
  log("  No query met all three conditions. The most-seen queries were:");
  for (const r of top) log(`     ${String(r.impressions).padStart(5)} imp  pos ${String(r.position).padStart(5)}  ${r.query.slice(0, 70)}`);
  log("");
  log("  That is a fact about reach, not a fault. The pipeline falls back to official-document subjects.");
  finish({ available: true, empty: true, reason: "no query met the impression, ctr and position thresholds", keywords: [], topSeen: top }, 0);
}

finish({ available: true, empty: false, keywords: blue, topSeen: all.sort((a, b) => b.impressions - a.impressions).slice(0, 5) }, 0);
