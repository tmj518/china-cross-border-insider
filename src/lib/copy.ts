/**
 * Landing copy, in one place.
 *
 * The project specification carries a verbatim English landing block, and the benchmark it
 * was modelled on keeps its copy in one file rather than scattered through components. Two
 * reasons that matters here beyond tidiness: the same sentence appears in the hero, the
 * newsletter widget and the archive pages, and a claim about the product has to be changed
 * everywhere at once or it stops being true in one place.
 *
 * Two deliberate departures from the specification's wording, both recorded rather than
 * silently applied.
 *
 * The headline. The spec's draft is "Understand China's trade policy in 5 minutes", copied
 * from the benchmark whose product summarises other people's reporting. This one does
 * arithmetic on primary documents and asks the reader for commercial inputs, so a
 * five-minute promise is one the product would not keep. What it does promise is that the
 * number is the point and the working is shown, which is both true and more specific.
 *
 * The cadence. The spec's social-proof line mentions a weekly brief. There is no email
 * sending yet, so the copy names the cadence that exists - when a tracked change moves a
 * per-unit cost - rather than the one that is planned.
 */
import { SITE } from "../consts";

/** The offer, stated once. Every component that asks for a subscription uses this. */
export const PROMISE =
  "One email when a tracked change actually moves your per-unit cost. No daily filler.";

/** What the site is, in one sentence, for the hero subtitle and the meta description. */
export const SUBTITLE =
  "Every figure sourced and dated. What a published change costs per unit, per container, per tonne.";

/** Who it is for. Named so the right reader recognises themselves. */
export const AUDIENCE = "For importers, brands and sourcing teams.";

/**
 * The headline.
 *
 * It was "China's trade rules, converted into your landed cost" - 54 characters that wrapped onto two
 * lines at 42px and, with every other block stacked under it, pushed the hero past a full screen before
 * a visitor had seen anything. The phrasing was also a promise about the product rather than a move the
 * reader can make.
 *
 * "Turn China's rules into your landed cost" is 41 characters, sets on one line, keeps the phrase the
 * site is about, and starts with a verb. The specifics the old line carried - per unit, per container,
 * per tonne - moved to the subtitle, where they read as detail instead of as more headline.
 */
export const HEADLINE = "Turn China's rules into your landed cost";

/**
 * What the reader gets.
 *
 * No longer rendered in the hero. Three bullets under a subtitle that already said the same thing were
 * repetition costing ninety pixels of the first screen; the subtitle carries the claim once now.
 */
export const WHAT_YOU_GET = [
  "Every analysis, in full",
  "Every figure, with its source and date",
  "Every calculation, shown so you can check it",
];

/**
 * The call to action.
 *
 * One, and only one, on the first screen - the benchmark keeps a single button and the
 * specification repeats the rule twice. "Get the change alerts" names what arrives instead of
 * asking for a favour, which is the difference between a subscription and a donation.
 */
export const CTA = "Get the change alerts";

/** The secondary line under the button, which sets expectations about frequency. */
export const CTA_NOTE = "Free. One email when something actually changes. Unsubscribe in one click.";

/** Sentence used where a page needs to say what the site refuses to do. */
export const INDEPENDENCE = `Independent analysis. No ads, no sponsors, no tracking. Published by ${SITE.name}.`;
