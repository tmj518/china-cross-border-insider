// Fetch a URL, strip HTML, print body text + save to file. node fetchtext.cjs <url> [outfile] [--main]
const fs = require('fs');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
function get(url, redirects = 0) {
  return new Promise((resolve) => {
    if (redirects > 6) return resolve({ url, status: 0, body: '' });
    const https = require('https');
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname, path: u.pathname + u.search, timeout: 45000,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,*/*', 'Accept-Language': 'en-US,en;q=0.9' },
    }, (r) => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location) {
        r.resume(); return resolve(get(new URL(r.headers.location, url).href, redirects + 1));
      }
      let d = ''; r.setEncoding('utf8'); r.on('data', c => d += c);
      r.on('end', () => resolve({ url, status: r.statusCode, body: d, headers: r.headers }));
    });
    req.on('error', e => resolve({ url, status: 0, body: '', err: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ url, status: 0, body: '', err: 'timeout' }); });
  });
}
function textOf(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&quot;|&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"').replace(/&hellip;/g, '…')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}
(async () => {
  const [url, out, ...flags] = process.argv.slice(2);
  const r = await get(url);
  if (r.status !== 200) { console.log('STATUS', r.status, url, r.err || ''); return; }
  let html = r.body;
  if (flags.includes('--main')) {
    const m = html.match(/<article[\s\S]*?<\/article>/i) || html.match(/<main[\s\S]*?<\/main>/i);
    if (m) html = m[0];
  }
  const t = textOf(html);
  const words = (t.match(/[A-Za-z0-9][A-Za-z0-9'’\-]*/g) || []).length;
  console.log('STATUS 200 | words=' + words + ' | chars=' + t.length + ' | ' + url);
  if (out) { fs.writeFileSync(out, t); console.log('saved', out); }
  else console.log(t.slice(0, 20000));
})();
