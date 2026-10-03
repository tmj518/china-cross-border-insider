import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
// `z` from "astro:content" is deprecated and goes away in Astro 8.
import { z } from "astro/zod";

import { AUDIENCES, CATEGORIES, type Audience, type CategorySlug } from "./consts";

/**
 * The blog collection.
 *
 * Frontmatter mirrors the fields spec §4.1 / §5.1 require of every article:
 *  - `sources`   -> 信源清单, rendered as a footnote so no URLs sit in the body
 *  - `category`  -> the silo, also drives /category/<slug>/ pages
 *  - `priority`  -> the P0/P1/P2 triage used by the homepage hero
 *  - `featured`  -> which post gets the hero slot
 */
const categorySlugs = CATEGORIES.map((c) => c.slug) as [
  CategorySlug,
  ...CategorySlug[],
];

const audienceValues = AUDIENCES.map((a) => a.value) as [Audience, ...Audience[]];

export const blog = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/blog" }),
  schema: z.object({
    title: z.string().max(120),
    /**
     * The positioning line, not a summary. Spec decision 1 (2026-10-03): the
     * title carries the hook that earns the click, and `subtitle` carries the
     * target keyword that earns the ranking. It renders visibly under the
     * <h1> and it goes into the <title> tag, so the keyword reaches the SERP.
     *
     * Keep it to one sentence, with the target keyword in it, and without the
     * hook's rhetoric. It is not the same thing as `description`, which is the
     * longer card excerpt and the meta description.
     */
    subtitle: z.string().max(160).optional(),
    /** Doubles as <meta name="description"> and the card excerpt. */
    description: z.string().max(300),
    publishDate: z.coerce.date(),
    updatedDate: z.coerce.date().optional(),
    category: z.enum(categorySlugs),
    /** Who the piece is for; surfaced in the article header. */
    audience: z.enum(audienceValues).default("both"),
    tags: z.array(z.string()).default([]),
    /** P0 = industry-level, P1 = sector-level, P2 = watchlist. */
    priority: z.enum(["P0", "P1", "P2"]).optional(),
    featured: z.boolean().default(false),
    draft: z.boolean().default(false),
    /** Official sources by name only — spec §4.3 forbids URLs in the body. */
    sources: z.array(z.string()).default([]),

    // ---- v1.3 fields: the machine-checkable half of the QA gate ----------
    /** The long-tail query this piece is written to win. */
    target_keyword: z.string().optional(),
    search_intent: z
      .enum(["informational", "transactional", "comparison"])
      .optional(),
    /**
     * What this piece has that the top 3 results do not. If none of these can
     * be claimed honestly, the piece does not get published.
     */
    information_gain: z
      .enum(["custom-calculation", "cross-source", "own-data", "primary-source"])
      .optional(),
    /**
     * Every figure in the body, with the five parts the spec requires:
     * value + unit + period + named source + retrieval date. A number that
     * cannot fill all five does not go in the article.
     */
    figures: z
      .array(
        z.object({
          value: z.string(),
          unit: z.string().default(""),
          period: z.string(),
          source: z.string(),
          retrieved: z.string(),
        }),
      )
      .default([]),

    heroImage: z.string().optional(),
    heroImageAlt: z.string().optional(),

    // ---- Video (spec v1.3 §15 / roadmap §5.2) ----------------------------
    /**
     * YouTube video id only — never the full URL, and never the file. Spec
     * v1.2 §6 keeps video out of the repository, and an id is enough for the
     * embed and for the VideoObject structured data.
     */
    youtube_id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{11}$/, "must be an 11-character YouTube video id")
      .optional(),
    /** Shown above the player; falls back to the article title. */
    videoTitle: z.string().optional(),
    /** ISO 8601 duration, e.g. PT4M13S. Feeds VideoObject.uploadDate/duration. */
    videoDuration: z.string().optional(),
  }),
});

export const collections = { blog };
