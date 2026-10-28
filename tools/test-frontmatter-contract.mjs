#!/usr/bin/env node
/**
 * Self-test for the frontmatter contract scanner.
 *
 *   node tools/test-frontmatter-contract.mjs
 *
 * The scanner exists because a duplicate YAML key passed every existing check and took the whole site down
 * at build time, while check_draft had already told the model the draft was fine. A scanner that is wrong
 * in the other direction is just as bad - refusing a valid draft would deadlock the writer - so both
 * directions are tested here.
 *
 * Three cases, each asserted on the exact text of the Fix, not on a count:
 *
 *   valid            -> zero fixes, and the writer is not told to change anything
 *   duplicate title  -> one fix naming the line, and the line number must be the real one
 *   figures no source-> one fix naming the entry, pointing at the entry not the field
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const src = readFileSync(resolve(ROOT, "tools", "agent-run.mjs"), "utf8");

/* The scanner is a plain function inside agent-run.mjs; lift it out so the test runs it, not a copy. */
const start = src.indexOf("function frontmatterFixes(");
if (start < 0) {
  console.error("cannot find frontmatterFixes in tools/agent-run.mjs");
  process.exit(2);
}
const end = src.indexOf("\n}", start) + 2;
const frontmatterFixes = new Function(src.slice(start, end) + "; return frontmatterFixes;")();

const cases = [
  {
    name: "valid draft",
    draft: `---
publishDate: "2026-10-28"
title: "A valid draft"
description: "One sentence."
category: "trade-policy"
audience: "importer"
information_gain: "primary-source"
figures:
  - value: "55"
    unit: "%"
    period: "from 18 September 2026"
    source: "Commission Regulation 2026/1"
    retrieved: "2026-10-28"
---
body
`,
    expect: 0,
    assert: (fixes) => (fixes.length === 0 ? null : `expected no fixes, got: ${fixes.join(" | ")}`),
  },
  {
    name: "duplicate title",
    draft: `---
publishDate: "2026-10-28"
title: "First"
description: "One sentence."
category: "trade-policy"
audience: "importer"
information_gain: "primary-source"
title: "Second"
figures: []
---
body
`,
    expect: 1,
    assert: (fixes) => {
      const f = fixes.find((x) => x.includes("'title' is duplicated"));
      if (!f) return `no duplicate-title fix in: ${fixes.join(" | ")}`;
      if (!f.includes("line 8")) return `fix does not name the real line (8): ${f}`;
      return null;
    },
  },
  {
    name: "figures entry without source",
    draft: `---
publishDate: "2026-10-28"
title: "Figures without a source"
description: "One sentence."
category: "trade-policy"
audience: "importer"
information_gain: "primary-source"
figures:
  - value: "55"
    unit: "%"
    period: "from 18 September 2026"
    retrieved: "2026-10-28"
---
body
`,
    expect: 1,
    assert: (fixes) => {
      const f = fixes.find((x) => x.includes("has no 'source'"));
      if (!f) return `no missing-source fix in: ${fixes.join(" | ")}`;
      if (!f.includes("line 9")) return `fix does not point at the entry line (9): ${f}`;
      return null;
    },
  },
];

let failed = 0;
console.log("FRONTMATTER CONTRACT SELF-TEST");
console.log("=".repeat(70));
for (const c of cases) {
  const fixes = frontmatterFixes(c.draft);
  const problem = c.assert(fixes);
  if (problem) {
    failed++;
    console.log(`  FAIL  ${c.name}`);
    console.log(`        ${problem}`);
  } else {
    console.log(`  PASS  ${c.name}  (${fixes.length} fix(es))`);
    for (const f of fixes) console.log(`        ${f}`);
  }
}
if (failed) {
  console.error(`\n  ${failed} case(s) failed`);
  process.exit(1);
}
console.log("\n  RESULT: a valid draft is left alone, and a broken one is told which line to change");
