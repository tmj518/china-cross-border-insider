#!/usr/bin/env node
/**
 * The content ledger: one row per published piece, blog and guide in the same table.
 *
 * The run ledger answers "what happened on Tuesday". It cannot answer "what is published, where does it
 * link, and does anything duplicate anything else" - that is a property of the corpus, not of a run, and
 * it has to be recomputed from the corpus every time because the corpus changes every day.
 *
 *   node tools/content-ledger.mjs                 # write to 内容台账
 *   node tools/content-ledger.mjs --dry-run       # print the rows, need no credentials
 *   node tools/content-ledger.mjs --with-gates    # also run qa-check per analysis (slower)
 *
 * Every row is derived. Nothing here is typed by hand, so the table cannot drift from the repository,
 * and the dedupe and link counts are measurements rather than a reviewer's impression.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import { api, ensureTable, tenantToken, upsertRows } from "./lib/feishu.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const BLOG = join(ROOT, "src", "content", "blog");
const GUIDE = join(ROOT, "src", "content", "guide");
const SITE = "https://www.landedmath.com";
const TABLE = "内容台账";

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const WITH_GATES = args.includes("--with-gates");

const COLUMNS = [
  "编号",
  "类型",
  "栏目",
  "标题",
  "URL",
  "日期",
  "核实日",
  "数字条数",
  "结构闸门",
  "内链数",
  "入链数",
  "查重",
  "复查到期日",
  "时刻",
  "画像",
  "来源完整率",
  "commit",
  "路线",
];

/* ── read the corpus ─────────────────────────────────────────────────────────────────────────── */

const fmOf = (raw) => ({
  fm: /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw)?.[1] ?? "",
  body: raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, ""),
});
const scalar = (fm, k) => new RegExp(`^${k}:\\s*"?(.*?)"?\\s*$`, "m").exec(fm)?.[1]?.trim() ?? "";
const quoted = (fm, k) => new RegExp(`^${k}:\\s*"(.*?)"\\s*$`, "m").exec(fm)?.[1] ?? scalar(fm, k);

