// For each RSS feed URL, print first N item links.
const https = require('https');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
function get(url, redirects = 0) {
  return new Promise((resolve) => {
    if (redirects > 6) return resolve({ url, status: 0, body: '' });
    const u = new URL(url);
    const req = https.get({ hostname: u.hostname, path: u.pathname + u.search, timeout: 45000, headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml,application/xml,text/xml,*/*' } }, (r) => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location) { r.resume(); return resolve(get(new URL(r.headers.location, url).href, redirects + 1)); }
      let d = ''; r.setEncoding('utf8'); r.on('data', c => d += c);
      r.on('end', () => resolve({ url, status: r.statusCode, body: d }));
    });
    req.on('error', e => resolve({ url, status: 0, body: '', err: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ url, status: 0, body: '', err: 'timeout' }); });
  });
}
(async () => {
  const feeds = require('fs').readFileSync(process.argv[2], 'utf8').split(/\r?\n/).filter(l => l.trim() && !l.startsWith('#'));
  for (const f of feeds) {
    const r = await get(f.trim());
    if (r.status !== 200) { console.log('FAIL', r.status, f); continue; }
    const items = r.body.split(/<item[ >]/).slice(1);
    const entries = r.body.split(/<entry[ >]/).slice(1);
    const blocks = items.length ? items : entries;
    console.log('\n===== ' + f.trim() + '  (items: ' + blocks.length + ')');
    for (const b of blocks.slice(0, 6)) {
      const t = (b.match(/<title[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/) || [, '?'])[1].replace(/\s+/g, ' ').trim();
      const l = (b.match(/<link[^>]*href="([^"]+)"/) || b.match(/<link>([\s\S]*?)<\/link>/) || [, '?'])[1].trim();
      const d = (b.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || b.match(/<published>([\s\S]*?)<\/published>/) || b.match(/<updated>([\s\S]*?)<\/updated>/) || [, '?'])[1].trim();
      console.log(l + '\t' + d + '\t' + t.slice(0, 70));
    }
  }
})();
