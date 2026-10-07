#!/usr/bin/env node
/**
 * Preflight: will the run succeed, or will it fail five commands in?
 *
 * What this is for
 * ----------------
 * Every environment problem in this project has so far been discovered the hard
 * way — by running a command and watching it fail. Section D of 进度日志.md is a
 * list of them, and this session added five more in one sitting:
 *
 *   E1  curl.exe cannot do HTTPS on this machine (schannel error), so every
 *       HTTPS fetch through it fails; node fetch works
 *   E2  node and pnpm are not on PATH; the runtime paths have to be used
 *   E3  the local astro build dies inside vite's module runner
 *   E4  git push fails on a sandbox named-pipe denial while ssh -T succeeds,
 *       which points the diagnosis in the wrong direction
 *   E5  PowerShell cannot take a heredoc for git commit -F
 *
 * None of those is hard to detect. They just were not detected, because nothing
 * checked before the run started. This checks.
 *
 * The design point that matters
 * -----------------------------
 * A missing credential is NOT a failure. Writing an article needs no R2 token
 * and no YouTube OAuth client. So credentials report as "not configured" and do
 * not affect the exit code; only things a given profile genuinely needs can
 * fail it. A preflight that goes red for an unused capability gets ignored, and
 * an ignored preflight is worse than none.
 *
 * Second design point: every check that can be verified by actually doing a
 * cheap version of the thing, does so. `python -c "import edge_tts"` is real
 * evidence; a file existence test for python.exe is not.
 *
 * Usage
 *   node tools/preflight.mjs                      # environment checks only
 *   node tools/preflight.mjs --profile=daily      # + that profile's requirements
 *   node tools/preflight.mjs --init               # write a starter profiles.json
 *   node tools/preflight.mjs --json
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const STATE_DIR = join(ROOT, "build", "state");
const STATE_FILE = join(STATE_DIR, "profiles.json");

// The interpreter that actually has edge_tts installed. The bundled runtime
// python does not, which cost time twice, so it is pinned here rather than
// discovered.
const PYTHON = "C:/Users/tmj19/AppData/Local/Programs/Python/Python313/python.exe";
const NODE = process.execPath;
const PROXY = { host: "127.0.0.1", port: 7890 };

const CRED_FILES = {
  "R2 token": [".env.r2"],
  "Web Analytics token": [".env"],
  "YouTube OAuth client": [
    join(process.env.LOCALAPPDATA ?? "", "Programs", "n8n", "youtube-oauth.json"),
  ],
};

// ------------------------------------------------------------------ reporting

const results = [];

const add = (level, name, detail) => results.push({ level, name, detail });

/** ok  = verified. fail = blocks the run. note = informational, never blocks. */
const ok = (name, detail) => add("ok", name, detail);
const fail = (name, detail) => add("fail", name, detail);
const note = (name, detail) => add("note", name, detail);

const short = (p) => String(p).replace(/^[A-Za-z]:\\Users\\[^\\]+/, "~").slice(0, 78);

// ------------------------------------------------------------------- checks

/** Run a command, return {ok, out} without throwing. */
function probe(file, args, opts = {}) {
  try {
    const out = execFileSync(file, args, {
      encoding: "utf8",
      timeout: opts.timeout ?? 20000,
      stdio: ["ignore", "pipe", "ignore"],
      ...opts,
    });
    return { ok: true, out: String(out).trim() };
  } catch (e) {
    return { ok: false, out: String(e.stdout ?? e.message ?? "").trim() };
  }
}

