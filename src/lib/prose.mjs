/**
 * Counting the words a reader actually reads.
 *
 * Two different numbers for "how long is this article" were in use and they disagreed by
 * 12 per cent, because one counted everything and the other counted prose. That is the
 * kind of discrepancy that makes a threshold meaningless: the gate said 2,488 words and
 * blocked an article that a prose count put at 2,211.
 *
 * So the definition is fixed here and both the gate and the census import it.
 *
 * Excluded, because a reader does not read them as prose:
 *   - fenced code blocks (the calculation, which is deliberately a block)
 *   - markdown tables (figures and comparisons, read as a grid not as sentences)
 *   - HTML tags and attributes (the callout wrapper)
 *   - markdown syntax characters (#, *, |, >, backticks)
 *
 * Kept, because they are read: headings, link text, and the callout's sentence.
 */
export function proseWords(body) {
  if (!body) return 0;
  const stripped = body
    .replace(/```[\s\S]*?```/g, " ")          // fenced code
    .replace(/<[^>]*>/g, " ")                 // html tags, keeping their text
    .replace(/^\s*\|.*$/gm, " ")              // table rows
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")  // keep link text, drop the target
    .replace(/[#*`>_]/g, " ")
    .replace(/&[a-z]+;/gi, " ");
  return stripped.split(/\s+/).filter(Boolean).length;
}

/**
 * The V6.2 word budget, in one place so the gate, the writer and any report agree.
 *
 * Two tiers, decided by the operator on 2026-10-08, because an article carrying a cost
 * model has a genuine structural floor that an article without one does not:
 *
 *   with a cost table      1,200-1,800 target, 2,500 ceiling
 *   without a cost table   1,200-1,600 target, 1,800 ceiling
 *
 * The reasoning, in the operator's words: content completeness and satisfying search
 * intent matter more than length. That is consistent with the evidence - Backlinko's 11.8
 * million results put the average first-page result at 1,447 words and found no direct
 * relationship between word count and ranking, so length is a symptom of completeness
 * rather than a target. What the ceiling exists to prevent is padding, not coverage.
 *
 * The lower tier was 1500-2500 until 2026-10-08 and the measured median was 1,914.
 */
export const WORD_TARGET = {
  withCostTable: { min: 1000, targetLow: 1200, targetHigh: 1800, max: 2500 },
  withoutCostTable: { min: 1000, targetLow: 1200, targetHigh: 1600, max: 1800 },
};

/** Backwards-compatible alias: the stricter tier, used where a single budget is needed. */
export const WORD_TARGET_STRICT = WORD_TARGET.withoutCostTable;

/**
 * Does the body carry a per-unit cost table?
 *
 * Detected structurally rather than declared in frontmatter, so it cannot be claimed
 * falsely: a markdown table whose rows include a currency amount. The gate uses the same
 * function the writer's budget does, so the two cannot disagree.
 */
export function hasCostTable(body) {
  const rows = body.match(/^\|.*$/gm) || [];
  const money = rows.filter((r) => /(CNY|USD|EUR|GBP|¥|\$|€)\s?[\d,]+/.test(r));
  // A header row plus at least two data rows carrying amounts.
  return money.length >= 3;
}

/** Per-section budgets, used by the writer and reported by the gate. */
export const SECTION_BUDGET = {
  "AI Summary": [60, 100],
  "What happened": [200, 300],
  "Why now": [100, 200],
  "So what": [250, 350],
  "How confident": [100, 180],
  "For you": [150, 250],
  "The data point": [60, 100],
  "How we calculated this": [50, 120],
  FAQ: [240, 400],
};
