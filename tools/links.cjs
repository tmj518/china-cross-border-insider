// Extract links matching a filter from a URL. node links.cjs <url> <regex>
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
(async () => {
  const [url, re] = process.argv.slice(2);
  const r = await get(url);
  console.log('STATUS', r.status, url);
  if (r.status !== 200) return;
  const rx = new RegExp(re, 'gi');
  const set = new Set();
  let m;
  while ((m = rx.exec(r.body))) set.add(m[1] || m[0]);
  console.log([...set].slice(0, 40).join('\n'));
})();
