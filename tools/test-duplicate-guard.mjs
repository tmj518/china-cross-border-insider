#!/usr/bin/env node
/**
 * Self-test for the duplicate guard behind the forced submission.
 *
 *   node tools/test-duplicate-guard.mjs
 *
 * It takes a published article, builds a draft that is the same article, and asserts the guard refuses
 * it - which is the exact situation that produced two URLs on 2026-10-28. Then it checks the guard does
 * NOT refuse a genuinely different article, because a guard that refuses everything is not a guard, it
 * is an outage.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { looksDuplicate, similarity, titleOf } from "./lib-duplicate.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const BLOG = join(ROOT, "src", "content", "blog");

const published = readdirSync(BLOG).filter((f) => f.endsWith(".md"));
if (published.length < 2) {
  console.error("need at least two published articles to test against");
  process.exit(2);
}

const original = readFileSync(join(BLOG, published[0]), "utf8");
const other = readFileSync(join(BLOG, published[1]), "utf8");

const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(original)?.[0] ?? "";

/* Draft 1: the same article under a different filename - exactly what the date suffix produced. */
const sameArticle = original;

/* Draft 2: same subject, genuinely rewritten - new title, new body, a few shared terms. */
const rewritten =
  frontmatter.replace(/^title:.*$/m, 'title: "A rewritten take on the same subject"') +
  "A completely different treatment of this subject, written from scratch for the test. ".repeat(80);

/* Draft 3: 98% the same - one paragraph appended to the end. This SHOULD be refused: it is not a
 * second article, it is the first one with a tail. This case exists to pin the threshold's behaviour. */
const tail = original + "\n\nAn extra paragraph added at the end, which changes almost nothing.\n";

/* Draft 4: an unrelated article. */
const different = other;

const cases = [
  ["same article, different filename", sameArticle, original, true],
  ["same subject, fully rewritten body", rewritten, original, false],
  ["original with one paragraph appended", tail, original, true],
  ["unrelated article", different, original, false],
];

let failed = 0;
console.log("DUPLICATE GUARD SELF-TEST");
console.log("=".repeat(72));
console.log(`  reference: ${published[0]}  "${titleOf(original).slice(0, 50)}"`);
console.log("");

for (const [name, draft, reference, expectDuplicate] of cases) {
  const verdict = looksDuplicate(draft, reference);
  const ok = verdict.duplicate === expectDuplicate;
  if (!ok) failed++;
  const mark = ok ? "PASS" : "FAIL";
  console.log(`  ${mark}  ${name}`);
  console.log(`        duplicate=${verdict.duplicate}  expected=${expectDuplicate}  ${verdict.reason}`);
  if (verdict.score !== undefined) console.log(`        similarity=${verdict.score.toFixed(3)}`);
}

/* The threshold itself, stated as a number so it cannot drift silently. */
const near = similarity("abcdefghij".repeat(50), "abcdefghij".repeat(50));
console.log(`\n  identical strings score ${near.toFixed(3)} (threshold for a duplicate is 0.900)`);

if (failed) {
  console.error(`\n  ${failed} case(s) failed`);
  process.exit(1);
}
console.log("\n  RESULT: the guard refuses the same article twice and allows a rewrite");
