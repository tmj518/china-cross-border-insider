/**
 * Feishu (Lark) Bitable API — credentials test and target discovery.
 *
 * The operator supplied an app id, secret, a wiki token and an app token. Before
 * writing anything, confirm the credentials work and find out what the target table
 * actually looks like — its fields and its existing rows. Writing blind into a table
 * that already holds their content-topic data would be worse than not writing.
 *
 * Nothing here writes. It reads: token, then table metadata, then fields, then a
 * sample of existing rows.
 */
const APP_ID = "cli_aa4ad6d49975dcc6";
const APP_SECRET = "VVOR63QZPk4NleCYZoH73gxGsnprYjF1";
const WIKI_TOKEN = "XzN1wYLs7iyPvck2wrCca02KnWd";
const APP_TOKEN = "C670bKbxdanRS9s36xucdqbWnUd";
const TABLE_FROM_URL = "tblKkOMRWfhPpvLV";

const BASE = "https://open.feishu.cn/open-apis";

const j = async (url, init) => {
  const r = await fetch(url, init);
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text) }; }
  catch { return { status: r.status, body: { raw: text.slice(0, 300) } }; }
};

console.log("FEISHU CONNECTION TEST\n" + "=".repeat(76));

// 1. Tenant access token.
const tok = await j(`${BASE}/auth/v3/tenant_access_token/internal`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
});
console.log(`\n1. tenant_access_token  HTTP ${tok.status}`);
if (tok.body.code !== 0) {
  console.log(`   FAILED  code=${tok.body.code}  msg=${tok.body.msg}`);
  console.log("   -> the credentials are wrong, the app is not enabled, or the network blocks open.feishu.cn");
  process.exit(1);
}
const token = tok.body.tenant_access_token;
console.log(`   ok  token acquired (${String(token).slice(0, 12)}..., expires in ${tok.body.expire}s)`);

const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

// 2. Resolve the wiki node to a real app token, since a wiki token is not one.
console.log(`\n2. wiki node ${WIKI_TOKEN}`);
const node = await j(`${BASE}/wiki/v2/spaces/get_node?token=${WIKI_TOKEN}`, { headers: auth });
console.log(`   HTTP ${node.status}  code=${node.body.code} ${node.body.msg ?? ""}`);
if (node.body.code === 0) {
  const n = node.body.data?.node ?? {};
  console.log(`   obj_type=${n.obj_type}  obj_token=${n.obj_token}  title=${n.title}`);
  if (n.obj_token && n.obj_token !== APP_TOKEN) {
    console.log(`   NOTE: the node's obj_token differs from the supplied app_token`);
    console.log(`         supplied: ${APP_TOKEN}`);
    console.log(`         node    : ${n.obj_token}`);
  }
} else {
  console.log("   (the wiki token could not be resolved; the app may lack wiki permission)");
}

// 3. List the tables in the app, to find the right one.
console.log(`\n3. tables in app_token ${APP_TOKEN}`);
const tables = await j(`${BASE}/bitable/v1/apps/${APP_TOKEN}/tables?page_size=50`, { headers: auth });
console.log(`   HTTP ${tables.status}  code=${tables.body.code} ${tables.body.msg ?? ""}`);
if (tables.body.code === 0) {
  const items = tables.body.data?.items ?? [];
  console.log(`   ${items.length} table(s):`);
  for (const t of items) console.log(`     ${t.table_id}  ${t.name}`);
} else {
  console.log("   could not list tables");
}
