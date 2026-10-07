import fs from 'node:fs';
const d='src/content/blog';
const now=new Date();
const mon=new Date(now); mon.setUTCDate(now.getUTCDate()-((now.getUTCDay()||7)-1));
const w=mon.toISOString().slice(0,10);
const cats=['trade-policy','platforms','supply-chain','sourcing','logistics'];
const seen={};
const rows=[];
for(const f of fs.readdirSync(d).filter(x=>x.endsWith('.md'))){
  const raw=fs.readFileSync(d+'/'+f,'utf8');
  if(/^draft:\s*true/m.test(raw)) continue;
  const dt=(/^publishDate:\s*"?(\d{4}-\d{2}-\d{2})/m.exec(raw)||[])[1];
  const c=(/^category:\s*"?([a-z-]+)/m.exec(raw)||[])[1];
  if(dt && dt>=w) seen[c]=(seen[c]||0)+1;
  const g=(re)=>{const m=re.exec(raw); return m?m[1]:'';};
  rows.push({f,cat:c,pub:dt||'',upd:g(/^updatedDate:\s*"?(\d{4}-\d{2}-\d{2})/m),rev:g(/^reviewBy:\s*"?(\d{4}-\d{2}-\d{2})/m),num:g(/^articleNumber:\s*"?(\d+)/m)});
}
console.log('today', now.toISOString().slice(0,10), 'week start', w);
for(const c of cats) console.log('  '+c.padEnd(14), seen[c]||0, (seen[c]?'':'  <- GAP'));
console.log('--- all articles by reviewBy ---');
rows.sort((a,b)=>(a.rev||'9999-99-99').localeCompare(b.rev||'9999-99-99'));
for(const r of rows) console.log([r.num||'-', r.cat.padEnd(13), 'pub='+r.pub, 'upd='+(r.upd||'-'), 'reviewBy='+(r.rev||'NONE'), r.f].join('  '));