async function checkEnvironment() {
  // --- python: not "does the file exist", but "can it import what we use" ---
  if (!existsSync(PYTHON)) {
    fail("python 3.13", `not found at ${short(PYTHON)} — video and audio need it`);
  } else {
    const v = probe(PYTHON, ["-c", "import sys;print(sys.version.split()[0])"]);
    const libs = probe(PYTHON, ["-c", "import edge_tts, PIL; print('ok')"], { timeout: 40000 });
    if (v.ok && libs.ok) {
      ok("python", `${short(PYTHON)}  v${v.out}, edge_tts + Pillow importable`);
    } else if (v.ok) {
      fail("python libs", `v${v.out} but an import failed: ${libs.out.split("\n")[0]}`);
    } else {
      fail("python", `present but will not run: ${v.out.split("\n")[0]}`);
    }
  }

  // --- ffmpeg / ffprobe: the video pipeline is dead without them ---
  for (const tool of ["ffmpeg", "ffprobe"]) {
    const r = probe(tool, ["-version"]);
    if (r.ok) {
      const ver = (/version\s+(\S+)/.exec(r.out) ?? [])[1] ?? "?";
      ok(tool, `v${ver}`);
    } else {
      // Not fatal: only the video/audio steps need it.
      note(tool, "not on PATH — video and podcast rendering will fail");
    }
  }

  // --- proxy: D10. Every network tool here depends on it being up ---
  const listening = await new Promise((res) => {
    import("node:net").then(({ Socket }) => {
      const s = new Socket();
      s.setTimeout(2500);
      s.once("connect", () => { s.destroy(); res(true); });
      s.once("timeout", () => { s.destroy(); res(false); });
      s.once("error", () => res(false));
      s.connect(PROXY.port, PROXY.host);
    });
  });
  listening
    ? ok("proxy", `${PROXY.host}:${PROXY.port} is listening`)
    : fail("proxy", `${PROXY.host}:${PROXY.port} not listening — every fetch will time out`);

  // --- HTTPS: E1. Test with node fetch, because curl.exe is the thing that is
  // broken; testing with curl would report the wrong layer.
  try {
    const res = await fetch("https://example.com", { signal: AbortSignal.timeout(12000) });
    ok("https reachable", `example.com -> HTTP ${res.status} (via node fetch, not curl)`);
  } catch (e) {
    fail("https reachable", `node fetch failed: ${e.message} — check the proxy client is running`);
  }

  // --- curl: recorded so nobody reaches for it for an HTTPS job ---
  const curlHttps = spawnSync("curl.exe", ["-sS", "-o", "NUL", "-w", "%{http_code}", "https://example.com"], {
    encoding: "utf8",
    timeout: 20000,
  });
  if (curlHttps.status === 0 && (curlHttps.stdout ?? "").includes("200")) {
    ok("curl.exe https", "working today — but node fetch is the reliable path (see E1)");
  } else {
    note(
      "curl.exe https",
      "BROKEN as expected (E1: schannel SEC_E_NO_CREDENTIALS). Use node fetch for HTTPS; " +
        "curl.exe is only good for plain HTTP here.",
    );
  }

  // --- git push path: E4. Probe the actual push path, not just port 22 ---
  //
  // The first version of this probed `ssh -T git@github.com` and treated a
  // non-greeting as fatal. That is the wrong test: `ssh -T` defaults to port 22,
  // and this project already records that github.com over the network is
  // intermittently disrupted while pushes still succeed. So port 22 timing out
  // says nothing about whether a push will work, and a check that goes red on
  // the wrong signal gets ignored.
  //
  // What is probed instead: `git ls-remote` against the real remote, which uses
  // whatever the remote's configured URL actually is (SSH over 22 or 443), with
  // one retry because the failure mode here is lossy rather than deterministic.
  const gitProbe = () =>
    spawnSync("git", ["ls-remote", "--heads", "origin", "main"], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 45000,
    });

  let ls = gitProbe();
  let attempt = 1;
  while (ls.status !== 0 && attempt < 2) {
    attempt++;
    ls = gitProbe();
  }
  if (ls.status === 0 && /refs\/heads\/main/.test(ls.stdout ?? "")) {
    ok("git remote", `git ls-remote origin main responded (attempt ${attempt})`);
  } else {
    const why = `${(ls.stderr ?? "").split("\n").filter(Boolean).slice(-1)[0] ?? "no output"}`;
    fail(
      "git remote",
      `git ls-remote failed after ${attempt} attempt(s): ${why.slice(0, 100)} — pushes will fail; ` +
        `this is intermittent here, so retry before concluding the network is down`,
    );
  }

  // --- the gates themselves: a gate that cannot run is not a gate ---
  const gate = probe(NODE, [join(ROOT, "tools", "qa-check.mjs"), "--all"], { timeout: 120000 });
  if (gate.ok || gate.out.includes("RESULT:")) {
    const verdict = /RESULT:.*/.exec(gate.out)?.[0] ?? "(no verdict line)";
    ok("qa-check runs", verdict.trim());
  } else {
    fail("qa-check runs", `exited badly: ${gate.out.split("\n").slice(-1)[0].slice(0, 90)}`);
  }

  // --- the review clock: is any article past the date it goes stale? ---
  // exit 1 is the signal here, not a failure of the tool, so status is read
  // rather than throwing.
  const review = spawnSync(NODE, [join(ROOT, "tools", "review-dates.mjs"), "--overdue"], {
    encoding: "utf8",
    timeout: 60000,
  });
  const reviewOut = `${review.stdout ?? ""}${review.stderr ?? ""}`.trim();
  if (review.status === 0) {
    ok("review-dates", reviewOut.split("\n")[0] || "nothing overdue");
  } else if (/OVERDUE FOR REVIEW/.test(reviewOut)) {
    const n = /(\d+) article\(s\) overdue/.exec(reviewOut)?.[1] ?? "?";
    // Not a hard failure of the environment, but it is a content obligation.
    note("review-dates", `${n} article(s) past their reviewBy date — see data/review/upcoming.md`);
  } else {
    fail("review-dates", `could not run: ${reviewOut.split("\n").slice(-1)[0].slice(0, 90)}`);
  }
}

