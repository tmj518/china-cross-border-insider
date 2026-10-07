/**
 * Information-gain gate 鈥?spec v1.3 搂9.2 (R3), automated.
 *
 * The rule: before publishing, pull the top results for the piece's target
 * keyword and prove the piece contains something they do not. If the claim in
 * `information_gain` cannot be demonstrated, the piece is not published.
 *
 * Architecture note 鈥?why the SERP source is pluggable:
 *   Scraping a search engine from this machine is unreliable. Bing truncates
 *   the query and serves dictionary pages, and Google, DuckDuckGo and
 *   Startpage are unreachable. The valuable part of this gate is the
 *   comparison logic, not the scraping, so the SERP comes from a provider:
 *
 *     --serp=bing            best-effort Bing HTML scrape (default)
 *     --serp=file:<path>     a JSON snapshot [{url,title,snippet}] supplied
 *                            by an agent search tool or a SERP API
 *
 *   In the production pipeline the writing/QA agent has a search tool, so it
 *   supplies the snapshot. A paid SERP API drops in the same way.
 *
 * Honesty rules baked in 鈥?the gate never invents a pass:
 *   - No SERP, or a SERP that is not topically relevant 鈫?INCONCLUSIVE.
 *   - Fewer than two competitor pages load 鈫?INCONCLUSIVE.
 *   - `own-data` cannot be verified against a SERP 鈫?INCONCLUSIVE by design.
 *
 * Run:  node tools/serp-check.mjs <file.md>... [--serp=file:serp.json]
 *       node tools/serp-check.mjs --all --serp=bing
 *
 * Exit code is non-zero on UNSUPPORTED.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const TOP_N = 3;

/** Hosts that are never a competitor for a trade-policy query. */
const JUNK_HOSTS = [
  "iciba.com", "cambridge.org", "dictionary.com", "merriam-webster.com",
  "baike.baidu.com", "3dmgame.com", "soft.china.com", "zhihu.com/search",
  "translate.google", "youdao.com", "bing.com", "microsoft.com",
];

/**
 * Official publishers. For a policy query the top result is frequently the
 * primary document itself 鈥?a Federal Register notice, a customs
 * announcement, a ministry page. That is the input this site works from, not
 * competition, so it is reported separately and kept out of the denominator
 * when asking "do competitors already deliver this?".
 */
const OFFICIAL_SUFFIXES = [
  ".gov", ".gov.cn", ".gov.uk", ".gov.my", ".gov.sg", ".gov.au",
  "federalregister.gov", "govinfo.gov", "europa.eu", "wto.org", "asean.org",
  "customs.gov.cn", "mofcom.gov.cn", "ustr.gov", "cbp.gov", "stats.gov.cn",
  "rcepsec.org",
  // State publication channels: an announcement carried by Xinhua or the
  // State Council Information Office is the primary document's own outlet,
  // not a competitor's take on it.
  "news.cn", "xinhuanet.com", "china.org.cn", "chinadaily.com.cn",
];

const isOfficial = (url) => {
  const h = hostOf(url);
  return OFFICIAL_SUFFIXES.some((s) => h.endsWith(s));
};

const STOPWORDS = new Set([
  "the", "a", "an", "of", "for", "to", "in", "on", "and", "or", "is", "are",
  "what", "how", "why", "when", "do", "does", "with", "from", "by", "at",
]);

// ---------------------------------------------------------------- utilities

const stripTags = (s) =>
  s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();

const words = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);

function unwrapBingUrl(href) {
  if (!href.includes("bing.com/ck/a")) return href;
  const m = /[?&]u=a1([^&]+)/.exec(href);
  if (!m) return href;
  let b64 = decodeURIComponent(m[1]).replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  try {
    const url = Buffer.from(b64, "base64").toString("utf8");
    return /^https?:\/\//.test(url) ? url : href;
  } catch {
    return href;
  }
}

async function get(url, attempts = 3) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
        redirect: "follow",
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.text();
    } catch (e) {
      last = e;
      if (i < attempts) await new Promise((r) => setTimeout(r, 1200 * i));
    }
  }
  throw last;
}

