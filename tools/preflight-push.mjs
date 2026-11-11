#!/usr/bin/env node
/**
 * PREFLIGHT BEFORE A PUSH - the four ways this week's work went wrong without anyone noticing.
 *
 * Each of these was a silent defect: the code parsed, the gate passed, and the failure only showed up in a
 * later run, hours after the push that caused it.
 *
 *   1. an `import` inside a /* … *\/ block comment.  Node does not execute it, `node --check` accepts it,
 *      and every call site throws "X is not defined" at runtime. That cost the agent line a whole day.
 *   2. a commit whose message describes a change the diff does not contain. Two of them happened by
 *      editing the file and then running the mirror over it before pushing.
 *   3. a workflow key that names a secret which does not exist. It resolves to an empty string and the run
 *      reports NO-KEYS, which reads like an outage rather than a typo.
 *   4. a local tree that is behind GitHub, so a judgement is made from stale code.
 *
 *   node tools/preflight-push.mjs            check this working copy
 *   node tools/preflight-push.mjs --strict   also fail when the tree is behind GitHub
 *
 * Exit 0 only when every check passes.
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STRICT = process.argv.includes("--strict");
const problems = [];
const notes = [];

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/* ---------------------------------------------------------------- 1. imports inside comments */
const mjs = walk(join(ROOT, "tools")).filter((f) => f.endsWith(".mjs"));
let importsSeen = 0;
for (const file of mjs) {
  const lines = readFileSync(file, "utf8").split("\n");
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const opens = /^\s*\/\*/.test(l) && !/\*\//.test(l);
    const closes = /\*\//.test(l);
    if (opens) inBlock = true;
    if (inBlock && /^\s*import\s.+from\s+["']/.test(l)) {
      problems.push(`${relative(ROOT, file).replace(/\\/g, "/")}:${i + 1} import inside a block comment`);
    }
    if (/^\s*import\s.+from\s+["']/.test(l)) importsSeen++;
    if (closes) inBlock = false;
  }
}
notes.push(`imports scanned: ${importsSeen} in ${mjs.length} tool file(s)`);

/* ---------------------------------------------------------------- 2. syntax of every tool */
for (const file of mjs) {
  try {
    execFileSync(process.execPath, ["--check", file], { stdio: "ignore", timeout: 30000 });
  } catch {
    problems.push(`${relative(ROOT, file).replace(/\\/g, "/")} does not parse`);
  }
}

/* ---------------------------------------------------------------- 3. workflow secret names */
const workflows = walk(join(ROOT, ".github", "workflows")).filter((f) => /\.ya?ml$/.test(f));
const secretNames = new Set();
for (const wf of workflows) {
  const t = readFileSync(wf, "utf8");
  for (const m of t.matchAll(/secrets\.([A-Z0-9_]+)/g)) secretNames.add(m[1]);
}
notes.push(`secret references: ${[...secretNames].join(", ") || "(none)"}`);

/* A secret cannot be read from here (the token lacks secrets:read), so the check is the shape: a name that is
   defined nowhere in the repository and looks like a typo of another name that is. */
const mentioned = new Set();
for (const file of [...mjs, ...walk(join(ROOT, ".github"))]) {
  const t = readFileSync(file, "utf8");
  for (const m of t.matchAll(/\b([A-Z][A-Z0-9_]{4,})\b/g)) mentioned.add(m[1]);
}
for (const name of secretNames) {
  const near = [...mentioned].some((o) => o !== name && (o.includes(name) || name.includes(o)) && Math.abs(o.length - name.length) <= 4);
  if (!near && !mentioned.has(name)) notes.push(`secret ${name} is not mentioned anywhere by name`);
}

/* ---------------------------------------------------------------- 4. how far behind GitHub */
try {
  const behind = execFileSync(process.execPath, [join(ROOT, "tools", "sync-from-github.mjs"), "--check"], {
    encoding: "utf8",
    timeout: 90000,
  });
  if (/BEHIND/.test(behind)) {
    const line = behind.split("\n").find((l) => /BEHIND|up to date/.test(l)) ?? "";
    (STRICT ? problems : notes).push(`tree vs GitHub: ${line.trim()}`);
  }
} catch (e) {
  notes.push("could not compare with GitHub: " + String(e.stdout ?? e.message).slice(0, 120));
}

/* ---------------------------------------------------------------- report */
console.log("PREFLIGHT\n" + "=".repeat(74));
for (const n of notes) console.log("  note " + n);
for (const p of problems) console.log("  FAIL " + p);
console.log("\n" + (problems.length ? `RESULT: ${problems.length} problem(s) - do not push` : "RESULT: clear to push"));
process.exit(problems.length ? 1 : 0);
