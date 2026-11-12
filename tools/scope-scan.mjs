/**
 * SCOPE SCAN - catch the error that passed node --check and killed a publishing day.
 *
 * On 2026-11-13 siteRules() was added inside pitfallRules(). The file parsed, CI was green, and the 07:20 slot
 * died with "siteRules is not defined": a nested declaration is legal syntax and an invisible symbol at the
 * same time. The rule this enforces: a function declared at brace depth N may only be called at depth >= N.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export function nestedScopeScan() {
  const files = readdirSync(join(ROOT, "tools")).filter((f) => f.endsWith(".mjs"));
  const bad = [];
  for (const f of files) {
    const lines = readFileSync(join(ROOT, "tools", f), "utf8").split("\n");
    const depthAt = [];
    let depth = 0;
    for (let i = 0; i < lines.length; i++) {
      depthAt[i] = depth;
      for (const ch of lines[i]) {
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
    }
    const decls = new Map();
    for (let i = 0; i < lines.length; i++) {
      const m = /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(lines[i]);
      if (m) decls.set(m[1], { line: i + 1, depth: depthAt[i] });
    }
    for (const [name, d] of decls) {
      if (d.depth === 0) continue;
      const needle = "${" + name + "()}";
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].includes(needle)) continue;
        if (depthAt[i] < d.depth) {
          bad.push(f + ": " + name + "() is declared at depth " + d.depth + " (line " + d.line + ") but called at depth " + depthAt[i] + " (line " + (i + 1) + ")");
          break;
        }
      }
    }
  }
  return bad;
}