export function parseBingSerp(html) {
  const chunks = html.split(/class="b_algo"/).slice(1);
  const out = [];
  for (const chunk of chunks) {
    const block = chunk.slice(0, 4000);
    const a = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!a) continue;
    const url = unwrapBingUrl(a[1]);
    if (!/^https?:\/\//.test(url) || url.includes("bing.com")) continue;
    const p = /<p[^>]*>([\s\S]*?)<\/p>/.exec(block);
    out.push({ url, title: stripTags(a[2]), snippet: p ? stripTags(p[1]) : "" });
    if (out.length >= 20) break;
  }
  return out;
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

/**
 * Document identifiers that count as citing a primary source 鈥?recognisable
 * numbering schemes rather than the word "announcement", so a loose mention
 * does not satisfy the rule.
 */
const PRIMARY_DOC_PATTERN = new RegExp(
  [
    "\\b\\d{1,3}\\s?FR\\s?\\d{3,6}\\b",
    "\\bHTSUS\\s?9903\\b",
    "\\bAnnouncement\\s+No\\.?\\s?\\d+",
    "\\b鍏憡\\s?\\d+\\s?鍙?,
    "銆擻\d{4}銆昞\s?\\d+\\s?鍙?,
    "\\b(?:Periodical|Circular|Order|Decision)\\s+No\\.?\\s?\\(?\\d+",
    "\\bRegulation\\s+\\(EU\\)\\s+\\d{4}/\\d+",
    "\\bCELEX\\b",
    "\\bOJ\\s?L\\s?\\d",
  ].join("|"),
  "i",
);

/**
 * A SERP is only usable if its results are about the query. Token overlap
 * between the keyword and each result is the cheapest reliable test, and it
 * catches the failure mode that produced a false pass in testing: a
 * dictionary SERP for the first word of the keyword.
 */
export function serpRelevance(keyword, results) {
  const tokens = keyword
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
  if (!tokens.length) return { ok: false, score: 0, detail: "keyword has no usable tokens" };

  const scores = results.map((r) => {
    const hay = (r.title + " " + (r.snippet ?? "")).toLowerCase();
    const hits = tokens.filter((t) => hay.includes(t)).length;
    return hits / tokens.length;
  });
  const relevant = scores.filter((s) => s >= 0.4).length;
  return {
    ok: relevant >= 2,
    score: scores.length ? Math.max(...scores) : 0,
    detail: `${relevant}/${results.length} results share >=40% of the keyword tokens`,
  };
}

/**
 * Money and per-unit detection. This site covers EU, UK and Chinese measures,
 * so a cost table is not always denominated in dollars and a unit is not
 * always a container. Three forms are recognised because all three appear in
 * this library: a currency symbol before a figure ("$48.00"), an ISO code
 * before a figure ("EUR 75.36"), and a code inside a unit header
 * ("EUR/t at Q1 2026"). The last one is what a euro-denominated cost table
 * puts in its column heading, and missing it failed an article whose whole
 * asset was that table.
 */
const MONEY = /([$鈧Ｂ\s?\d|\b(?:EUR|USD|GBP|CNY|RMB|yuan)\b)/i;
const PER_UNIT =
  /(per unit|per item|per container|per-container|per 40|per teu|per kg|per kilogram|per watt|per tonne|per ton|per declaration line)/i;

export function pageSignals(html) {
  const text = stripTags(html);
  const lower = text.toLowerCase();
  const tableBlocks = [...html.matchAll(/<table[\s\S]{0,6000}?<\/table>/gi)].map((m) =>
    stripTags(m[0]),
  );
  const tableText = tableBlocks.join(" ");
  const costWords =
    /(landed cost|duty rate|per unit|per item|per container|per-container|tariff rate|customs duty)/.test(
      lower,
    );

  return {
    words: words(text),
    tables: tableBlocks.length,
    costTable: tableBlocks.length > 0 && MONEY.test(tableText) && costWords,
    perUnitMath: PER_UNIT.test(lower),
    primaryDocId: PRIMARY_DOC_PATTERN.test(text),
    figureDensity: (
      text.match(/\b\d[\d,.]*\s?(%|percent|billion|million|USD|EUR|dollars|euro)/gi) || []
    ).length,
  };
}

// ---------------------------------------------------------------- providers

async function serpFromBing(keyword) {
  const html = await get(
    "https://www.bing.com/search?q=" + encodeURIComponent(keyword) + "&count=20",
  );
  return parseBingSerp(html);
}

function serpFromFile(path) {
  const data = JSON.parse(readFileSync(path, "utf8"));
  const list = Array.isArray(data) ? data : data.results;
  if (!Array.isArray(list)) throw new Error("snapshot must be an array or {results: []}");
  return list.map((r) => ({ url: r.url, title: r.title ?? "", snippet: r.snippet ?? "" }));
}

/**
 * Resolve the snapshot for one article. If the provider points at a directory,
 * the snapshot is `<dir>/<article-basename>.json` 鈥?so a run over --all picks
 * up the right file per piece without extra flags.
 */
function resolveSnapshot(basePath, articleFile) {
  const looksLikeDir = !basePath.toLowerCase().endsWith(".json");
  if (!looksLikeDir) return basePath;
  const base = articleFile.split(/[\\/]/).pop().replace(/\.md$/, "");
  return join(basePath, base + ".json");
}

// ---------------------------------------------------------------- the gate

function parseFrontmatter(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  return { fm: m ? m[1] : "", body: m ? raw.slice(m[0].length) : raw };
}

function articleSignals(fm, body) {
  const tables = (body.match(/^\|.*\|\s*$/gm) || []).join("\n");

  /**
   * Named sources, counted where sources actually live.
   *
   * This used to count bold blockquotes in the body. But a bold blockquote is a
   * DEFINITION block: qa-check requires at least one, and every article in this
   * library has exactly one. So the value was always 1, and the cross-source
   * rule below, which requires at least 2, could never pass for any article.
   *
   * The bug was live and invisible: the fourteen previously published pieces all
   * declare `custom-calculation` or `primary-source`, and only `cross-source`
   * consults this number. The first cross-source article 鈥?a comparison of two
   * published instruments, with six named sources and eight sourced figures 鈥?
   * was reported as "does not show at least two named sources".
   *
   * The deeper mistake is that one field name carried two meanings. The
   * definition-block rule needs the blockquote count; the cross-source rule needs
   * sources. They were never the same quantity.
   */
  const listedSources = (/^sources:\s*\n((?:\s+-[^\n]*\n?)*)/m.exec(fm)?.[1] ?? "")
    .split(/\n/)
    .filter((l) => /^\s+-\s/.test(l)).length;
  const figureSources = new Set(
    [...fm.matchAll(/^\s+source:\s*"?([^"\n]+)"?\s*$/gm)].map((m) => m[1].trim()),
  ).size;

  return {
    tableRows: (body.match(/^\|.*\|\s*$/gm) || []).length,
    costTableMoney: MONEY.test(tables),
    perUnitMath: PER_UNIT.test(body),
    primaryDocId: PRIMARY_DOC_PATTERN.test(body),
    namedSources: listedSources + figureSources,
    /** Kept for the definition-block requirement, which is a different thing. */
    definitionBlocks: (body.match(/^>\s+\*\*/gm) || []).length,
  };
}

const CLAIM_RULES = {
  "custom-calculation": {
    /**
     * The asset is a numeric cost table, not the vocabulary of cost. Saying
     * "per item" or "per unit" is topic language and every page on the topic
     * does it, so the competitor count uses the strong signal only: a table
     * containing money and cost words. An earlier version counted the weaker
     * phrase signal on both sides and reported UNSUPPORTED for an article
     * whose whole point was the table.
     */
    verify: (art, comps) => {
      if (!art.costTableMoney)
        return { ok: false, why: "article carries no table containing money and cost terms" };
      const withMath = comps.filter((c) => c.signals.costTable).length;
      return withMath <= 1
        ? { ok: true, why: `only ${withMath}/${comps.length} competitors carry a comparable numeric cost table` }
        : { ok: false, why: `${withMath}/${comps.length} competitors already carry a comparable numeric cost table` };
    },
  },
  "primary-source": {
    verify: (art, comps) => {
      if (!art.primaryDocId)
        return { ok: false, why: "article does not cite a primary document identifier" };
      const withDoc = comps.filter((c) => c.signals.primaryDocId).length;
      return withDoc <= 1
        ? { ok: true, why: `only ${withDoc}/${comps.length} competitors cite the primary document` }
        : { ok: false, why: `${withDoc}/${comps.length} competitors already cite the primary document` };
    },
  },
  "cross-source": {
    verify: (art, comps) => {
      if (art.namedSources < 2)
        return { ok: false, why: "article does not show at least two named sources" };
      const dense = comps.filter((c) => c.signals.figureDensity >= 5).length;
      return dense <= 1
        ? { ok: true, why: `only ${dense}/${comps.length} competitors carry a comparable figure load` }
        : { ok: false, why: `${dense}/${comps.length} competitors carry a comparable figure load` };
    },
  },
  "own-data": {
    verify: () => ({
      ok: null,
      why: "proprietary data cannot be verified against a SERP 鈥?route to a reviewer",
    }),
  },
};

async function check(file, provider) {
  const raw = readFileSync(file, "utf8");
  const { fm, body } = parseFrontmatter(raw);
  const keyword = /^target_keyword:\s*"?([^"\n]+)"?/m.exec(fm)?.[1]?.trim();
  const claim = /^information_gain:\s*"?([a-z-]+)"?/m.exec(fm)?.[1]?.trim();

  const report = { file, keyword, claim, verdict: "INCONCLUSIVE", reason: "", competitors: [] };

  if (!keyword) return { ...report, reason: "no target_keyword in frontmatter" };
  const rule = CLAIM_RULES[claim];
  if (!rule) return { ...report, reason: `unknown information_gain value: ${claim ?? "(missing)"}` };
  if (claim === "own-data") return { ...report, reason: rule.verify().why };

  // ---- SERP ----------------------------------------------------------
  let organic;
  try {
    organic =
      provider.kind === "file"
        ? serpFromFile(resolveSnapshot(provider.path, file))
        : await serpFromBing(keyword);
  } catch (e) {
    return { ...report, reason: `SERP fetch failed (${e.message}) 鈥?cannot verify, refusing to pass` };
  }

  // Drop hosts that can never be a competitor, then split official sources
  // (the input) from actual competition.
  const filtered = organic.filter((r) => !JUNK_HOSTS.some((h) => hostOf(r.url).endsWith(h)));
  const official = filtered.filter((r) => isOfficial(r.url));
  const competitors = filtered.filter((r) => !isOfficial(r.url));
  report.official = official.map((r) => ({ url: r.url, title: r.title }));

  // Zero non-official competitors is not a failed check, it is a different
  // question. The information-gain claim cannot be false when nobody is
  // competing, so the claim is trivially supported 鈥?and the risk moves to
  // demand, which this gate does not measure. That gets reported as a warning
  // rather than hidden inside an INCONCLUSIVE.
  const warnings = [];
  if (competitors.length === 0) {
    return {
      ...report,
      reason: `no non-official organic results for this keyword (${official.length} official sources, ${organic.length} raw) 鈥?differentiation is trivially satisfied, but search demand must be verified separately`,
    };
  }
  if (competitors.length < 2) {
    warnings.push(
      `only ${competitors.length} non-official competitor 鈥?the differentiation claim is trivially true, so verify demand for this keyword separately`,
    );
  }

  // The relevance guard exists to catch a scraped SERP that is not about the
  // query 鈥?the failure mode that produced a false pass in testing, where
  // Bing truncated the keyword and served dictionary pages. A file snapshot is
  // different: its relevance is asserted by whoever produced it, from a real
  // search. Running the guard on it would second-guess the producer with a
  // weaker signal, so it is skipped and the provenance is recorded instead.
  if (provider.kind === "bing") {
    const rel = serpRelevance(keyword, competitors.slice(0, 10));
    if (!rel.ok) {
      return {
        ...report,
        reason: `SERP is not topically relevant (${rel.detail}) 鈥?likely a locale or query-truncation problem. Verify demand for this keyword before publishing; the gate cannot certify it.`,
      };
    }
  } else {
    warnings.push(
      "competitor set comes from a file snapshot: relevance is asserted by the producer, not checked here",
    );
  }

  // ---- competitor pages ----------------------------------------------
  for (const r of competitors.slice(0, TOP_N)) {
    try {
      report.competitors.push({ url: r.url, title: r.title, signals: pageSignals(await get(r.url)) });
    } catch (e) {
      report.competitors.push({ url: r.url, title: r.title, error: e.message });
    }
  }

  const loaded = report.competitors.filter((c) => c.signals);
  if (loaded.length < 1) {
    return {
      ...report,
      reason: `no competitor page could be loaded (0/${report.competitors.length}) 鈥?cannot verify, refusing to pass`,
    };
  }
  if (loaded.length < 2) {
    warnings.push(`only ${loaded.length} competitor page loaded 鈥?thin evidence`);
  }

  const verdict = rule.verify(articleSignals(fm, body), loaded);
  return {
    ...report,
    warnings,
    verdict: verdict.ok === true ? "SUPPORTED" : verdict.ok === false ? "UNSUPPORTED" : "INCONCLUSIVE",
    reason: verdict.why,
  };
}