const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Every internal link in a body, as {kind, slug}. */
function outbound(body) {
  const out = [];
  for (const m of body.matchAll(/\]\((\/(?:blog|guide)\/([^/)#?]+)\/?)/g)) {
    out.push({ kind: m[1].startsWith("/guide/") ? "guide" : "blog", slug: m[2] });
  }
  return out;
}

function load(dir, kind, urlFor) {
  if (!existsSync(dir)) return [];
  const rows = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
    const raw = readFileSync(join(dir, f), "utf8");
    const { fm, body } = fmOf(raw);
    if (/^draft:\s*true/m.test(fm)) continue;
    const slug = f.replace(/\.md$/, "");
    const figures = (fm.match(/^  - value:/gm) ?? []).length;
    const steps = (fm.match(/^  - action:/gm) ?? []).length;
    rows.push({
      key: `${kind}:${slug}`,
      kind,
      slug,
      title: quoted(fm, "title"),
      section: kind === "blog" ? quoted(fm, "category") : quoted(fm, "topic"),
      url: urlFor(slug),
      date: kind === "blog" ? quoted(fm, "publishDate") : quoted(fm, "lastVerified"),
      verified: kind === "guide" ? quoted(fm, "lastVerified") : "",
      figures,
      steps,
      reviewBy: quoted(fm, "reviewBy"),
      keyword: quoted(fm, "target_keyword"),
      body,
      links: outbound(body),
      audience: quoted(fm, "audience"),
    moment: quoted(fm, "moment"),
    cellPersona: quoted(fm, "cellPersona"),
    route: quoted(fm, "route"),
      withSource: (fm.match(/^    source:/gm) ?? []).length,
      filePath: relative(ROOT, join(dir, f)),
    });
  }
  return rows;
}

const rows = [
  ...load(BLOG, "blog", (s) => `${SITE}/blog/${s}/`),
  ...load(GUIDE, "guide", (s) => `${SITE}/guide/${s}/`),
];

/* ── measure ─────────────────────────────────────────────────────────────────────────────────── */

const inbound = new Map();
for (const r of rows) {
  for (const l of r.links) {
    const k = `${l.kind}:${l.slug}`;
    inbound.set(k, (inbound.get(k) ?? 0) + 1);
  }
}

/* Two rows are duplicates when they share a normalised title, or share a target keyword. The second
   test is the one that matters for the blog: a rewritten title over the same keyword still competes
   with itself in the index. */
const byTitle = new Map();
const byKeyword = new Map();
for (const r of rows) {
  const t = norm(r.title);
  if (t) byTitle.set(t, [...(byTitle.get(t) ?? []), r.key]);
  const k = norm(r.keyword);
  if (k) byKeyword.set(k, [...(byKeyword.get(k) ?? []), r.key]);
}

function dupOf(r) {
  const t = byTitle.get(norm(r.title)) ?? [];
  if (t.length > 1) return `title same as ${t.filter((x) => x !== r.key).join(", ")}`;
  const k = byKeyword.get(norm(r.keyword)) ?? [];
  if (k.length > 1) return `keyword same as ${k.filter((x) => x !== r.key).join(", ")}`;
  return "ok";
}

function qaFor(r) {
  if (r.kind === "guide") return `schema ok, ${r.figures} figure(s), ${r.steps} step(s)`;
  if (!WITH_GATES) return "(not run)";
  const file = join(BLOG, `${r.slug}.md`);
  const res = spawnSync(process.execPath, [join(ROOT, "tools", "qa-check.mjs"), file], { encoding: "utf8", timeout: 60000 });
  const m = /(\d+) pass · (\d+) warn · (\d+) BLOCK/.exec(res.stdout ?? "");
  return m ? `${m[1]} pass / ${m[3]} block` : `qa-check exit ${res.status}`;
}

/*
 * The run records know which route published a slug, even for articles written before the frontmatter
 * carried it. Read once, indexed by slug. A run that published nothing contributes nothing.
 */
const ROUTE_BY_SLUG = (() => {
  const map = new Map();
  try {
    const dir = join(ROOT, "data", "runs");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      try {
        const j = JSON.parse(readFileSync(join(dir, f), "utf8"));
        const route = j.route === "c" ? "c" : j.route === "agent" ? "agent" : j.route === "script" ? "script" : null;
        if (!route) continue;
        for (const p of j.published ?? []) map.set(p, route);
        if (j.article) map.set(String(j.article), route);
      } catch {}
    }
  } catch {}
  return map;
})();
function routeFromRuns(key) {
  const slug = String(key).replace(/^[a-z]+:/, "");
  return ROUTE_BY_SLUG.get(slug) ?? null;
}

const records = rows.map((r) => ({
  编号: r.key,
  类型: r.kind === "blog" ? "analysis" : "guide",
  栏目: r.section,
  标题: r.title.slice(0, 200),
  URL: r.url,
  日期: r.date,
  核实日: r.verified,
  数字条数: String(r.figures),
  结构闸门: qaFor(r),
  内链数: String(r.links.length),
  入链数: String(inbound.get(r.key) ?? 0),
  查重: dupOf(r),
  复查到期日: r.reviewBy,
  时刻: r.moment || "未标注",
  画像: (r.cellPersona || String(r.audience ?? "").replace(/[\[\]\"']/g, "")).slice(0, 60) || "未标注",
  来源完整率: r.figures ? Number((r.withSource / r.figures).toFixed(2)) : 0,
  commit: (() => { try { return execFileSync("git", ["log", "-1", "--format=%h", "--", r.filePath], { cwd: ROOT, encoding: "utf8" }).trim() || "-"; } catch { return "-"; } })(),
  /*
   * WHICH LINE WROTE THIS, IN THAT ORDER, AND NEVER FROM THE DIRECTORY.
   *
   * blog/ holds both script and agent articles, so the path cannot tell them apart and guessing would
   * put a confident wrong value in the column. Frontmatter first, then the run record for that slug,
   * then an explicit 未标注.
   */
  /*
   * A GUIDE IS WRITTEN BY THE GUIDE LINE - that is structural, not a guess.
   *
   * The column was hand-backfilled on 2026-10-31 and the next ledger run recomputed every row from
   * frontmatter and run records, found nothing for the older guides, and wrote 未标注 back over them:
   * c went from 24 rows to 6. A derived column cannot be repaired at the destination while its source
   * stays empty, so the source gets the one fact that is actually true - src/content/guide is written by
   * the guide line and by nothing else.
   */
  路线: r.route || (/^guide:/.test(r.key) ? "c" : routeFromRuns(r.key)) || "未标注",
}));

/* ── output ──────────────────────────────────────────────────────────────────────────────────── */

console.log(`CONTENT LEDGER  ${records.length} row(s)`);
console.log("=".repeat(96));
const dupes = records.filter((r) => r.查重 !== "ok");
const orphans = records.filter((r) => r.入链数 === "0");
const deadEnds = records.filter((r) => r.内链数 === "0");
console.log(`  duplicates : ${dupes.length}${dupes.length ? " -> " + dupes.map((r) => r.编号).join(", ") : ""}`);
console.log(`  no inbound : ${orphans.length}`);
console.log(`  no outbound: ${deadEnds.length}`);
for (const r of records.slice(0, 8)) {
  console.log(`  ${r.编号.padEnd(46)} ${String(r.数字条数).padStart(3)} fig  in ${String(r.入链数).padStart(2)}  out ${String(r.内链数).padStart(2)}  ${r.查重 === "ok" ? "" : "DUP"}`);
}

if (DRY) {
  console.log("\n--dry-run: nothing written");
  process.exit(0);
}

const APP_ID = (process.env.FEISHU_APP_ID ?? "").trim();
const APP_SECRET = (process.env.FEISHU_APP_SECRET ?? "").trim();
const target = (() => {
  try {
    return JSON.parse(readFileSync(join(ROOT, "data", "ledger-target.json"), "utf8"));
  } catch {
    return null;
  }
})();
const APP_TOKEN = ((process.env.FEISHU_APP_TOKEN ?? "").trim() || target?.appToken || "").trim();

if (!APP_TOKEN) {
  console.log("\n  cannot write: no base token. Set FEISHU_APP_TOKEN or record one in data/ledger-target.json.");
  process.exit(2);
}

const token = await tenantToken(APP_ID, APP_SECRET);
if (!token) process.exit(1);

/*
 * WHICH TABLE, IN THAT ORDER, AND NEVER BY GUESS.
 *
 *   env FEISHU_TABLE_ID -> data/ledger-target.json tableId -> look up by name, then persist the id
 *
 * The id used to live only in an environment variable. A variable missing on one machine turns "the
 * ledger is written" into "the ledger is written somewhere else", with no error to show for it.
 * Persisting the id after a lookup means a fresh clone has it with no variables set.
 *
 * The content table and the run table are different tables at different grains - one row per article,
 * one row per run - and the run id must never be used here.
 */
const TARGET_TABLE_ID = ((process.env.FEISHU_TABLE_ID ?? "").trim() || (target?.tableId ?? "").trim());
let tableId = TARGET_TABLE_ID;
if (!tableId) {
  tableId = await ensureTable({ token, appToken: APP_TOKEN, name: TABLE, fields: COLUMNS, primaryName: "编号" });
  if (tableId && !DRY) {
    try {
      const cur = JSON.parse(readFileSync(join(ROOT, "data", "ledger-target.json"), "utf8"));
      cur.tableId = tableId;
      cur.tableName = TABLE;
      cur.at = new Date().toISOString().slice(0, 10);
      writeFileSync(join(ROOT, "data", "ledger-target.json"), JSON.stringify(cur, null, 2) + "\n", "utf8");
      console.log("  recorded table id in data/ledger-target.json");
    } catch {}
  }
}
const res = await upsertRows({ token, appToken: APP_TOKEN, tableId, keyField: "编号", rows: records });
console.log(`\n  created ${res.created}, updated ${res.updated}, failed ${res.failed}`);

/*
 * Prune rows whose piece no longer exists.
 *
 * An upsert alone leaves a row for every article that was ever published, including the ones the
 * duplicate cleaner removes, so the ledger keeps reporting a page that returns 404. The corpus is the
 * authority: a key that is not in it is not a published piece. Deleting by key is safe because the row
 * is recreated if the file comes back.
 */
if (args.includes("--prune")) {
  const existing = await api(`/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records?page_size=500`, { token });
  const live = new Set(records.map((r) => r.编号));
  const dead = [];
  for (const rec of existing.items ?? []) {
    const v = rec.fields?.["编号"];
    const key = Array.isArray(v) ? v.map((x) => x.text ?? x).join("") : String(v ?? "");
    if (key && !live.has(key)) dead.push({ id: rec.record_id, key });
  }
  let removed = 0;
  for (const d of dead) {
    try {
      await api(`/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/records/${d.id}`, { method: "DELETE", token });
      removed++;
      console.log(`  pruned ${d.key}`);
    } catch (e) {
      console.log(`  prune ${d.key}: FAILED - ${String(e.message).slice(0, 80)}`);
    }
  }
  console.log(`  pruned ${removed} of ${dead.length} stale row(s)`);
}

process.exit(res.failed ? 1 : 0);
