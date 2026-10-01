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
    heroImage: z.string().optional(),
    heroImageAlt: z.string().optional(),
  }),
});

export const collections = { blog };
