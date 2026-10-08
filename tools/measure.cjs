// Fetch URLs and measure article length + structure. Usage: node measure.cjs urls.txt
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';

function get(url, redirects = 0) {
  return new Promise((resolve) => {
    if (redirects > 6) return resolve({ url, status: 0, body: '' });
    const https = require('https');
    const u = new URL(url);
    const req = https.get({
      hostname: u.hostname, path: u.pathname + u.search, headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      }, timeout: 45000,
    }, (r) => {
      if ([301, 302, 303, 307, 308].includes(r.statusCode) && r.headers.location) {
        r.resume();
        return resolve(get(new URL(r.headers.location, url).href, redirects + 1));
      }
      let d = '';
      r.setEncoding('utf8');
      r.on('data', (c) => { d += c; });
      r.on('end', () => resolve({ url, status: r.statusCode, body: d }));
    });
    req.on('error', (e) => resolve({ url, status: 0, body: '', err: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ url, status: 0, body: '', err: 'timeout' }); });
  });
}

function extractMain(html) {
  let h = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<aside[\s\S]*?<\/aside>/gi, ' ')
    .replace(/<form[\s\S]*?<\/form>/gi, ' ');
  // try to focus on article/main body
  const m = h.match(/<article[\s\S]*?<\/article>/i) || h.match(/<main[\s\S]*?<\/main>/i);
  if (m && m[0].length > 1500) h = m[0];
  return h;
}

function textOf(html) {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"').replace(/&hellip;/g, '…')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ').trim();
}

const words = (s) => (s.match(/[A-Za-z0-9][A-Za-z0-9'’\-]*/g) || []).length;

(async () => {
  const list = fs.readFileSync(process.argv[2], 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#'));
  const out = [];
  for (const url of list) {
    const r = await get(url);
    if (r.status !== 200 || !r.body) { out.push({ url, status: r.status, err: r.err }); console.log(JSON.stringify({ url, status: r.status, err: r.err })); continue; }
    const raw = r.body;
    const main = extractMain(raw);
    const t = textOf(main);
    const tAll = textOf(raw);
    const h2 = (main.match(/<h2[\s>]/gi) || []).length;
    const h3 = (main.match(/<h3[\s>]/gi) || []).length;
    const tables = (main.match(/<table[\s>]/gi) || []).length;
    const imgs = (main.match(/<img[\s>]/gi) || []).length;
    const links = (main.match(/<a\s[^>]*href="https?:/gi) || []).length;
    const title = (raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1].replace(/\s+/g, ' ').trim();
    const rec = { url, status: 200, title: title.slice(0, 110), wordsMain: words(t), wordsFull: words(tAll), h2, h3, tables, imgs, extLinks: links };
    out.push(rec);
    console.log(JSON.stringify(rec));
  }
  fs.writeFileSync(process.argv[3] || 'measure-out.json', JSON.stringify(out, null, 1));
})();
