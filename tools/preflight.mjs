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
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  /*
   * Every tool must at least parse, checked before the gates run.
   *
   * This exists because one of them silently stopped parsing. A PowerShell
   * round-trip used for a regression test re-encoded tools/serp-check.mjs through the
   * ANSI code page, which turned one Chinese character in a regex into a replacement
   * character and made the file invalid UTF-8. The commit was pushed, and nothing
   * here noticed: the structural gate still passed, the build still passed, and only
   * the information-gain gate was dead. A syntax sweep is cheap and would have
   * caught it on the spot.
   */
  /*
   * The documents the daily run is required to read.
   *
   * The operator asked on 2026-10-08 for two things to stop depending on good intentions:
   * that the source inventory is actually consulted before choosing a topic, and that
   * lessons from the benchmark research are actually applied rather than filed. A rule in
   * a text file that nobody opens is not a rule, so the files are checked for existence
   * and for a plausible size here, and a missing one fails the preflight.
   *
   * Size matters as well as presence: a truncated or emptied file would otherwise pass.
   */
  const REQUIRED_DOCS = [
    ["信源清单.md", 4000, "the tested inventory of 23 reachable official sources"],
    ["初心与目标.md", 2000, "the single standard for judging trade-offs"],
    ["经验与踩坑记录.md", 4000, "the reusable lessons, including the benchmark findings"],
    ["对标学习10条.md", 3000, "the ten mechanisms to copy, one of which each run must advance"],
  ];
  const docProblems = [];
  for (const [name, minBytes, why] of REQUIRED_DOCS) {
    const p = join(ROOT, name);
    if (!existsSync(p)) { docProblems.push(`${name} missing (${why})`); continue; }
    const size = statSync(p).size;
    if (size < minBytes) docProblems.push(`${name} is only ${size} bytes, expected at least ${minBytes}`);
  }
  if (docProblems.length === 0) {
    ok("required docs", `${REQUIRED_DOCS.length} present — sources, goals, lessons, benchmarks`);
  } else {
    fail("required docs", docProblems.join(" | "));
  }

  const toolFiles = readdirSync(join(ROOT, "tools")).filter((f) => f.endsWith(".mjs"));
  const broken = [];
  for (const f of toolFiles) {
    const r = spawnSync(NODE, ["--check", join(ROOT, "tools", f)], { encoding: "utf8" });
    if (r.status !== 0) {
      const why = `${(r.stderr ?? "").split("\n").filter((l) => /Error|SyntaxError/.test(l))[0] ?? "does not parse"}`;
      broken.push(`${f}: ${why.trim().slice(0, 70)}`);
    }
  }
  if (broken.length === 0) {
    ok("tools parse", `all ${toolFiles.length} scripts parse — no gate is silently dead`);
  } else {
    fail("tools parse", `${broken.length} of ${toolFiles.length} broken | ${broken.slice(0, 3).join(" | ")}`);
  }

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
    const n = /(\d+ )?article\(s\) overdue|OVERDUE/.test(reviewOut) ? (/(\d+) article\(s\) overdue/.exec(reviewOut)?.[1] ?? "?") : "?";
    // Not a hard failure of the environment, but it is a content obligation.
    note("review-dates", `${n} article(s) past their reviewBy date — see data/review/upcoming.md`);
  } else {
    fail("review-dates", `could not run: ${reviewOut.split("\n").slice(-1)[0].slice(0, 90)}`);
  }
}

/**
 * The real build, run locally.
 *
 * This is the only check that reproduces what Cloudflare Pages actually does. On
 * 2026-10-07 a single content-schema violation — a subtitle three characters over
 * its limit — failed the build and took the whole site down to a stale
 * deployment for over ten minutes, while every gate reported green because
 * qa-check reads markdown as text and never validated against the Zod schema.
 *
 * A green build locally is not proof the deploy will succeed, but a red one is
 * proof it will not, and that is the whole value here. It is cheap: about three
 * seconds and 26 pages on this machine, measured repeatedly.
 *
 * Run for every profile. There is no profile where a broken build is acceptable.
 */