// ---------------------------------------------------------------- CLI

// The CLI block is guarded so the module can also be imported by tests and by
// ad-hoc scripts without the process exiting on the import.
const isMain =
  process.argv[1] &&
  /serp-check\.mjs$/.test(process.argv[1].replace(/\\/g, "/"));

const args = isMain ? process.argv.slice(2) : [];
const providerArg = args.find((a) => a.startsWith("--serp="));
const provider = providerArg
  ? providerArg.startsWith("--serp=file:")
    ? { kind: "file", path: providerArg.slice("--serp=file:".length) }
    : { kind: "bing" }
  : { kind: "bing" };

const fileArgs = args.filter((a) => !a.startsWith("--") || a === "--all");
let files;
if (!isMain) {
  files = [];
} else if (fileArgs.includes("--all")) {
  const dir = "src/content/blog";
  files = readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => join(dir, f));
} else if (fileArgs.length) {
  files = fileArgs;
} else {
  console.error("usage: node tools/serp-check.mjs <file.md>... [--serp=bing|file:<path>]");
  process.exit(2);
}

let unsupported = 0;
let inconclusive = 0;

for (const file of files) {
  const r = await check(file, provider);
  console.log(`\n${file}`);
  console.log(`  keyword      : ${r.keyword ?? "鈥?}`);
  console.log(`  claimed gain : ${r.claim ?? "鈥?}`);
  if (r.official?.length) {
    console.log(`  official sources in SERP (excluded from competition):`);
    for (const o of r.official) console.log(`    ${o.url}`);
  }
  if (r.competitors.length) console.log(`  competitors checked:`);
  for (const c of r.competitors) {
    const s = c.signals;
    console.log(
      `    ${c.url}\n      ${s ? `${s.words} words 路 ${s.tables} tables 路 costTable=${s.costTable} 路 perUnit=${s.perUnitMath} 路 primaryDoc=${s.primaryDocId} 路 figures=${s.figureDensity}` : "FETCH FAILED: " + c.error}`,
    );
  }
  console.log(`  verdict      : ${r.verdict} 鈥?${r.reason}`);
  for (const w of r.warnings ?? []) console.log(`  ! warning    : ${w}`);
  if (r.verdict === "UNSUPPORTED") unsupported++;
  if (r.verdict === "INCONCLUSIVE") inconclusive++;
}

if (isMain) {
  console.log(
    `\nRESULT: ${unsupported} unsupported 路 ${inconclusive} inconclusive 路 ${files.length - unsupported - inconclusive} supported\n`,
  );
  process.exit(unsupported ? 1 : 0);
}
