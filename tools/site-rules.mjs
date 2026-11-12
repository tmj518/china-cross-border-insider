/**
 * SITE RULES - one array, two consumers.
 *
 * The library-level rules lived only in qa-check.mjs and CI. The writer could not see them and the
 * reviewer was not shown them, so neither could be held to a rule the site enforces. Duplicating the text
 * in two prompts would have drifted within a week; both prompts import this list instead.
 */
export const SITE_RULES = [
  "At least one named, checkable source in every article. When the article states an amount, a rate or a share, the figure carries its unit, its period and the document it came from.",
  "An article with numbers and no five-part figure record fails the gate. Five records is the shape of a full cost article; ONE is the floor.",
  "A draft with no usable figure is published as an explainer and declares it: figures: [], explainer: true. It then states no number at all.",
  "Never offer a compliance workaround (under-declaration, mis-classification, splitting a shipment) as a way to save money.",
  "Never give a measure a motive. Enforcement cases may be reported as happening in the same period, not as the reason for a change.",
];
