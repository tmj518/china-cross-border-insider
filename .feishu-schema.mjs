/**
 * Read the candidate tables' schemas and a sample of rows.
 *
 * Two tables could be the target: 内容选题管理表 (the one linked in the URL) and
 * 内容发布日历 (the name that matches "daily progress"). Choosing wrong would put
 * daily QA data into their topic-management sheet. So read both before deciding.
 *
 * Read-only.
 */
const APP_ID = "cli_aa4ad6d49975dcc6";
const APP_SECRET = "VVOR63QZPk4NleCYZoH73gxGsnprYjF1";
const APP_TOKEN = "C670bKbxdanRS9s36xucdqbWnUd";
const BASE = "https://open.feishu.cn/open-apis";

const j = async (url, init) => {
  const r = await fetch(url, init);
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { code: -1, raw: t.slice(0, 200) }; }
};

const tok = await j(`${BASE}/auth/v3/tenant_access_token/internal`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
});
if (tok.code !== 0) { console.log("token failed:", tok.msg); process.exit(1); }
const auth = { Authorization: `Bearer ${tok.tenant_access_token}`, "Content-Type": "application/json" };

const TABLES = [
  ["tblKkOMRWfhPpvLV", "内容选题管理表 (linked)"],
  ["tblQB9tNJ75JsrGo", "内容发布日历"],
  ["tblIMQWcRVfQX5eD", "进度"],
  ["tblC5MIEQZ58oZli", "发布记录"],
];

for (const [id, label] of TABLES) {
  console.log("\n" + "=".repeat(88));
  console.log(`${label}   ${id}`);
  console.log("=".repeat(88));

  // Fields.
  const f = await j(`${BASE}/bitable/v1/apps/${APP_TOKEN}/tables/${id}/fields?page_size=100`, { headers: auth });
  if (f.code !== 0) { console.log(`  fields failed: code=${f.code} ${f.msg}`); continue; }
  const fields = f.data?.items ?? [];
  console.log(`  fields (${fields.length}):`);
  for (const x of fields) {
    const opts = x.property?.options?.map((o) => o.name).slice(0, 8).join(" / ");
    console.log(`    ${String(x.type).padStart(3)}  ${x.field_name}${opts ? "   [" + opts + "]" : ""}`);
  }

  // A few rows, to see what is already in there.
  const r = await j(`${BASE}/bitable/v1/apps/${APP_TOKEN}/tables/${id}/records?page_size=3`, { headers: auth });
  if (r.code !== 0) { console.log(`  records failed: code=${r.code} ${r.msg}`); continue; }
  const recs = r.data?.items ?? [];
  console.log(`  total rows: ${r.data?.total ?? "?"}   sample ${recs.length}:`);
  for (const rec of recs) {
    const pairs = Object.entries(rec.fields || {}).slice(0, 7).map(([k, v]) => {
      let s = Array.isArray(v) ? v.map((z) => (typeof z === "object" ? z.text ?? JSON.stringify(z) : z)).join("+") : String(v);
      if (typeof v === "object" && v !== null && !Array.isArray(v)) s = v.text ?? JSON.stringify(v);
      return `${k}=${s.slice(0, 30)}`;
    });
    console.log(`    - ${pairs.join("  ")}`);
  }
}