function checkBuild() {
  const started = Date.now();
  const r = spawnSync(NODE, [join(ROOT, "node_modules", "astro", "bin", "astro.mjs"), "build"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 300000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const secs = ((Date.now() - started) / 1000).toFixed(1);

  if (r.status === 0) {
    const pages = /(\d+) page\(s\) built/.exec(out)?.[1] ?? "?";
    ok("astro build", `${pages} pages in ${secs}s — the deploy will build`);
  } else {
    // Surface the schema message, which is the part that says what to fix.
    const reason =
      /(InvalidContentEntryDataError[\s\S]{0,200})/.exec(out)?.[1]?.replace(/\s+/g, " ").slice(0, 150) ??
      out.trim().split("\n").slice(-1)[0]?.slice(0, 150) ??
      "unknown error";
    fail(
      "astro build",
      `BUILD FAILS (${secs}s) — pushing this breaks the live site for every page. ${reason}`,
    );
  }
}

/**
 * Every published article must have a page in the build output.
 *
 * The guard above catches a build that fails. This catches a build that succeeds
 * while silently dropping an article — a collection filter, a slug collision, a
 * draft flag applied by mistake. The failure it is really about is scale: on
 * 2026-10-07 a single schema violation failed the whole build and took all
 * sixteen articles down to a stale deployment. Eighteen articles now sit behind
 * one build, and "the build passed" and "the site contains the articles" are
 * different claims.
 *
 * Cheap, because the build has already run: read the markdown filenames and check
 * that dist/blog/<slug>/index.html exists for each.
 */
function checkEveryArticleBuilt() {
  const blogDir = join(ROOT, "src", "content", "blog");
  const distDir = join(ROOT, "dist", "blog");

  let published = [];
  try {
    published = readdirSync(blogDir)
      .filter((f) => f.endsWith(".md"))
      .filter((f) => !/^draft:\s*true/m.test(readFileSync(join(blogDir, f), "utf8")))
      .map((f) => f.replace(/\.md$/, ""));
  } catch (e) {
    fail("articles built", `cannot read the article directory: ${e.message}`);
    return;
  }

  if (!published.length) {
    fail("articles built", "no published articles found — is the content directory right?");
    return;
  }

  const missing = published.filter((slug) => !existsSync(join(distDir, slug, "index.html")));
  if (missing.length === 0) {
    ok("articles built", `${published.length}/${published.length} published articles have a page in dist/`);
  } else {
    fail(
      "articles built",
      `${missing.length} of ${published.length} published article(s) produced no page: ` +
        `${missing.slice(0, 3).join(", ")}${missing.length > 3 ? ", ..." : ""}`,
    );
  }

  // The sitemap is what a crawler follows, so a page that built but is not listed
  // is still a page that will not be found.
  try {
    const sm = readFileSync(join(ROOT, "dist", "sitemap-0.xml"), "utf8");
    const unlisted = published.filter((slug) => !sm.includes(`/blog/${slug}/`));
    if (unlisted.length) {
      note("articles in sitemap", `${unlisted.length} built but unlisted: ${unlisted.slice(0, 3).join(", ")}`);
    } else {
      ok("articles in sitemap", `all ${published.length} listed`);
    }
  } catch {
    note("articles in sitemap", "dist/sitemap-0.xml not readable — skipped");
  }
}

checkBuild();
// Runs after the build, because it inspects dist/. A build that succeeds while
// dropping an article is the failure this catches, and the build check above
// cannot see it.
checkEveryArticleBuilt();

/**
 * The policy must permit the scripts the pages ship.
 *
 * This check exists because its absence cost real time: Content-Security-Policy in
 * _headers said `script-src 'self'`, Astro inlines page scripts by default, and the
 * browser therefore refused every one of them. The mobile Menu button did nothing,
 * and the build, the four gates, the deploy and the sitemap all reported success.
 * One line of static checking would have caught it.
 */
function checkCsp() {
  const r = spawnSync(process.execPath, [join(ROOT, "tools", "check-csp.mjs")], { encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const summary = out.split("\n").find((l) => /RESULT:/.test(l))?.trim() ?? "";
  if (r.status === 0) {
    ok("csp", summary || "every page's policy permits its scripts");
  } else {
    const first = out.split("\n").find((l) => /inline script not covered|declares its own script-src/.test(l))?.trim() ?? "";
    fail("csp", `${summary} | ${first}`.slice(0, 160));
  }
}

checkCsp();

/**
 * Structured data must exist on every page, and be valid where validity is defined.
 *
 * Added because five page types had none: the metadata was opt-in per page, so the
 * pages nobody remembered were exactly the ones missing it. This check is generated
 * rather than per page for the same reason.
 */
function checkStructuredData() {
  const r = spawnSync(process.execPath, [join(ROOT, "tools", "check-structured-data.mjs")], { encoding: "utf8" });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const problems = /problems:\s*(\d+)/.exec(out)?.[1] ?? "?";
  if (r.status === 0) {
    ok("structured data", `every page carries WebSite, Organization and a page block (${problems} problems)`);
  } else {
    const first = out.split("\n").find((l) => /^ {2}\//.test(l) && !/^\s*$/.test(l))?.trim() ?? "";
    fail("structured data", `${problems} problem(s) | ${first}`.slice(0, 170));
  }
}

checkStructuredData();

/**
 * Every page must fit a phone screen.
 *
 * This is here because article pages did not, and nothing said so. A CSS Grid item
 * defaults to min-width: auto and refuses to shrink below its content; the content
 * held a <pre> of calculation steps, and a pre does not wrap. The longest line set the
 * width of main, main set the width of the page, and on a phone every article was cut
 * off at the right edge. The build, the gates and the deploy all passed.
 *
 * It drives a real browser, so it is the slowest check here; it skips with a warning
 * when no Chrome or Edge is present rather than passing silently.
 */
function checkMobile() {
  const r = spawnSync(process.execPath, [join(ROOT, "tools", "check-mobile.mjs")], { encoding: "utf8", timeout: 600000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const summary = out.split("\n").find((l) => /RESULT:/.test(l))?.trim() ?? "";
  if (/RESULT: PASS|RESULT: SKIP/.test(summary)) {
    ok("mobile layout", summary.replace(/^RESULT:\s*/, ""));
  } else {
    const first = out.split("\n").find((l) => /^\s+\d+px \//.test(l))?.trim() ?? "";
    fail("mobile layout", `${summary} | ${first}`.slice(0, 170));
  }
}

checkMobile();

/**
 * The reviewer stands in for the human read that 初心与目标.md rules out.
 *
 * It checks the classes a reader catches and no other tool does: a summary that
 * drifted from the body, an unsupported claim about the site's own process, a
 * review date that has already passed, a custom calculation with no calculation
 * section. Advisory grades are reported; only must-fix findings set the exit code.
 */
function checkReviewer() {
  const r = spawnSync(process.execPath, [join(ROOT, "tools", "reviewer-check.mjs"), "--all"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const summary = out.split("\n").find((l) => /must fix/.test(l))?.trim() ?? "";

  if (r.status === 0) {
    ok("reviewer", summary || "no must-fix findings");
  } else {
    const mustFix = out
      .split("\n")
      .filter((l) => /^\s*\[HIGH\]/.test(l) || /must fix/.test(l))
      .slice(0, 4)
      .map((l) => l.trim())
      .join(" | ");
    fail("reviewer", mustFix || "must-fix findings present");
  }
}

checkReviewer();

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