function checkCredentials() {
  for (const [label, candidates] of Object.entries(CRED_FILES)) {
    const found = candidates.find((p) => existsSync(p));
    if (found) {
      const size = readFileSync(found, "utf8").trim().length;
      // Report only that it is populated, never the value.
      ok(label, `${short(found)} present${size === 0 ? " but EMPTY" : ""}`);
    } else {
      note(label, "not configured — fine unless this run needs it");
    }
  }
}

// ------------------------------------------------------------------ profiles

/**
 * Named cadences, mirroring spec §8 (weekly 3-4 pieces, one per day max).
 * This is the equivalent of the other pipeline's roundup / deep_dive /
 * weekly_deep, and it exists so the schedule is named rather than implied.
 */
const PROFILES = {
  daily: {
    every: "day",
    atHour: 7,
    what: "publish at most one piece: draft, both gates, commit, push, verify live",
    needs: ["python", "proxy", "https reachable", "git remote", "qa-check runs"],
  },
  weekly: {
    every: "week",
    weekday: 1,
    atHour: 14,
    what: "review-dates sweep, GSC pull, gate self-audit, topic pool refresh",
    needs: ["proxy", "https reachable", "qa-check runs"],
  },
  monthly: {
    every: "month",
    day: 1,
    atHour: 9,
    what: "direction call: which silo to double down on, and the updated-date sweep",
    needs: ["proxy", "https reachable"],
  },
  review: {
    every: "week",
    weekday: 3,
    atHour: 9,
    what: "article review clock: report any piece past its reviewBy date",
    needs: ["proxy", "https reachable", "review-dates"],
  },
};

const DAY = 86400000;

/**
 * A local timestamp as YYYY-MM-DD HH:MM.
 *
 * Deliberately not toISOString(): that renders UTC, while the schedule below is
 * built with setHours(), which is local. Mixing the two displayed every due
 * time eight hours off on this machine (UTC+8), so a 07:00 run read as 23:00 of
 * the previous day. The wall-clock time is what a human acts on, so the display
 * is local and says so.
 */
