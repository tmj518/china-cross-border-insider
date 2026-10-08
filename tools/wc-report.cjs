// Count body word counts of landedmath articles, split by section and content type.
// Word = whitespace-delimited token (markdown prose, English text).
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'src', 'content', 'blog');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));

function stripFm(txt) {
  const m = txt.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fm: '', body: txt };
  return { fm: m[1], body: txt.slice(m[0].length) };
}

function wc(s) {
  return (s.match(/[A-Za-z0-9][A-Za-z0-9'’%.\-/$]*/g) || []).length;
}

const rows = [];
let totAll = 0, totProse = 0, totTable = 0, totFaq = 0, totCalc = 0, totFig = 0, totCallout = 0;

for (const f of files) {
  const raw = fs.readFileSync(path.join(dir, f), 'utf8');
  // count source figures from frontmatter (figures: array)
  const { fm, body } = stripFm(raw);
  const nFig = (fm.match(/^\s{2,}-\s+id:/gm) || []).length || (fm.match(/^\s*-\s+id:/gm) || []).length;

  // split body into h2 sections
  const lines = body.split(/\r?\n/);
  let cur = '__intro__';
  const sec = {};
  for (const ln of lines) {
    const h = ln.match(/^##\s+(.*)$/);
    if (h) cur = h[1].trim();
    (sec[cur] = sec[cur] || []).push(ln);
  }

  let prose = 0, table = 0, faq = 0, calc = 0, callout = 0, list = 0;
  let inTable = false;
  for (const [name, ls] of Object.entries(sec)) {
    const low = name.toLowerCase();
    const isFaq = /faq|frequently asked|questions/.test(low);
    const isCalc = /calculat|cost per unit|per-unit|worked example|how the number/.test(low);
    for (const ln of ls) {
      const isTableLine = /^\s*\|/.test(ln);
      if (isTableLine) { table += wc(ln); continue; }
      if (/^\s*>/.test(ln)) { callout += wc(ln); continue; }
      if (/^\s*[-*]\s+/.test(ln) || /^\s*\d+\.\s+/.test(ln)) { list += wc(ln); continue; }
      if (isFaq) faq += wc(ln);
      else if (isCalc) calc += wc(ln);
      else prose += wc(ln);
    }
  }
  const total = prose + table + faq + calc + callout + list;
  totAll += total; totProse += prose; totTable += table; totFaq += faq; totCalc += calc; totFig += nFig;
  totCallout += callout;
  rows.push({ f, total, prose, list, table, faq, calc, callout, figures: nFig, h2: Object.keys(sec).length - 1 });
}

rows.sort((a, b) => b.total - a.total);
console.log('file\ttotal\tprose\tlist\ttable\tfaq\tcalc\tcallout\tfigures\th2');
for (const r of rows) {
  console.log([r.f.replace(/\.md$/, ''), r.total, r.prose, r.list, r.table, r.faq, r.calc, r.callout, r.figures, r.h2].join('\t'));
}
const n = rows.length;
const avg = Math.round(totAll / n);
const sorted = rows.map(r => r.total).sort((a, b) => a - b);
const med = sorted[Math.floor(n / 2)];
console.log('\n--- aggregate ---');
console.log('articles:', n);
console.log('total words (all):', totAll, 'avg:', avg, 'median:', med, 'min:', sorted[0], 'max:', sorted[n - 1]);
console.log('prose:', totProse, (100 * totProse / totAll).toFixed(1) + '%');
console.log('table:', totTable, (100 * totTable / totAll).toFixed(1) + '%');
console.log('faq:', totFaq, (100 * totFaq / totAll).toFixed(1) + '%');
console.log('calc:', totCalc, (100 * totCalc / totAll).toFixed(1) + '%');
console.log('callout:', totCallout, (100 * totCallout / totAll).toFixed(1) + '%');
console.log('figures total:', totFig, 'avg per article:', (totFig / n).toFixed(1));
