#!/usr/bin/env node
/**
 * CLOUDFLARE STATUS - the layer the GitHub API cannot see.
 *
 * GitHub tells us what the workflow did; it cannot tell us whether Cloudflare Pages actually deployed that
 * commit, nor whether the Worker that acts as the clock still holds its four schedules. On 2026-11-12 the
 * 20:20 agent slot produced no run at all, and the only honest sentence available was "I cannot read the
 * worker's configuration" - because the token in hand has observability scope, not Pages or Workers scope.
 *
 * This tool needs:
 *   CF_API_TOKEN   with  Account -> Cloudflare Pages: Read  and  Account -> Workers Scripts: Read
 *   CF_ACCOUNT_ID  the account id (dash.cloudflare.com -> Workers & Pages, right-hand column)
 *
 *   node tools/cf-status.mjs                    latest deployments + worker schedules
 *   node tools/cf-status.mjs --json             machine-readable
 *   node tools/cf-status.mjs --expect=<sha>     exit 1 unless that commit is the latest deployment
 *
 * Exit codes: 0 ok, 1 a check failed, 2 no token configured (the caller should say so, not pretend green).
 */
const TOKEN = process.env.CF_API_TOKEN ?? "";
const ACCOUNT = process.env.CF_ACCOUNT_ID ?? "";
const JSON_OUT = process.argv.includes("--json");
const EXPECT = process.argv.find((a) => a.startsWith("--expect="))?.split("=")[1];
/* Which project, named rather than assumed: an account can hold several Pages projects and several zones,
   and picking projects[0] is how a status tool reports the wrong site as healthy. */
const PROJECT = process.argv.find((a) => a.startsWith("--project="))?.split("=")[1] ?? process.env.CF_PAGES_PROJECT ?? "china-cross-border-insider";
const SITE = process.argv.find((a) => a.startsWith("--site="))?.split("=")[1] ?? "landedmath.com";

if (!TOKEN || !ACCOUNT) {
  console.log("CF STATUS\n" + "=".repeat(70));
  console.log("  no credentials: CF_API_TOKEN=" + (TOKEN ? "set" : "missing") + "  CF_ACCOUNT_ID=" + (ACCOUNT ? "set" : "missing"));
  console.log("  the token needs Account -> Cloudflare Pages: Read and Account -> Workers Scripts: Read");
  process.exit(2);
}

const API = "https://api.cloudflare.com/client/v4";
const call = async (path) => {
  const r = await fetch(API + path, {
    headers: { authorization: "Bearer " + TOKEN, "content-type": "application/json" },
    signal: AbortSignal.timeout(30000),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.success) throw new Error((j.errors ?? []).map((e) => e.message).join("; ").slice(0, 160) || "HTTP " + r.status);
  return j.result;
};

const out = { at: new Date().toISOString(), projects: [], workers: [] };
let failed = 0;

try {
  const projects = await call(`/accounts/${ACCOUNT}/pages/projects`);
  const names = projects.map((x) => x.name);
  if (!names.includes(PROJECT)) {
    out.projectsError = `project "${PROJECT}" not found; account has: ${names.join(", ")}`;
    failed = 1;
  }
  for (const p of projects.filter((x) => x.name === PROJECT)) {
    const latest = (p.latest_deployment ?? null);
    const row = {
      name: p.name,
      domain: p.subdomain,
      branch: latest?.deployment_trigger?.metadata?.branch ?? null,
      commit: (latest?.deployment_trigger?.metadata?.commit_hash ?? "").slice(0, 7) || null,
      stage: latest?.latest_stage?.name ?? null,
      status: latest?.latest_stage?.status ?? null,
      created: latest?.created_on ?? null,
      url: latest?.url ?? null,
    };
    try {
      const doms = await call(`/accounts/${ACCOUNT}/pages/projects/${p.name}/domains`);
      row.domains = doms.map((d) => d.name);
      row.servesSite = row.domains.some((d) => d === SITE || d.endsWith("." + SITE));
    } catch {
      row.domains = [];
      row.servesSite = false;
    }
    out.projects.push(row);
  }
} catch (e) {
  out.projectsError = String(e.message).slice(0, 160);
  failed = 1;
}

try {
  const scripts = await call(`/accounts/${ACCOUNT}/workers/scripts`);
  for (const s of scripts) {
    let schedules = [];
    try {
      const sc = await call(`/accounts/${ACCOUNT}/workers/scripts/${s.id}/schedules`);
      schedules = (sc.schedules ?? []).map((x) => x.cron);
    } catch {}
    out.workers.push({ name: s.id, modified: s.modified_on ?? null, schedules });
  }
} catch (e) {
  out.workersError = String(e.message).slice(0, 160);
  failed = 1;
}

if (out.projects.some((p) => p.servesSite === false)) {
  failed = 1;
  out.siteMismatch = true;
}
if (EXPECT) {
  const hit = out.projects.find((p) => p.commit && (p.commit === EXPECT.slice(0, 7)));
  out.expect = EXPECT;
  out.expectMatched = Boolean(hit);
  if (!hit) failed = 1;
}

if (JSON_OUT) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log("CF STATUS\n" + "=".repeat(70));
  if (out.projectsError) console.log("  pages: " + out.projectsError);
  for (const p of out.projects) {
    console.log(`  pages   ${p.name.padEnd(22)} ${String(p.status).padEnd(9)} ${String(p.stage).padEnd(9)} ${p.commit ?? "-"}  ${p.created ?? ""}`);
    console.log(`          domains: ${(p.domains ?? []).join(", ") || "(none)"}   serves ${SITE}: ${p.servesSite ? "yes" : "NO"}`);
  }
  if (out.workersError) console.log("  workers: " + out.workersError);
  for (const w of out.workers) {
    console.log(`  worker  ${w.name.padEnd(18)} schedules: ${w.schedules.length ? w.schedules.join(", ") : "(none)"}`);
  }
  if (EXPECT) console.log(`  expect  ${EXPECT} ${out.expectMatched ? "IS the latest deployment" : "is NOT the latest deployment"}`);
  console.log("\n  RESULT: " + (failed ? "a check failed" : "cloudflare agrees"));
}

process.exit(failed ? 1 : 0);
