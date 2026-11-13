/**
 * SITE RULES - one array, two consumers.
 *
 * The library-level rules lived only in qa-check.mjs and CI. The writer could not see them and the
 * reviewer was not shown them, so neither could be held to a rule the site enforces. Duplicating the text
 * in two prompts would have drifted within a week; both prompts import this list instead.
 *
 * Every line here is checkable, and 2026-11-13 added the numeric ones: the writer was being told to "follow
 * the house style" while the gate wanted 40-100 words of summary and 3-5 FAQs of 80-150 words. A standard
 * nobody can read is a standard nobody can meet. The long form is docs/标准-闸门清单.md.
 */
export const SITE_RULES = [
  "Every article names at least one identifiable primary document (a notice number, a Federal Register citation, a regulation number). A vague mention of 'an announcement' does not count.",

  "A number in the prose needs its five-part figure record: value, unit, period, source document, retrieval date. A draft with numbers and no records fails. A draft with no usable figure is published as an explainer (figures: [], explainer: true) and then states no number at all - and one sourced figure is enough to be a cost article, never five.",

  "The body carries these sections in this order: What happened, Why now, So what, How confident, For you, The data point. Anything published from 2026-10-08 must also carry How confident, in three parts: what is settled, what is not, and how a reader should use it.",

  "The AI summary is 40-100 words. The FAQ is 3-5 questions with answers of 80-150 words each. There is at least one comparison table, at least one quoted definition in a blockquote, and at least three reader situations (audience segments).",

  "No bare URLs in the body. No hedging words (may, might, could, possibly) - though 'may sign', 'may apply' and similar permissions are fine. No AI cliches.",

  "Internal links must point at pages that exist and are not drafts, and an article needs at least two of them. A link to a page that was deleted is the same defect as a broken link and it stops the publish.",

  "Never offer a compliance workaround (under-declaration, mis-classification, splitting a shipment) as a way to save money.",

  "Never give a measure a motive. Enforcement cases may be reported as happening in the same period, not as the reason for a change, unless the figures themselves carry the causal link.",

  "reviewBy is six months out from the publish date. information_gain is one of primary, cross-source, analysis. target_keyword is declared. If the article converts one number into another, the arithmetic is shown on the page.",
];
