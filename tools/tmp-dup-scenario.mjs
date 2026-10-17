import { readFileSync, writeFileSync } from "node:fs";

/*
 * A rehearsal scenario for the failure that actually overwrote a published article.
 *
 * On 2026-10-17 at 06:12 the scheduled run took a directive for a subject that was already published, replaced
 * src/content/blog/eu-cellulose-ethers-duty-timeline.md, and left a live URL changed under a reader. The guard
 * added to the orchestrator refuses that before anything is written, and this proves the refusal happens -
 * without a scenario, the guard is code nobody has seen run.
 *
 * The scenario uses a slug the rehearsal's own collection already contains, so it exercises the same path a
 * real duplicate takes: directive present, slug present, stop.
 */
const P = "tools/rehearse.mjs";
let t = readFileSync(P, "utf8");
const crlf = t.includes("\r\n");
let n = t.replace(/\r\n/g, "\n");
const before = n.length;

if (n.includes("already-published subject")) {
  console.log("already present");
  process.exit(0);
}

/* Where the scenarios end: before the weekly ceiling case, which has nothing to do with this. */
const ANCHOR = '  { name: "weekly ceiling reached",';
if (!n.includes(ANCHOR)) {
  console.log("ANCHOR NOT FOUND");
  process.exit(1);
}

const SCENARIO = `  {
    /*
     * The subject is already published, so the run must stop before writing.
     *
     * This is the case that replaced a live article on 2026-10-17. It asserts the verdict and that the writer
     * was never called - the second matters more: a guard that stops the publish but still spends a model call
     * has not saved anything worth saving.
     */
    name: "an already-published subject is refused",
    w: ["write"],
    q: ["approve"],
    verdict: "DUPLICATE-SUBJECT",
    writerCalls: 0,
    contains: "already published",
  },
`;

n = n.replace(ANCHOR, SCENARIO + ANCHOR);
writeFileSync(P, crlf ? n.replace(/\n/g, "\r\n") : n, "utf8");
console.log("  bytes " + before + " -> " + n.length);
