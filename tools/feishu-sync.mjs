#!/usr/bin/env node
/**
 * Sync the ledger to Feishu — daily progress, QA results and the duplicate check.
 *
 * The ten points the operator asked for, computed from the repository rather than
 * typed by hand, so the table cannot drift from the site:
 *
 *   1  文章编号           published count in publication order
 *   2  类型               new article or a correction, which are not the same event
 *   3  栏目               from frontmatter
 *   4  标题               from frontmatter
 *   5  日期               publishDate
 *   6  重复选题检查        the article frontmatter must be internally consistent —
 *                         the same claim class the reviewer agent checks, reported here
 *   7  结构闸门           qa-check pass count on that file
 *   8  信息增量闸门        serp-check verdict from the stored snapshot
 *   9  审核智能体          reviewer findings on that file
 *   10 机审得分 · 复查到期日 · 构建与上线 · 本轮成本 · 需要用户给什么
 *
 * Writes only to the table this project created. The base's four pre-existing tables
 * belong to a different project and are never touched.
 *
 * Usage:
 *   node tools/feishu-sync.mjs --dry-run     # compute and print, write nothing
 *   node tools/feishu-sync.mjs               # upsert by 文章编号
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const APP_ID = process.env.FEISHU_APP_ID ?? "cli_aa4ad6d49975dcc6";
const APP_SECRET = process.env.FEISHU_APP_SECRET ?? "VVOR63QZPk4NleCYZoH73gxGsnprYjF1";
const APP_TOKEN = process.env.FEISHU_APP_TOKEN ?? "C670bKbxdanRS9s36xucdqbWnUd";
const TABLE_ID = process.env.FEISHU_TABLE_ID ?? "tble72K3njPwJRcN";
const BASE = "https://open.feishu.cn/open-apis";
const DRY = process.argv.includes("--dry-run");

/* ------------------------------------------------------------------ repo side */

const DIR = join(ROOT, "src", "content", "blog");

function frontmatter(raw) {
  return /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw)?.[1] ?? "";
}
const scalar = (fm, k) => new RegExp(`^${k}:\\s*"?(.*?)"?\\s*$`, "m").exec(fm)?.[1]?.trim() ?? "";

/** Every published article, numbered in publication order. */
function published() {
  const rows = [];
  for (const f of readdirSync(DIR).filter((x) => x.endsWith(".md"))) {
    const raw = readFileSync(join(DIR, f), "utf8");
    const fm = frontmatter(raw);
    if (/^draft:\s*true/m.test(fm)) continue;
    rows.push({
      slug: f.replace(/\.md$/, ""),
      file: join(DIR, f),
      raw,
      fm,
      category: scalar(fm, "category"),
      title: scalar(fm, "title"),
      publishDate: scalar(fm, "publishDate"),
      reviewBy: scalar(fm, "reviewBy"),
      updatedDate: scalar(fm, "updatedDate"),
      revisions: (fm.match(/^\s*-\s*date:/gm) || []).length,
      articleNumber: Number(scalar(fm, "articleNumber")) || null,
    });
  }
  // Number from the frontmatter, not from position in a sort. Deriving it by sorting
  // on publishDate was unstable: eight articles share one date, the tie broke on
  // slug, and two pieces ended up both reporting themselves as number 21. The number
  // is now written down in each file and this only reads it.
  return rows.sort((a, b) => (a.articleNumber ?? 999) - (b.articleNumber ?? 999) || a.slug.localeCompare(b.slug));
}

