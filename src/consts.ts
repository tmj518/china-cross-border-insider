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
  /** Kept under ~140 chars: this doubles as the meta description. */
  description:
    "Independent analysis of China trade policy and supply chains, converted into per-unit landed cost for sellers and importers worldwide.",
  // The "No tracking · No ads · Independent analysis" tagline was removed from
  // the footer on 2026-10-03. None of the three claims was false, but the line
  // read as marketing, and the substantive version of it already lives on
  // /privacy/ ("No tracking scripts. No advertising networks. No third-party
  // analytics"). The footer now carries the disclaimer and the copyright only.
  language: "en",
  /** Newsletter placeholder — swap for the real provider (Buttondown / ConvertKit) later. */
  newsletterAction: "",
};

/** spec §3 — top navigation. Labels are the short form; the silo page uses
 *  the longer `label` from CATEGORIES. */
export const NAV_LINKS = [
  { label: "Home", href: "/" },
  { label: "Trade Policy", href: "/category/trade-policy/" },
  { label: "Platforms", href: "/category/platforms/" },
  { label: "Supply Chain", href: "/category/supply-chain/" },
  { label: "Sourcing", href: "/category/sourcing/" },
  { label: "Logistics", href: "/category/logistics/" },
  { label: "About", href: "/about/" },
];

/**
 * spec §5 — one entry per content silo. `slug` is also the value used in
 * post frontmatter (`category:`), so the two can never drift apart.
 *
 * The first three serve platform sellers (US/EU). `sourcing` and `logistics`
 * were added 2026-10-01 for the emerging-market importer audience — decision
 * recorded in the v1.3 revision doc, §7.1.
 */
export const CATEGORIES = [
  {
    slug: "trade-policy",
    label: "Trade Policy",
    navLabel: "Trade Policy",
    description:
      "Tariffs, duties, anti-dumping cases and export controls — translated into landed-cost math.",
  },
  {
    slug: "platforms",
    label: "Platforms",
    navLabel: "Platforms",
    description:
      "Amazon, Temu, TikTok Shop and D2C: rule changes, fee changes and what they cost sellers.",
  },
  {
    slug: "supply-chain",
    label: "Supply Chain",
    navLabel: "Supply Chain",
    description:
      "Factories, freight, lead times and industrial data — the part of the story nobody prices in.",
  },
  {
    slug: "sourcing",
    label: "Sourcing & Suppliers",
    navLabel: "Sourcing",
    description:
      "Finding, vetting and negotiating with Chinese suppliers — factories versus trading companies, samples, MOQ, inspection and the terms that protect your deposit.",
  },
  {
    slug: "logistics",
    label: "Logistics & Customs",
    navLabel: "Logistics",
    description:
      "Freight, documentation and clearance in the destination market — what it takes to move goods from a Chinese factory to your door, and who pays for which leg.",
  },
] as const;

export type CategorySlug = (typeof CATEGORIES)[number]["slug"];

/**
 * Who a piece is written for. Surfaced in the article header so a reader can
 * tell in one second whether it applies to them, and so GSC data can later be
 * read per audience.
 */
export const AUDIENCES = [
  { value: "platform-seller", label: "Platform sellers" },
  { value: "importer", label: "Importers & buyers" },
  { value: "both", label: "Both audiences" },
] as const;

export type Audience = (typeof AUDIENCES)[number]["value"];

export function audienceLabel(value: string): string {
  return AUDIENCES.find((a) => a.value === value)?.label ?? value;
}

/** spec v1.2 §11 — pen name, role and location. */
export const AUTHOR = {
  name: "V",
  initials: "V",
  role: "China Supply Chain Analyst · Shenzhen",
  avatar: "", // e.g. "/images/author.jpg" once a real photo exists
  shortBio:
    "China Supply Chain Analyst, based in Shenzhen. Reads China's trade policy in the original and translates it into landed cost for sellers and importers worldwide.",
  longBio:
    "China Supply Chain Analyst, based in Shenzhen. Trade policy, platform rules and factory-level cost shifts, converted into landed cost for sellers in the US and EU and for importers across emerging markets. No agency, no sponsorship, no agenda.",
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

/**
 * Shown at the foot of every article and in the site footer.
 *
 * The earlier version read "Independent analysis, not financial or legal
 * advice" — seven words that miss the two risks this site actually carries. It
 * did not say we are not a customs broker, and it did not tell the reader to
 * check a figure against the document it came from. Both matter because the
 * articles are quantitative: a reader can act on a number.
 *
 * Kept short on purpose. A disclaimer nobody reads is not a disclaimer, so
 * this covers three things and stops — the basis of the content, what we are
 * not, and what to do before relying on a figure.
 */
export const DISCLAIMER =
  "Analysis of publicly available official documents. Not a customs broker, " +
  "law firm or tax adviser, and nothing here is legal, tax or investment " +
  "advice. Every figure is sourced and dated — check the original before you " +
  "act on it.";

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
