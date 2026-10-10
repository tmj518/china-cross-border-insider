/**
 * Tag slugs, and the floor that decides when a tag deserves a hub page.
 *
 * These live in their own module because Astro compiles `getStaticPaths` into a separate chunk that
 * cannot see anything declared at module scope in the page file itself. Declaring `slugify` in the
 * page frontmatter - above the function, even - failed the build with "slugify is not defined",
 * while the same function imported from here works in both the path generator and the template.
 *
 * The floor is deliberately not 1. A hub holding a single article is a category by another name,
 * and the benchmark study that motivated topic pages warned they are worth little until a site has
 * enough articles to cluster. Two is where a hub starts to be a hub, and the number of pages then
 * grows on its own as the corpus does, with no list to maintain.
 */
export const MIN_CLUSTER = 2;

/** A URL-safe slug from a tag, which is written for humans and may contain anything. */
export const slugify = (tag: string): string =>
  tag
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
