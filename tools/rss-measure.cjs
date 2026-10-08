// Measure word count of each item's content in an RSS/Atom feed.
const fs = require('fs');
const https = require('https');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
function get(url, redirects = 0) {
  return new Promise((resolve) => {
    if (redirects > 6) return resolve({ url, status: 0, body: '' });
    const u = new URL(url);
    const req = https.get({ hostname: u.hostname, path: u.pathname + u.search, timeout: 45000, headers: { 'User-Agent': UA, 'Accept': '*/*' } }, (r) => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location) { r.resume(); return resolve(get(new URL(r.headers.location, url).href, redirects + 1)); }
      let d = ''; r.setEncoding('utf8'); r.on('data', c => d += c);
      r.on('end', () => resolve({ url, status: r.statusCode, body: d }));
    });
    req.on('error', e => resolve({ url, status: 0, body: '', err: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ url, status: 0, body: '', err: 'timeout' }); });
  });
}
function strip(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&#8217;|&rsquo;|&#39;/g, "'").replace(/&quot;|&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}
const W = s => (s.match(/[A-Za-z0-9][A-Za-z0-9'’\-]*/g) || []).length;
(async () => {
  const lines = fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
  for (const line of lines) {
    const [url, out] = line.split('|');
    const r = await get(url.trim());
    if (r.status !== 200) { console.log('FAIL', r.status, url); continue; }
    const items = r.body.split(/<item[ >]/).slice(1);
    const entries = r.body.split(/<entry[ >]/).slice(1);
    const blocks = items.length ? items : entries;
    let acc = '';
    const rows = [];
    for (const b of blocks) {
      const t = ((b.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [, '?'])[1] || '').replace(/\s+/g, ' ').trim();
      const content = (b.match(/<content:encoded>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content:encoded>/) || b.match(/<content[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/content>/) || [, ''])[1];
      const w = W(strip(content));
      rows.push(w);
      acc += t + '\n' + strip(content) + '\n\n---\n\n';
    }
    fs.writeFileSync(out.trim(), acc);
    const n = rows.length, sum = rows.reduce((a, b) => a + b, 0);
    rows.sort((a, b) => a - b);
    console.log(out.trim().padEnd(34), 'items=' + n, 'median=' + rows[Math.floor(n / 2)], 'mean=' + Math.round(sum / n), 'min=' + rows[0], 'max=' + rows[n - 1], '| all:', rows.join(','));
  }
})();
