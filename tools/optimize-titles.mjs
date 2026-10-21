/*
 * Which pages does Google already rank, and which of them nobody clicks.
 *
 * Search Console on 2026-10-20, three months: clicks 7, impressions 718, CTR 1%, average position 6.3.
 * Rerun on 2026-10-21 over the same ninety days: 819 impressions, 7 clicks, 78 pages with rows.
 * Position 6.3 with a 1% click rate is not a content problem - Google already thinks those pages are relevant,
 * and position six is normally clicked four to eight times per hundred impressions. One per hundred means the
 * title and description are not earning the click, which is the cheapest work on the site: no research, no
 * writing, no tokens.
 *
 * WITHOUT --rewrite IT ONLY READS. Nothing is written, nothing published, nothing committed. With --rewrite it
 * changes the title line and nothing else: it backs the file up, runs qa-check, and restores the backup if the
 * gate fails. The body of an article is never touched, and a title nobody has read yet is not a title.
 *
 *   node tools/optimize-titles.mjs                       # shortlist, no model, no writes
 *   node tools/optimize-titles.mjs --min-imp=20 --max-pos=8 --max-ctr=0.01
 *   node tools/optimize-titles.mjs --from=out/gsc-90.json   # use a saved payload, no credential needed
 *   node tools/optimize-titles.mjs --rewrite             # propose, then apply the best one, behind qa-check
 */
