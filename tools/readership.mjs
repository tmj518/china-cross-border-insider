#!/usr/bin/env node
/**
 * READERSHIP BY PAGE - the number that decides whether a subject earns another article.
 *
 * The site has one honest signal: how many people opened each page. It lived only as a site-wide total,
 * which cannot tell a good subject from a bad one. This writes data/readership.json: slug -> pageviews over
 * the window, so the next topic decision can start from what was actually read instead of what seemed
 * interesting to write.
 *
 *   node tools/readership.mjs --fetch --days=28   query GA4 and rewrite the file
 *   node tools/readership.mjs --report            print the top and the zero list, no network
 *
 * Credentials: the same GOOGLE_APPLICATION_CREDENTIALS / GSC_CREDENTIALS_BASE64 the GSC tools use. Without
 * them the file is left alone and the command exits 0 - a missing number must never stop the pipeline.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "data", "readership.json");
const args = process.argv.slice(2);
const flag = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const DAYS = Number(flag("days", 28));

function token() {
  /* The GA4 property and the access token come from the same service account the GSC tools use. */
  const raw = process.env.GSC_CREDENTIALS_BASE64;
  if (!raw) return null;
  try {
    const json = JSON.parse(Buffer.from(raw, "base64").toString("utf8"));
    return { json, property: json.property_id ?? json.propertyId ?? "" };
  } catch {
    return null;
  }
}

function current() {
  try {
    return JSON.parse(readFileSync(OUT, "utf8"));
  } catch {
    return { at: null, days: DAYS, pages: {} };
  }
}

if (!args.includes("--fetch")) {
  const data = current();
  const rows = Object.entries(data.pages ?? {}).sort((a, b) => b[1] - a[1]);
  console.log("READERSHIP\n" + "=".repeat(74));
  console.log(`  snapshot: ${data.at ?? "(never fetched)"}  window: ${data.days ?? DAYS} day(s)`);
  if (!rows.length) console.log("  no page has a recorded view yet");
  for (const [slug, v] of rows.slice(0, 10)) console.log(`  ${String(v).padStart(5)}  ${slug}`);
  const zero = rows.filter(([, v]) => v === 0).map(([s]) => s);
  if (zero.length) console.log(`  zero-view pages: ${zero.length}`);
  process.exit(0);
}

const cred = token();
if (!cred) {
  console.log("READERSHIP - no GA4 credentials in this environment; nothing changed");
  process.exit(0);
}

/* One runReport with a page dimension. The metric is the same screenPageViews the site card shows. */
const body = {
  dateRanges: [{ startDate: `${DAYS}daysAgo`, endDate: "today" }],
  dimensions: [{ name: "pagePath" }],
  metrics: [{ name: "screenPageViews" }],
  limit: 10000,
};
const payloadPath = join(ROOT, "data", "tmp", "ga4-pages.json");
mkdirSync(dirname(payloadPath), { recursive: true });
writeFileSync(payloadPath, JSON.stringify(body), "utf8");

let report;
try {
  const out = execFileSync(process.execPath, [join(ROOT, "tools", "ga4-request.mjs"), payloadPath], {
    encoding: "utf8",
    timeout: 120000,
  });
  report = JSON.parse(out);
} catch (e) {
  console.log("READERSHIP - the GA4 request failed; keeping the previous file: " + String(e.message).slice(0, 120));
  process.exit(0);
}

const pages = {};
for (const row of report.rows ?? []) {
  const path = String(row.dimensionValues?.[0]?.value ?? "");
  const views = Number(row.metricValues?.[0]?.value ?? 0);
  const slug = path.replace(/^\/(blog|guide)\//, "").replace(/\/$/, "").replace(/\/index\.html$/, "");
  if (!slug || slug.includes("/")) continue;
  pages[slug] = (pages[slug] ?? 0) + views;
}

writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), days: DAYS, pages }, null, 2), "utf8");
console.log(`READERSHIP - wrote ${Object.keys(pages).length} page(s) from ${DAYS} day(s) of GA4 data`);
