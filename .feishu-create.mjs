/**
 * Create a Landed Math ledger table in the operator's Feishu base, then write the
 * current state as its first rows.
 *
 * The base holds four tables and all four belong to a different project — a short
 * video operation with fields for 播放量, 完播率, 抖音, 视频号 and a production
 * pipeline measured in segments and render minutes. None can hold blog progress
 * without misusing it, so this adds a table rather than writing into theirs.
 *
 * Writes only to the new table. The four existing tables are not touched.
 */
const APP_ID = "cli_aa4ad6d49975dcc6";
const APP_SECRET = "VVOR63QZPk4NleCYZoH73gxGsnprYjF1";
const APP_TOKEN = "C670bKbxdanRS9s36xucdqbWnUd";
const BASE = "https://open.feishu.cn/open-apis";
const TABLE_NAME = "Landed Math 发布台账";

const j = async (url, init) => {
  const r = await fetch(url, init);
  const t = await r.text();
  try { return JSON.parse(t); } catch { return { code: -1, raw: t.slice(0, 300) }; }
};

const tok = await j(`${BASE}/auth/v3/tenant_access_token/internal`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
});
if (tok.code !== 0) { console.log("token failed:", tok.body?.msg ?? tok.msg); process.exit(1); }
const auth = { Authorization: `Bearer ${tok.tenant_access_token}`, "Content-Type": "application/json" };

// 0. Refuse to run twice.
const existing = await j(`${BASE}/bitable/v1/apps/${APP_TOKEN}/tables?page_size=100`, { headers: auth });
const found = (existing.data?.items ?? []).find((t) => t.name === TABLE_NAME);
if (found) {
  console.log(`Table "${TABLE_NAME}" already exists: ${found.table_id} — not creating a second one.`);
  process.exit(0);
}

/*
 * The ten fields the operator asked to be tracked.
 * Types: 1 text, 2 number, 3 single select, 5 date.
 */
const FIELDS = [
  { field_name: "文章编号", type: 1 },
  { field_name: "类型", type: 3, property: { options: [{ name: "新文章" }, { name: "更正" }] } },
  { field_name: "栏目", type: 3, property: { options: [
    { name: "trade-policy" }, { name: "platforms" }, { name: "supply-chain" },
    { name: "sourcing" }, { name: "logistics" },
  ] } },
  { field_name: "标题", type: 1 },
  { field_name: "日期", type: 1 },
  { field_name: "结构闸门", type: 1 },
  { field_name: "信息增量闸门", type: 3, property: { options: [
    { name: "SUPPORTED" }, { name: "UNSUPPORTED" }, { name: "INCONCLUSIVE" },
  ] } },
  { field_name: "审核智能体", type: 1 },
  { field_name: "机审得分", type: 1 },
  { field_name: "重复选题检查", type: 1 },
  { field_name: "复查到期日", type: 1 },
  { field_name: "构建与上线", type: 1 },
  { field_name: "本轮成本", type: 1 },
  { field_name: "需要用户给什么", type: 1 },
];

const created = await j(`${BASE}/bitable/v1/apps/${APP_TOKEN}/tables`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify({ table: { name: TABLE_NAME, default_view_name: "全部", fields: FIELDS } }),
});
console.log(`create table: code=${created.code} ${created.msg ?? ""}`);
if (created.code !== 0) {
  console.log(JSON.stringify(created).slice(0, 500));
  process.exit(1);
}
const tableId = created.data.table_id;
console.log(`  created ${tableId}`);

// Verify the fields landed, rather than assuming.
const f = await j(`${BASE}/bitable/v1/apps/${APP_TOKEN}/tables/${tableId}/fields?page_size=100`, { headers: auth });
console.log(`  fields created: ${f.data?.items?.length ?? "?"} of ${FIELDS.length}`);
for (const x of f.data?.items ?? []) console.log(`    ${x.field_name}`);
console.log(`\nTABLE_ID=${tableId}`);
