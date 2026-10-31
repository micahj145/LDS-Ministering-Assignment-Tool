// node compare.js results-baseline.json results-<new>.json
// Lists every check whose pass/fail or observed value differs. Access-rule
// ("security") differences are listed separately: the hardening is meant to change those.
const fs = require('fs');
const [a, b] = process.argv.slice(2).map(f => JSON.parse(fs.readFileSync(f, 'utf8')));
const key = r => r.group + ' :: ' + r.name;
const A = new Map(a.results.map(r => [key(r), r])), B = new Map(b.results.map(r => [key(r), r]));
const diffs = { feature: [], security: [], info: [] };
for (const [k, r] of A) {
  const s = B.get(k);
  if (!s) { diffs[r.kind].push(`MISSING  ${k}`); continue; }
  if (r.pass !== s.pass) diffs[r.kind].push(`${r.pass ? 'PASS→FAIL' : 'FAIL→PASS'}  ${k}  ${JSON.stringify(s.obs)}`);
  else if (JSON.stringify(r.obs) !== JSON.stringify(s.obs)) diffs[r.kind].push(`CHANGED  ${k}\n     was ${JSON.stringify(r.obs)}\n     now ${JSON.stringify(s.obs)}`);
}
for (const [k, s] of B) if (!A.has(k)) diffs[s.kind].push(`NEW  ${k}  ${s.pass ? 'PASS' : 'FAIL'} ${JSON.stringify(s.obs)}`);
console.log(`${a.label} vs ${b.label}`);
for (const k of ['feature', 'security', 'info']) { console.log(`\n${k}: ${diffs[k].length} difference(s)`); diffs[k].forEach(d => console.log('  ' + d)); }
process.exit(diffs.feature.length ? 1 : 0);
