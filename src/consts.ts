/**
 * Single source of truth for site-wide values.
 * Anything the spec (项目规范_英文内容站_v1.0.md) defines about identity,
 * navigation or the author persona lives here — not scattered in components.
 */

/** Production domain (registered 2026-10-01).
 *  Everything SEO-related — canonical, sitemap, RSS, og:image — derives from
 *  this single value, so changing it here is enough. */
export const SITE_URL = "https://landedmath.com";

export const SITE = {
  url: SITE_URL,
  name: "Landed Math",
  /** Rendered as "Landed <em>Math</em>" in the logo. */
  nameHead: "Landed",
  nameTail: "Math",
  title: "Landed Math — China trade policy, converted into landed cost",
  description:
    "Independent, numbers-first analysis of China trade policy, platform rules and supply chains — converted into per-unit landed cost for Amazon, Temu, TikTok Shop and D2C sellers.",
  tagline: "No tracking · No ads · Independent analysis · Not financial or legal advice",
  language: "en",
  /** Newsletter placeholder — swap for the real provider (Buttondown / ConvertKit) later. */
  newsletterAction: "",
};

/** spec §3 — top navigation. */
export const NAV_LINKS = [
  { label: "Home", href: "/" },
  { label: "Trade Policy", href: "/category/trade-policy/" },
  { label: "Platforms", href: "/category/platforms/" },
  { label: "Supply Chain", href: "/category/supply-chain/" },
  { label: "About", href: "/about/" },
];

/**
 * spec §5 — one entry per content silo. `slug` is also the value used in
 * post frontmatter (`category:`), so the two can never drift apart.
 */
export const CATEGORIES = [
  {
    slug: "trade-policy",
    label: "Trade Policy",
    description:
      "Tariffs, duties, anti-dumping cases and export controls — translated into landed-cost math.",
  },
  {
    slug: "platforms",
    label: "Platforms",
    description:
      "Amazon, Temu, TikTok Shop and D2C: rule changes, fee changes and what they cost sellers.",
  },
  {
    slug: "supply-chain",
    label: "Supply Chain",
    description:
      "Factories, freight, lead times and industrial data — the part of the story nobody prices in.",
  },
] as const;

export type CategorySlug = (typeof CATEGORIES)[number]["slug"];

/** spec v1.2 §11 — pen name, role and location. */
export const AUTHOR = {
  name: "V",
  initials: "V",
  role: "China Supply Chain Analyst · Shenzhen",
  avatar: "", // e.g. "/images/author.jpg" once a real photo exists
  shortBio:
    "China Supply Chain Analyst. Based in Shenzhen, tracking trade policy, platform rules and factory-level cost shifts for global sellers.",
  longBio:
    "China Supply Chain Analyst, based in Shenzhen. Tracking trade policy, platform rules and factory-level cost shifts for sellers in the US and EU. No agency, no sponsorship, no agenda.",
  /** TODO(user): enable Cloudflare Email Routing so this address actually delivers. */
  email: "hello@landedmath.com",
};

/** spec §3 — footer. */
export const FOOTER_LINKS = [
  { label: "Privacy Policy", href: "/privacy/" },
  { label: "About", href: "/about/" },
  { label: "Contact", href: "/contact/" },
  { label: "RSS Feed", href: "/rss.xml" },
];

export const DISCLAIMER = "Independent analysis, not financial or legal advice";

export function categoryLabel(slug: string): string {
  return CATEGORIES.find((c) => c.slug === slug)?.label ?? slug;
}

export function categoryHref(slug: string): string {
  return `/category/${slug}/`;
}

/** 2026-09-29 -> "Sep 29, 2026" (matches the prototype's date style). */
export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}
