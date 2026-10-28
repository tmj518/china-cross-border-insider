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
  if (score >= 0.9) {
    return { duplicate: true, reason: `body similarity ${score.toFixed(3)}`, score };
  }
  return { duplicate: false, reason: `not a duplicate (similarity ${score.toFixed(3)})`, score };
}