const localStamp = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ` +
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

function nextDue(profile, lastIso) {
  const base = lastIso ? new Date(lastIso) : new Date();
  const d = new Date(base);
  if (profile.every === "day") d.setDate(d.getDate() + 1);
  else if (profile.every === "week") d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + 1);
  d.setHours(profile.atHour, 0, 0, 0);
  return d;
}

function loadState() {
  if (!existsSync(STATE_FILE)) return { profiles: {} };
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { profiles: {} };
  }
}

function reportProfiles(state, requested) {
  const names = requested ? [requested] : Object.keys(PROFILES);
  console.log("\nPROFILES");
  console.log("=".repeat(78));
  for (const name of names) {
    const p = PROFILES[name];
    if (!p) {
      fail("profile", `unknown profile "${name}" (have: ${Object.keys(PROFILES).join(", ")})`);
      continue;
    }
    const last = state.profiles?.[name]?.lastRun ?? null;
    const due = nextDue(p, last);
    const overdue = due.getTime() < Date.now();
    console.log(
      `  ${name.padEnd(9)} ${overdue ? "OVERDUE" : "Ready  "} next=${localStamp(due)}  last=${last ? localStamp(new Date(last)) : "(never)"}`,
    );
    console.log(`            ${p.what}`);
    console.log(`            needs: ${p.needs.join(", ")}`);
  }
  console.log();
}

function writeInitialState() {
  mkdirSync(STATE_DIR, { recursive: true });
  const seed = {
    _note:
      "Run times for the named cadences. Written by tools/preflight.mjs. " +
      "This lives under build/, which is gitignored, so it is machine state and " +
      "not project content.",
    profiles: Object.fromEntries(Object.keys(PROFILES).map((k) => [k, { lastRun: null }])),
  };
  writeFileSync(STATE_FILE, JSON.stringify(seed, null, 2), "utf8");
  console.log(`wrote ${STATE_FILE}`);
}

// ---------------------------------------------------------------------- main

const args = process.argv.slice(2);
const arg = (n) => args.find((a) => a.startsWith(`--${n}=`))?.split("=").slice(1).join("=");

if (args.includes("--init")) {
  writeInitialState();
  process.exit(0);
}

await checkEnvironment();
checkCredentials();

const requested = arg("profile");
const state = loadState();

if (args.includes("--json")) {
  console.log(JSON.stringify({ results, profiles: PROFILES }, null, 2));
  process.exit(results.some((r) => r.level === "fail") ? 1 : 0);
}

const pad = (s, n) => String(s).padEnd(n);
console.log("\nPREFLIGHT — will the run succeed?\n");
console.log("ENVIRONMENT");
console.log("=".repeat(78));
for (const r of results) {
  const tag = r.level === "ok" ? "[ ok ]" : r.level === "fail" ? "[FAIL]" : "[ -- ]";
  console.log(`  ${tag} ${pad(r.name, 20)} ${r.detail}`);
}

reportProfiles(state, requested);

if (requested) {
  const p = PROFILES[requested];
  if (p) {
    const missing = p.needs.filter(
      (n) => !results.some((r) => r.level === "ok" && (r.name === n || r.name.startsWith(n))),
    );
    if (missing.length) {
      console.log(`PROFILE "${requested}" IS NOT READY`);
      console.log(`  missing: ${missing.join(", ")}`);
      console.log();
    } else {
      console.log(`PROFILE "${requested}" IS READY`);
      console.log(
        `  after a successful run, record it:  node tools/preflight.mjs --done=${requested}`,
      );
      console.log();
    }
  }
}

if (args.some((a) => a.startsWith("--done="))) {
  const name = arg("done");
  const s = loadState();
  s.profiles = s.profiles ?? {};
  s.profiles[name] = { lastRun: new Date().toISOString() };
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), "utf8");
  console.log(`recorded run for profile "${name}"`);
}

const failures = results.filter((r) => r.level === "fail");
console.log(
  failures.length
    ? `RESULT: ${failures.length} BLOCKING — fix before starting.`
    : "ALL CLEAR — the unattended run should complete.",
);
console.log(
  "  A missing credential is not blocking. Credentials are needed per step, not per run.\n",
);
process.exit(failures.length ? 1 : 0);