import { execSync, spawnSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { ask as askModel } from "./lib-llm.mjs";
import { loadEnv } from "./lib/gsc.mjs";

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const arg = (n, d) => {
  const hit = argv.find((a) => a.startsWith(`--${n}=`));
  return hit ? Number(hit.slice(n.length + 3)) : d;
};
const MIN_IMP = arg("min-imp", 50);
const MAX_POS = arg("max-pos", 10);
const MAX_CTR = arg("max-ctr", 0.02);
const ALL = argv.includes("--all");
/*
 * Ninety days, not the default twenty-eight.
 *
 * The first run of this audit asked Search Console for a month and got nothing back, because the site's 718
 * impressions are spread over three months and almost none of them fall in the last four weeks. A window narrower
 * than the traffic is a filter that reports "no work to do" while the work sits there.
 */
const DAYS = arg("days", 90);

console.log("");
console.log("TITLE OPTIMISER  -  read only, nothing is written");
console.log("=".repeat(94));
console.log(`  filter : ${DAYS}d   impressions > ${MIN_IMP}   position < ${MAX_POS}   ctr < ${(MAX_CTR * 100).toFixed(1)}%`);
console.log("");

/*
 * Where the numbers come from.
 *
 * Normally the sibling script, because it owns the JWT signing and the retries. But the
 * credential lives in a repository secret, so the only machine that can ask Google is a
 * runner - and the rewrite prompt is the part worth iterating on, which needs the real
 * rows on a workstation. --from closes that loop: save the payload once where the
 * credential is, then re-run the rewriter against it as often as the prompt needs.
 */
const FROM = ((argv.find((a) => a.startsWith("--from=")) ?? "").slice("--from=".length) || "").trim();

let payload;
try {
  if (FROM) {
    payload = JSON.parse(readFileSync(FROM, "utf8"));
  } else {
    const out = execSync(`${process.execPath} tools/gsc-report.mjs --json --days=${DAYS}`, {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const a = out.indexOf("{");
    const b = out.lastIndexOf("}");
    if (a < 0 || b < 0) throw new Error("gsc-report printed no JSON object");
    payload = JSON.parse(out.slice(a, b + 1));
  }
} catch (e) {
  const detail = String(e.stdout ?? "") + String(e.stderr ?? e.message ?? "");
  console.log("  could not read Search Console:");
  console.log("  " + detail.trim().split("\n").slice(-4).join("\n  ").slice(0, 600));
  console.log("");
  console.log("  Nothing was changed. This script only reads.");
  process.exit(1);
}

const pages = Array.isArray(payload?.pages) ? payload.pages : [];
console.log(`  window : ${payload?.days ?? "?"} day(s)     site : ${payload?.site ?? "?"}     pages : ${pages.length}`);
console.log("");
if (!pages.length) {
  console.log("  No page rows for this window. On a site this young that is the expected state, not a fault.");
  process.exit(0);
}

const dir = join(ROOT, "src", "content", "blog");
const fmOf = (file) => {
  try {
    const text = readFileSync(file, "utf8");
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";
    const pick = (k) => (new RegExp(`^${k}:\\s*"?(.*?)"?\\s*$`, "m").exec(fm) ?? [])[1] ?? "";
    return { title: pick("title"), description: pick("description") };
  } catch {
    return null;
  }
};
const slugOf = (u) => (/\/blog\/([^/?#]+)/.exec(String(u ?? "")) ?? [])[1] ?? "";

const rows = pages
  .map((r) => ({
    page: String(r.page ?? ""),
    slug: slugOf(r.page),
    impressions: Number(r.impressions ?? 0),
    clicks: Number(r.clicks ?? 0),
    ctr: Number(r.ctr ?? 0),
    position: Number(r.position ?? 0),
  }))
  .filter((r) => r.page);

const short = (ALL
  ? rows
  : rows.filter((r) => r.impressions > MIN_IMP && r.position < MAX_POS && r.ctr < MAX_CTR)
).sort((x, y) => y.impressions - x.impressions);

console.log(`  shortlist : ${short.length} page(s)`);
console.log("");
if (!short.length) {
  console.log("  Nothing qualifies. Either the pages earn their clicks, or the floor is too high");
  console.log("  for a site this young - try --min-imp=20.");
  process.exit(0);
}

const shown = short.map((r) => {
  const p = existsSync(join(dir, `${r.slug}.md`)) ? fmOf(join(dir, `${r.slug}.md`)) : null;
  return { ...r, title: p?.title || "(no local file for this slug)" };
});
const w = Math.min(62, Math.max(20, ...shown.map((r) => r.title.length)));
const head = "  " + "imp".padStart(6) + "  " + "clk".padStart(4) + "  " + "ctr".padStart(6) + "  " + "pos".padStart(5) + "  " + "title".padEnd(w);
console.log(head);
console.log("  " + "-".repeat(head.length - 2));
for (const r of shown) {
  console.log(
    "  " + String(r.impressions).padStart(6) + "  " + String(r.clicks).padStart(4) + "  " +
    `${(r.ctr * 100).toFixed(1)}%`.padStart(6) + "  " + r.position.toFixed(1).padStart(5) + "  " +
    r.title.slice(0, w).padEnd(w),
  );
}
console.log("");
console.log("  What to do with this list, in order:");
console.log("    1. read the top description the way a stranger would, in a search result");
console.log("    2. rewrite the title to promise a consequence, not to name a subject");
console.log("    3. keep it under 60 characters - fitTitle() drops the qualifier rather than truncating");
console.log("");

/* ------------------------------------------------------------------ the rewriter */

/*
 * Four schools, one chosen per page.
 *
 * The point of naming the schools is that "make it better" produces the same title
 * every time. A constraint produces a choice, and the choice is the thing a reader
 * responds to: money, a deadline, a broken assumption, or a comparison.
 */
const STYLES = {
  "算账流": "明确告诉读者兜里的钱涨了还是跌了，把后果写成金额或百分比",
  "生死线流": "强调时间紧迫感和违规后果，写清哪一天、什么代价",
  "反差揭秘流": "打破读者现有认知，制造信息差：他们以为 A，其实是 B",
  "对比流": "把两个市场、两套政策、两个时点放在一起，让差异自己说话",
};

const MAX_TITLE = 60;
const REWRITE = argv.includes("--rewrite");
const MODEL = ((argv.find((a) => a.startsWith("--model=")) ?? "").slice("--model=".length) || process.env.TITLE_MODEL || "").trim();

/* The .env is the local mirror of the workflow's secrets; lib-llm reads process.env. */
const localEnv = loadEnv(join(ROOT, ".env"));
for (const [k, v] of Object.entries(localEnv)) if (!process.env[k]) process.env[k] = v;

/** The article body, without frontmatter, capped so a long piece cannot crowd the prompt. */
function bodyOf(file) {
  const text = readFileSync(file, "utf8");
  const fm = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text)?.[0] ?? "";
  return text.slice(fm.length).replace(/```[\s\S]*?```/g, " ").replace(/\s+/g, " ").trim().slice(0, 5000);
}

/** The first JSON object in a reply, or null. The model is asked for JSON and may fence it. */
function pickJson(text) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  for (const c of [fenced, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)]) {
    if (!c) continue;
    try {
      const o = JSON.parse(c);
      if (o && typeof o === "object") return o;
    } catch { /* next shape */ }
  }
  return null;
}

const SYSTEM = [
  "你是顶级 B2B 标题专家，严格遵守 Google 官方 SEO 指南：",
  "- 标题不超过 60 个字符（含空格）；超过就是硬失败。",
  "- 保留核心搜索词，读者在搜索结果里必须一眼看出这篇讲什么。",
  "- 不标题党，不承诺正文给不了的东西，不用全大写，不用感叹号。",
  "- 面向中国的进出口商、外贸业务员、合规负责人，写英语。",
].join("\n");

function prompt(row, article) {
  return [
    `现有标题：${article.title}`,
    `现有描述：${article.description || "(无)"}`,
    "",
    "这个页面在 Google 已经有曝光但几乎没人点：",
    `曝光 ${row.impressions} 次，点击 ${row.clicks} 次，CTR ${(row.ctr * 100).toFixed(1)}%，平均排名 ${row.position.toFixed(1)}。`,
    "排名说明 Google 认为内容相关。没人点，说明标题的承诺没打中。",
    "",
    "四大流派：",
    ...Object.entries(STYLES).map(([k, v]) => `${k}：${v}`),
    "",
    "请从这四派中选择**最适合这一篇**的一派，在该派内生成 3 个候选标题，逐个自评打分（1-10，",
    "评分标准：与正文一致、承诺了后果、在 60 字符内、包含核心词），返回得分最高的那个。",
    "",
    "正文节选：",
    bodyOf(article.file),
    "",
    "只输出 JSON，不要解释，不要代码块以外的文字：",
    '{"style":"四派之一的名称","why":"一句话说明为什么选这一派",' +
      '"candidates":[{"title":"...","score":9,"note":"承诺了什么后果"},' +
      '{"title":"...","score":8,"note":"..."},{"title":"...","score":7,"note":"..."}],' +
      '"best":"得分最高的那个标题，必须与 candidates 里的某一个完全一致"}',
  ].join("\n");
}

async function propose(row, article) {
  const ask = async (extra) => {
    const r = await askModel({
      role: "writer",
      ...(MODEL ? { model: MODEL } : {}),
      system: SYSTEM,
      temperature: 0.6,
      maxTokens: 1200,
      messages: [{ role: "user", content: prompt(row, article) + (extra ? `\n\n${extra}` : "") }],
    });
    if (!r.ok) throw new Error(r.error ?? "the model returned nothing");
    const json = pickJson(r.text ?? "");
    if (!json) throw new Error(`no JSON in the reply: ${String(r.text ?? "").slice(0, 200)}`);
    return json;
  };

  let json = await ask("");
  let best = String(json.best ?? "").trim();

  /* Over the limit is a hard failure, not a warning: it is the one rule Google states. */
  if (best.length > MAX_TITLE) {
    json = await ask(
      `上一个答案里 "${best}" 有 ${best.length} 个字符，超过 60 的硬上限。` +
        "请整组重写：三个候选都必须不超过 60 字符，仍然保留核心词和后果承诺。",
    );
    best = String(json.best ?? "").trim();
  }
  return { json, best };
}

const DIRT = "out";
function qaCheck(file) {
  /* A file descriptor, not a pipe: the same bytes inside the sandbox and out of it. */
  mkdirSync(join(ROOT, DIRT), { recursive: true });
  const tmp = join(ROOT, DIRT, `.qa-${process.pid}-${Date.now()}.txt`);
  const fd = openSync(tmp, "w");
  const r = spawnSync(process.execPath, [join(ROOT, "tools", "qa-check.mjs"), file], { stdio: ["ignore", fd, fd] });
  closeSync(fd);
  const out = existsSync(tmp) ? readFileSync(tmp, "utf8") : "";
  rmSync(tmp, { force: true });
  const m = /(\d+) pass · (\d+) warn · (\d+) BLOCK/.exec(out);
  return { ok: r.status === 0, summary: m ? `${m[1]} pass / ${m[3]} block` : `qa-check exit ${r.status}`, out };
}

console.log("=".repeat(94));
console.log(`  rewriter : ${REWRITE ? "WRITES the markdown" : "proposes only - nothing is written"}${MODEL ? `   model ${MODEL}` : ""}`);
console.log("=".repeat(94));

for (const row of shown) {
  const file = join(dir, `${row.slug}.md`);
  console.log("");
  console.log(`  ${row.slug}`);
  console.log(`    now    : ${row.title}   (${row.title.length} chars)`);
  if (!existsSync(file)) {
    console.log("    skip   : no local markdown for this slug");
    continue;
  }
  const article = { ...fmOf(file), file };

  let result;
  try {
    result = await propose(row, article);
  } catch (e) {
    console.log(`    FAILED : ${e.message.slice(0, 240)}`);
    continue;
  }

  const { json, best } = result;
  const style = String(json.style ?? "?").trim();
  console.log(`    style  : ${style} — ${String(json.why ?? "").slice(0, 90)}`);
  for (const c of Array.isArray(json.candidates) ? json.candidates : []) {
    const t = String(c?.title ?? "");
    const flag = t.length > MAX_TITLE ? `  OVER ${t.length}` : "";
    console.log(`      ${String(c?.score ?? "?").padStart(2)}  ${t}${flag}`);
  }
  if (!best) {
    console.log("    FAILED : the model returned no best title");
    continue;
  }
  if (best.length > MAX_TITLE) {
    console.log(`    REJECT : "${best}" is ${best.length} chars, over the ${MAX_TITLE} limit. Not written.`);
    continue;
  }
  console.log(`    best   : ${best}   (${best.length} chars)`);

  if (!REWRITE) continue;

  /* Back up, write, gate, and roll back on failure - in that order, never skipping one. */
  const bak = `${file}.bak`;
  copyFileSync(file, bak);
  const original = readFileSync(file, "utf8");
  writeFileSync(file, original.replace(/^title:\s*".*?"\s*$/m, `title: ${JSON.stringify(best)}`), "utf8");

  const qa = qaCheck(file);
  if (!qa.ok) {
    copyFileSync(bak, file);
    rmSync(bak, { force: true });
    console.log(`    ROLLED BACK: qa-check failed (${qa.summary}); the file is byte-identical to before.`);
    continue;
  }
  rmSync(bak, { force: true });
  console.log(`    WROTE  : qa-check ${qa.summary}; backup removed`);
}

console.log("");
console.log(REWRITE
  ? "  Done. Article bodies were not touched - only the title line, checked by qa-check."
  : "  Nothing was written. Re-run with --rewrite to apply a title, or edit one by hand.");
