import { readFileSync, writeFileSync } from "node:fs";

/*
 * truncate() cut by characters where its budget is display columns, and the sentence with no spaces is
 * exactly the case that reaches the fallback.
 *
 * The loop walks words and stops when the next one would not fit. A Chinese sentence has no spaces, so the
 * first "word" is the whole string, it does not fit, the loop leaves `out` empty, and the fallback ran:
 *
 *   out = str.slice(0, Math.max(1, limit - 1))
 *
 * That is limit-1 characters. Every CJK character is two columns, so a 38-column budget produced a
 * 76-column string - and one instrument title came out at 82 columns against a limit of 60. The fallback was
 * written for Latin text, where characters and columns are the same thing.
 *
 * The fix accumulates characters while the display width allows. It is the same rule the word loop uses,
 * applied at the character level, which is what a language without spaces requires.
 */
const P = "src/lib/meta.ts";
let t = readFileSync(P, "utf8");
const crlf = t.includes("\r\n");
let n = t.replace(/\r\n/g, "\n");
const before = n.length;

const OLD = `  if (!out) out = str.slice(0, Math.max(1, limit - 1));
  return out.replace(/[,;:.\\-–—\\s]+$/, "") + "…";`;
if (!n.includes(OLD)) {
  console.log("ANCHOR NOT FOUND");
  process.exit(1);
}

const NEW = `  /*
   * No word fitted: cut by display width, one character at a time.
   *
   * This was \`str.slice(0, limit - 1)\`, which counts characters - correct for Latin text, wrong by a factor
   * of two for a string of Chinese, where a 38-column budget produced a 76-column title. A single long
   * unbroken token reaches here, and a Chinese sentence is one token because it has no spaces.
   */
  if (!out) {
    let w = 0;
    for (const ch of str) {
      const cw = charWidth(ch.codePointAt(0));
      if (w + cw > limit) break;
      out += ch;
      w += cw;
    }
    if (!out) out = [...str][0] ?? "";
  }
  return out.replace(/[,;:.\\-–—\\s]+$/, "") + "…";`;

n = n.replace(OLD, NEW);
writeFileSync(P, crlf ? n.replace(/\n/g, "\r\n") : n, "utf8");
console.log("  bytes " + before + " -> " + n.length);
console.log("  ✓ the fallback counts display columns");
