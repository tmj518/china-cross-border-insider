/**
 * Shared plumbing for the data scripts: curl-backed HTTP, and Search Console
 * access with a service account.
 *
 * Everything goes through curl.exe rather than node fetch. curl reads
 * %USERPROFILE%\.curlrc, which carries the local proxy and ssl-no-revoke; node
 * fetch honours neither, and this machine cannot reach Google without both.
 */

import { execFileSync } from "node:child_process";
import { createSign } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";

/** Synchronous sleep. setTimeout in a child process does not block. */
export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * .env files are read directly rather than with a dependency, and they do not
 * go through dotenv because the harness that spawns these shells captured its
 * environment at startup — new processes never inherit user-level variables.
 */
export function loadEnv(path) {
  const env = { ...process.env };
  if (path && existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
    }
  }
  return env;
}

export function httpCurl(args, { maxBuffer = 32 * 1024 * 1024 } = {}) {
  return execFileSync("curl.exe", args, {
    encoding: "utf8",
    maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * GET with retries. Not optional: this proxy path drops 25-50% of requests,
 * measured, and the loss is on the path rather than at any one provider.
 * Budget roughly 1.6 attempts per request.
 */
export function getWithRetry(url, { retries = 4, accept = "application/json", stats } = {}) {
  let lastErr;
  for (let i = 1; i <= retries; i++) {
    try {
      const raw = httpCurl([
        "-4", "-sS", "--max-time", "30",
        "-H", `Accept: ${accept}`,
        "-A", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
        "-w", "\n%{http_code}",
        url,
      ]);
      const idx = raw.lastIndexOf("\n");
      const status = parseInt(raw.slice(idx + 1).trim(), 10);
      const body = raw.slice(0, idx);
      if (status >= 200 && status < 300) return { status, body };
      if (status >= 400 && status < 500 && status !== 429) return { status, body };
      lastErr = new Error(`HTTP ${status}`);
    } catch (e) {
      lastErr = e;
    }
    if (i < retries) {
      if (stats) stats.retries++;
      sleepSync(i * 1500);
    }
  }
  throw lastErr;
}

const b64url = (input) =>
  Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

/**
 * Service-account auth without the googleapis dependency: sign a JWT with the
 * key from the JSON file and exchange it for an access token. node:crypto does
 * RS256 natively, and googleapis would add tens of megabytes for two calls.
 */
export function gscAccessToken(env, stats) {
  const path = env.GSC_CREDENTIALS;
  if (!path || !existsSync(path)) return null;
  const creds = JSON.parse(readFileSync(path, "utf8"));
  const iat = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: creds.client_email,
      scope: "https://www.googleapis.com/auth/webmasters.readonly",
      aud: "https://oauth2.googleapis.com/token",
      exp: iat + 3600,
      iat,
    }),
  );
  const signingInput = `${header}.${claims}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  const jwt = `${signingInput}.${b64url(signer.sign(creds.private_key))}`;

  const body =
    `grant_type=${encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")}` +
    `&assertion=${jwt}`;
  const raw = httpCurl([
    "-4", "-sS", "--max-time", "30", "-X", "POST",
    "-H", "Content-Type: application/x-www-form-urlencoded",
    "-d", body, "https://oauth2.googleapis.com/token",
  ], { maxBuffer: 8 * 1024 * 1024 });
  const parsed = JSON.parse(raw);
  if (!parsed.access_token) throw new Error(`token exchange failed: ${raw.slice(0, 200)}`);
  if (stats) stats.gscCalls = (stats.gscCalls ?? 0) + 1;
  return parsed.access_token;
}

/** Run a Search Analytics query. Returns the raw parsed response. */
export function gscSearchAnalytics(env, payload, stats) {
  const site = env.GSC_SITE_URL;
  if (!site) return null;
  const token = gscAccessToken(env, stats);
  if (!token) return null;
  if (stats) stats.gscCalls = (stats.gscCalls ?? 0) + 1;

  const url =
    "https://searchconsole.googleapis.com/webmasters/v3/sites/" +
    `${encodeURIComponent(site)}/searchAnalytics/query`;
  const raw = httpCurl([
    "-4", "-sS", "--max-time", "90", "-X", "POST",
    "-H", `Authorization: Bearer ${token}`,
    "-H", "Content-Type: application/json",
    "-d", JSON.stringify(payload), url,
  ], { maxBuffer: 128 * 1024 * 1024 });

  const parsed = JSON.parse(raw);
  if (parsed.error) throw new Error(`GSC: ${parsed.error.message}`);
  return parsed;
}

export function isoDaysAgo(days) {
  return new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}
