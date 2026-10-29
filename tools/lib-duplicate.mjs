/**
 * Is this draft the same article that is already published?
 *
 * ## Why this exists
 *
 * On 2026-10-28 a page appeared twice: `eu-goes-provisional-safeguard-trq-price-threshold-2026.md` and
 * the same file with `-2026-10-28` appended. Identical title, identical description, identical body -
 * two URLs, one article. The meta gate caught it and CI went red, which is the gate doing its job. The
 * writer should have caught it first.
 *
 * The date suffix was added for a reason: on 2026-10-20 the agent route produced nothing for a day, and
 * a near-duplicate under a dated slug was judged better than an empty day. That judgement was right about
 * the URL and wrong about the content. A date suffix changes where an article lives. It does not create a
 * second article, and publishing the same words twice is not "producing something".
 *
 * ## The rule
 *
 *   identical title                              -> duplicate
 *   first 500 characters of body identical       -> duplicate
 *   body similarity >= 0.9                       -> duplicate
 *
 * Anything below that is a rewrite of the same subject, which is a different verdict the caller already
 * has (`DUPLICATE-SUBJECT`), and not this module's business.
 */

/** The frontmatter title, or an empty string. */
export function titleOf(src) {
  return /^title:\s*"?(.*?)"?\s*$/m.exec(/^---\r?\n([\s\S]*?)\r?\n---/.exec(src)?.[1] ?? "")?.[1] ?? "";
}

/** Everything after the frontmatter, whitespace collapsed so the comparison ignores formatting. */
export function bodyOf(src) {
  const body = src.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  return body.replace(/\s+/g, " ").trim();
}

/**
 * Similarity on character bigrams in [0, 1].
 *
 * Chosen over edit distance because articles are long and a single changed sentence should barely move
 * the number, while a genuinely different article should fall well below the threshold. Bigrams are
 * cheap, have no dependencies, and behave predictably on prose.
 */
export function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = (s) => {
    const out = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      out.set(g, (out.get(g) ?? 0) + 1);
    }
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  let shared = 0;
  for (const [g, n] of ga) shared += Math.min(n, gb.get(g) ?? 0);
  const total = Math.max(a.length - 1, 1) + Math.max(b.length - 1, 1);
  return (2 * shared) / total;
}

/** The first N characters of the body, for the "same opening" test. */
export function opening(src, n = 500) {
  return bodyOf(src).slice(0, n);
}

/**
 * @returns {{duplicate: boolean, reason: string, score?: number}}
 */

/**
 * THE TITLE IS NOT THE EVENT.
 *
 * On 2026-10-29 two articles about the same Brazilian beef safeguard went live on the same day: the script
 * line at 12:47 under china-brazil-beef-safeguard-55-percent-trigger-2026, the agent at 17:2x under
 * ...-trigger-october-2026. The titles were worded differently, so the identical-title test passed, the
 * opening was different, and the body similarity sat below the threshold. One event, two URLs.
 *
 * A title is what the writer chose; the event is what the piece is about. Two signals that do not depend on
 * wording:
 *
 *   the slug fingerprint   the first six hyphen segments, which both lines derive from the subject
 *   the figure fingerprint three shared core numbers that also carry the same date
 *
 * Either one matching is a duplicate. Both are cheap, neither can be paraphrased away.
 */
/**
 * THE SUBJECT LIVES IN THE FILENAME, NOT IN THE TITLE.
 *
 * Two pieces about the same safeguard were filed as china-brazil-beef-safeguard-55-percent-trigger-2026 and
 * ...-trigger-october-2026. The first six segments are identical, which is the subject; the titles were
 * worded differently, which is why the title test missed it.
 */
export function slugSubject(slug, segments = 6) {
  return String(slug).toLowerCase().split("-").filter(Boolean).slice(0, segments).join("-");
}

export function slugFingerprint(src, segments = 6) {
  const slug = /^slug:\s*"?(.*?)"?\s*$/m.exec(src)?.[1] ?? "";
  const fromTitle = (titleOf(src) ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const base = (slug || fromTitle).toLowerCase();
  return base.split("-").filter(Boolean).slice(0, segments).join("-");
}

/** Numbers with a unit or a percent sign, and the dates, in one comparable bag. */
export function figureFingerprint(src) {
  const body = bodyOf(src);
  const numbers = new Set();
  for (const m of body.matchAll(/(\d{1,4}(?:\.\d+)?)\s*(?:%|percent|yuan|usd|dollars?|days?|months?|tonnes?|kg)/gi)) {
    numbers.add(m[1]);
  }
  const dates = new Set([...body.matchAll(/\b(20\d\d-\d\d-\d\d|\d{1,2}\s+(?:january|february|march|april|may|june|july|august|september|october|november|december))/gi)].map((m) => m[0].toLowerCase()));
  return { numbers, dates };
}

function shared(a, b) {
  const out = [];
  for (const x of a) if (b.has(x)) out.push(x);
  return out;
}

export function looksDuplicate(draftSrc, publishedSrc) {
  const draftTitle = titleOf(draftSrc);
  const publishedTitle = titleOf(publishedSrc);
  if (draftTitle && draftTitle === publishedTitle) {
    return { duplicate: true, reason: `identical title: ${draftTitle.slice(0, 80)}` };
  }

  const draftOpening = opening(draftSrc);
  const publishedOpening = opening(publishedSrc);
  if (draftOpening.length >= 200 && draftOpening === publishedOpening) {
    return { duplicate: true, reason: "first 500 characters of the body are identical" };
  }

  const score = similarity(bodyOf(draftSrc), bodyOf(publishedSrc));

  /* The event, not the wording. Six slug segments is the subject; anything shorter is a different article. */
  const draftSlug = slugFingerprint(draftSrc);
  const publishedSlug = slugFingerprint(publishedSrc);
  if (draftSlug && publishedSlug && draftSlug === publishedSlug) {
    return { duplicate: true, reason: `same subject by slug: ${draftSlug}`, score };
  }

  /* Three shared figures that also share a date is the same event reported twice. */
  const a = figureFingerprint(draftSrc);
  const b = figureFingerprint(publishedSrc);
  const sharedNumbers = shared(a.numbers, b.numbers);
  const sharedDates = shared(a.dates, b.dates);
  if (sharedNumbers.length >= 3 && sharedDates.length >= 1) {
    return {
      duplicate: true,
      reason: `same event by figures: ${sharedNumbers.slice(0, 3).join(", ")} on ${sharedDates[0]}`,
      score,
    };
  }

  if (score >= 0.9) {
    return { duplicate: true, reason: `body similarity ${score.toFixed(3)}`, score };
  }
  return { duplicate: false, reason: `not a duplicate (similarity ${score.toFixed(3)})`, score };
}
