/**
 * SITE RULES AND THE CHARTER - one source, two consumers.
 *
 * The library-level rules lived only in qa-check.mjs and CI. The writer could not see them and the reviewer
 * was not shown them, so neither could be held to a rule the site enforces. Duplicating the text in two
 * prompts would have drifted within a week; both prompts import this file instead.
 *
 * 2026-11-13, second pass: the operator removed the "name the market" rule he had approved that morning and
 * asked for something better - the writer and the reviewer should read the project's charter, not a list of
 * formatting demands. CHARTER is that, quoted from docs/初心与目标.md, and REVIEW_CHECKS is what the reviewer
 * is told to look for so the writer can be told the same thing.
 */

export const CHARTER = [
  "WHAT THIS SITE IS FOR: translating China into a foreign reader's wallet. A foreigner and China meet at only five moments - buying, coming, living, leaving, and reading policy - and this publication explains and calculates the cost, paperwork, rule and risk of each.",
  "POLICY IS THE RAW MATERIAL, NOT THE PRODUCT. Nobody pays for a policy summary. A reader pays when the arithmetic answers a decision: what a shipment actually costs, whether they can enter visa-free, what living in China really costs.",
  "THE FIRST STANDARD IS COMPLETENESS, not word count. Before publishing, answer three questions: does every question a person searching this topic has get an answer (what, when it takes effect, for whom, how much, what to do, and when this judgement would be wrong)? Is the answer the TYPE the searcher wanted (a number, a procedure, a judgement)? Can the reader now make a decision they could not make before? If any answer is no, do not publish.",
  "THE TEST FOR EVERY CHOICE: is this making the calculation more accurate, or making the writing faster? Do the first. Never trade accuracy for rate.",
  "INDEPENDENCE: no agenda, no side's mouthpiece. Read the primary document, quote it, and say what the figures cannot tell you.",
];

export const SITE_RULES = [
  "Every article names at least one identifiable primary document (a notice number, a Federal Register citation, a regulation number, or a named issuing body with the notice's date). A vague mention of 'an announcement' does not count.",

  "A number in the prose needs its five-part figure record: value, unit, period, source document, retrieval date. A draft with numbers and no records fails. A draft with no usable figure is published as an explainer (figures: [], explainer: true) and then states no number at all. One sourced figure is enough to be a cost article; five is the shape of a full one, never a floor.",

  "The body carries these sections in this order: What happened, Why now, So what, How confident, For you, The data point. Anything published from 2026-10-08 must also carry How confident, in three parts: what is settled, what is not, and how a reader should use it.",

  "The AI summary is 40-100 words. The FAQ is 3-5 questions with answers of 80-150 words each. There is at least one comparison table, at least one quoted definition in a blockquote, and at least three reader situations (audience segments).",

  "No bare URLs in the body. No hedging words (may, might, could, possibly), though 'may sign', 'may apply' and similar permissions are fine. No AI cliches.",

  "Internal links must point at pages that exist and are not drafts, and an article needs at least two of them. A link to a page that was deleted is the same defect as a broken link and it stops the publish.",

  "Never offer a compliance workaround (under-declaration, mis-classification, splitting a shipment) as a way to save money.",

  "Never give a measure a motive. Enforcement cases may be reported as happening in the same period, not as the reason for a change, unless the figures themselves carry the causal link.",

  "information_gain and category must be one of the enumerated values the build accepts (information_gain: custom-calculation, cross-source, own-data, primary-source; category: trade-policy, platforms, supply-chain, sourcing, logistics). Any other spelling fails the build.\n\n  reviewBy is six months out from the publish date. information_gain is one of primary, cross-source, analysis. target_keyword is declared. If the article converts one number into another, the arithmetic is shown on the page.",
];

/**
 * What the reviewer is explicitly told to look for. It lives here so the writer reads the same list: a
 * writer who cannot see the reviewer's checklist is being graded on a rubric nobody showed them.
 */
export const REVIEW_CHECKS = [
  "Numbers without their five-part records, or a number-free draft that does not declare itself an explainer.",
  "Arithmetic on a baseline the figures do not contain (an assumed current rate, an assumed market price).",
  "A named document, article number or process that the supplied evidence does not contain.",
  "Motive, history or a 'broader push' attributed to a measure.",
  "Non-compliance offered as a cost lever (under-declaration, mis-classification, splitting).",
  "Range endpoints paired across levels (low minus high) and presented as a comparison.",
  "A confidence section that contradicts the body.",
  "A second article about an event this publication has already covered.",
  "reviewBy that is not six months out.",
];

/**
 * THE ENUMERATIONS THE BUILD ENFORCES.
 *
 * The reviewer's prompt used to list three values for information_gain (primary, cross-source, analysis)
 * while qa-check accepted four different ones (custom-calculation, cross-source, own-data, primary-source).
 * On 2026-11-17 the reviewer filed an objection against a value the build had already accepted - a false
 * accusation generated by two copies of one list. Exported here so both sides read the same array.
 */
export const INFORMATION_GAIN_VALUES = ["custom-calculation", "cross-source", "own-data", "primary-source"];
export const CATEGORY_VALUES = ["trade-policy", "platforms", "supply-chain", "sourcing", "logistics"];
