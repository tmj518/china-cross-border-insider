// Aggregate word count by section kind across published (non-draft) articles.
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'src', 'content', 'blog');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.md'));
const wc = s => (s.match(/[A-Za-z0-9][A-Za-z0-9'’%.\-/$]*/g) || []).length;

function kindOf(h) {
  const l = h.toLowerCase();
  if (/^ai summary/.test(l)) return 'AI Summary';
  if (/faq|frequently asked/.test(l)) return 'FAQ';
  if (/calculat|worked example|the maths|the math|how the number/.test(l)) return 'Calculation';
  if (/^for you|what to do|advice|checklist/.test(l)) return 'For you (advice)';
  if (/^the data point/.test(l)) return 'Data point';
  if (/^the point|bottom line/.test(l)) return 'The point';
  if (/^what happened|^why now|^so what/.test(l)) return 'Narrative core';
  return 'Other';
}

const rows = [];
for (const f of files) {
  const raw = fs.readFileSync(path.join(dir, f), 'utf8');
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const fm = m ? m[1] : '';
  if (/^draft:\s*true/m.test(fm)) continue;
  const body = m ? raw.slice(m[0].length) : raw;
  const nFig = (fm.match(/^\s*-\s+value:/gm) || []).length;
  const secs = {};
  let cur = 'Intro';
  for (const ln of body.split(/\r?\n/)) {
    const h = ln.match(/^##\s+(.*)$/);
    if (h) cur = kindOf(h[1].trim());
    secs[cur] = (secs[cur] || 0) + wc(ln);
  }
  const total = Object.values(secs).reduce((a, b) => a + b, 0);
  rows.push({ f: f.replace(/\.md$/, ''), total, secs, nFig });
}
const kinds = ['Intro', 'AI Summary', 'Narrative core', 'Data point', 'Calculation', 'FAQ', 'For you (advice)', 'The point', 'Other'];
const totals = {};
for (const r of rows) for (const [k, v] of Object.entries(r.secs)) totals[k] = (totals[k] || 0) + v;
const grand = Object.values(totals).reduce((a, b) => a + b, 0);
console.log('published non-draft articles:', rows.length);
console.log('grand total words:', grand);
console.log('\nkind\ttotal\tper-article\t% of total');
for (const k of kinds) if (totals[k] !== undefined) console.log(`${k}\t${totals[k]}\t${Math.round(totals[k] / rows.length)}\t${(100 * totals[k] / grand).toFixed(1)}%`);
console.log('\nfigures: total=' + rows.reduce((a, r) => a + r.nFig, 0) + ' mean=' + (rows.reduce((a, r) => a + r.nFig, 0) / rows.length).toFixed(1) + ' min=' + Math.min(...rows.map(r => r.nFig)) + ' max=' + Math.max(...rows.map(r => r.nFig)));
const sorted = rows.map(r => r.total).sort((a, b) => a - b);
console.log('article words: min=' + sorted[0] + ' median=' + ((sorted[10] + sorted[11]) / 2) + ' max=' + sorted[sorted.length - 1] + ' mean=' + Math.round(grand / rows.length));
console.log('\nper article detail:');
for (const r of rows.sort((a, b) => b.total - a.total)) {
  console.log(r.total + '\tfig=' + r.nFig + '\tFAQ=' + (r.secs['FAQ'] || 0) + '\tAI=' + (r.secs['AI Summary'] || 0) + '\tcalc=' + (r.secs['Calculation'] || 0) + '\tadvice=' + (r.secs['For you (advice)'] || 0) + '\t' + r.f);
}
