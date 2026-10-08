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
 * Lowered on 2026-10-08 from 1500-2500. The measured median was 1,914 prose words and
 * the evidence says that is past the useful point: Backlinko's 11.8 million search
 * results put the average first-page result at 1,447 words, and Ahrefs' 900 million
 * pages show organic traffic turning negative after 2,000. The operator's judgement was
 * blunter and also supported: readers do not finish it.
 */
export const WORD_TARGET = { min: 1000, targetLow: 1200, targetHigh: 1600, max: 1600 };

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