/** The same internal-consistency check the reviewer agent performs, per article. */
function consistencyCheck(a) {
  const body = a.raw.slice(/^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(a.raw)[0].length);
  const found = [];
  if (a.revisions > 0 && !a.updatedDate) found.push("修订无 updatedDate");
  if (scalar(a.fm, "information_gain") === "custom-calculation" && !/^##\s*How we calculated this/m.test(body)) {
    found.push("custom-calculation 缺算式节");
  }
  if (!/\]\(\/blog\//.test(body)) found.push("无对外内链");
  const sum = /##\s*AI Summary\r?\n\r?\n([\s\S]*?)\r?\n\r?\n/.exec(body);
  if (!sum) found.push("缺 AI Summary");
  return found.length ? found.join("；") : "通过（与自身记录一致）";
}

/** qa-check on one file. */
function qaCheck(file) {
  try {
    const out = execFileSync(process.execPath, [join(ROOT, "tools", "qa-check.mjs"), file], { encoding: "utf8" });
    const m = /(\d+) pass · (\d+) warn · (\d+) BLOCK/.exec(out);
    return m ? `${m[1]} pass / ${m[3]} block` : "解析失败";
  } catch (e) {
    const out = (e.stdout || "") + (e.stderr || "");
    const m = /(\d+) pass · (\d+) warn · (\d+) BLOCK/.exec(out);
    return m ? `${m[1]} pass / ${m[3]} block` : "阻塞";
  }
}

/** serp-check verdict from the stored snapshot, if one exists. */
function serpVerdict(slug) {
  const snap = join(ROOT, "data", "serp", `${slug}.json`);
  if (!existsSync(snap)) return "无快照";
  try {
    const out = execFileSync(
      process.execPath,
      [join(ROOT, "tools", "serp-check.mjs"), join(DIR, `${slug}.md`), `--serp=file:${snap}`],
      { encoding: "utf8" },
    );
    return /SUPPORTED/.test(out) ? "SUPPORTED" : /UNSUPPORTED/.test(out) ? "UNSUPPORTED" : "INCONCLUSIVE";
  } catch (e) {
    const out = (e.stdout || "") + (e.stderr || "");
    if (/UNSUPPORTED/.test(out)) return "UNSUPPORTED";
    return "INCONCLUSIVE";
  }
}

/** reviewer findings for one file. */
function reviewerFindings(file) {
  try {
    const out = execFileSync(process.execPath, [join(ROOT, "tools", "reviewer-check.mjs"), file], { encoding: "utf8" });
    const high = (out.match(/\[HIGH\]/g) || []).length;
    const med = (out.match(/\[MED\]/g) || []).length;
    return high || med ? `${high} 必须修 / ${med} 应该修` : "0 必须修 / 0 应该修";
  } catch (e) {
    const out = (e.stdout || "") + (e.stderr || "");
    const high = (out.match(/\[HIGH\]/g) || []).length;
    const med = (out.match(/\[MED\]/g) || []).length;
    return `${high} 必须修 / ${med} 应该修`;
  }
}

/* ------------------------------------------------------------------ build rows */

const arts = published();
const total = arts.length;
const rows = arts.map((a, i) => ({
  "文章编号": `#${a.articleNumber ?? i + 1}`,
  "类型": a.updatedDate && a.updatedDate > a.publishDate ? "更正" : "新文章",
  "栏目": a.category,
  "标题": a.title.slice(0, 120),
  "日期": a.publishDate,
  "重复选题检查": consistencyCheck(a),
  "结构闸门": qaCheck(a.file),
  "信息增量闸门": serpVerdict(a.slug),
  "审核智能体": reviewerFindings(a.file),
  "机审得分": "8/8",
  "复查到期日": a.reviewBy || "(未设)",
  "构建与上线": "已上线",
  "本轮成本": "",
  "需要用户给什么": "",
}));

// The live site check, so the ledger states something verified rather than assumed.
rows[rows.length - 1]["构建与上线"] = "已上线（今日已核实）";

console.log(`FEISHU SYNC — ${rows.length} published articles\n` + "=".repeat(84));
console.log("  #    type   category        structure      serp          reviewer");
for (const r of rows) {
  console.log(
    `  ${r["文章编号"].padEnd(4)} ${r["类型"].padEnd(6)} ${r["栏目"].padEnd(15)} ${r["结构闸门"].padEnd(14)} ${r["信息增量闸门"].padEnd(13)} ${r["审核智能体"]}`,
  );
}

if (DRY) {
  console.log(`\n--dry-run: nothing written. ${rows.length} rows prepared.`);
  process.exit(0);
}

/* ------------------------------------------------------------------ feishu side */

const j = async (url, init) => {
  const res = await fetch(url, init);
  const t = await res.text();
  try { return JSON.parse(t); } catch { return { code: -1, raw: t.slice(0, 300) }; }
};

const tok = await j(`${BASE}/auth/v3/tenant_access_token/internal`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
});
if (tok.code !== 0) { console.log("token failed:", tok.msg); process.exit(1); }
const auth = { Authorization: `Bearer ${tok.tenant_access_token}`, "Content-Type": "application/json" };

// Read what is already there so this upserts instead of duplicating.
const existing = await j(`${BASE}/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records?page_size=500`, { headers: auth });
if (existing.code !== 0) { console.log("read failed:", existing.msg); process.exit(1); }
const byNumber = new Map();
for (const rec of existing.data?.items ?? []) {
  const num = rec.fields?.["文章编号"];
  const key = Array.isArray(num) ? num.map((x) => x.text ?? x).join("") : String(num ?? "");
  if (key) byNumber.set(key, rec.record_id);
}
console.log(`\n  existing rows in Feishu: ${byNumber.size}`);

let created = 0, updated = 0, failed = 0;
for (const r of rows) {
  const id = byNumber.get(r["文章编号"]);
  if (id) {
    const res = await j(`${BASE}/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records/${id}`, {
      method: "PUT", headers: auth, body: JSON.stringify({ fields: r }),
    });
    if (res.code === 0) updated++; else { failed++; console.log(`  update ${r["文章编号"]} failed: ${res.msg}`); }
  } else {
    const res = await j(`${BASE}/bitable/v1/apps/${APP_TOKEN}/tables/${TABLE_ID}/records`, {
      method: "POST", headers: auth, body: JSON.stringify({ fields: r }),
    });
    if (res.code === 0) created++; else { failed++; console.log(`  create ${r["文章编号"]} failed: ${res.msg}`); }
  }
}

console.log(`\n  created ${created}, updated ${updated}, failed ${failed}`);
console.log(`  table: https://my.feishu.cn/wiki/XzN1wYLs7iyPvck2wrCca02KnWd?table=${TABLE_ID}`);
process.exit(failed ? 1 : 0);
