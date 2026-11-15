#!/usr/bin/env node
// Checks demo.html in headless Chromium: it loads as each demo person, makes
// no request outside this machine, saves edits, keeps them across "View as",
// signs in through the real form, and "Reset demo" restores the invented ward.
//   node demo/build.js && node demo/check.js
// Playwright: PW_CORE=/path/to/playwright (default: require('playwright')).
const http = require('http'), fs = require('fs'), path = require('path');
const { chromium } = require(process.env.PW_CORE || 'playwright');
const root = path.join(__dirname, '..');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };
const server = http.createServer((req, res) => {
  const f = path.join(root, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const BASE = 'http://127.0.0.1:' + server.address().port + '/';
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const outside = new Set();
  await ctx.route('**/*', r => { const u = r.request().url(); if (u.startsWith(BASE)) return r.continue(); outside.add(new URL(u).host); return r.abort(); });
  const p = await ctx.newPage();
  const errors = [];
  p.on('pageerror', e => errors.push(e.message));
  p.on('dialog', d => d.accept());
  const results = [];
  const check = (name, pass, obs) => { results.push(pass); console.log((pass ? 'PASS  ' : 'FAIL  ') + name + (pass ? '' : '  ' + JSON.stringify(obs))); };
  const state = () => p.evaluate(() => ({ shell: document.getElementById('app-shell').style.display, user: _currentUserName, role: _currentUserRole, admin: _currentUserIsAdmin, m: S.members.length, h: S.households.length }));

  await p.goto(BASE + 'demo.html'); await p.waitForTimeout(2000);
  let s = await state();
  check('opens as the EQ president with the invented ward', s.shell === 'block' && s.user === 'Sam Carter' && s.role === 'eq' && s.m > 20 && s.h > 10, s);
  check('demo banner shown', await p.isVisible('#demo-bar'), null);

  for (const [uid, role, admin] of [['dRs', 'rs', false], ['dBish', 'bishopric', false], ['dCouncil', 'council', false], ['dAdmin', 'council', true]]) {
    await p.selectOption('#demo-as', uid); await p.waitForTimeout(1800);
    s = await state();
    check('view as ' + uid, s.shell === 'block' && s.role === role && s.admin === admin, s);
  }
  await p.evaluate(() => showTab('admin')); await p.waitForTimeout(800);
  check('admin tab lists the demo users', await p.evaluate(() => document.querySelectorAll('#tab-admin .ts-status').length >= 5), null);

  await p.selectOption('#demo-as', 'dEq'); await p.waitForTimeout(1800);
  await p.evaluate(async () => {
    const hh = S.households.find(h => h.id === 'h5');
    hh.notes = (hh.notes || []).concat([{ id: 'check-note', author: _currentUserName, authorId: _currentUserId, text: 'Demo edit check', date: new Date().toISOString() }]);
    S.proposed[0].households = S.proposed[0].households.concat(['h12']);
    await runSync();
  });
  check('edits save', await p.evaluate(() => _lastSyncOk), null);
  await p.selectOption('#demo-as', 'dBish'); await p.waitForTimeout(1800);
  const kept = await p.evaluate(() => ({ note: (S.households.find(h => h.id === 'h5').notes || []).some(n => n.id === 'check-note'), draft: S.proposed[0].households.includes('h12') }));
  check('edits kept across View as', kept.note && kept.draft, kept);

  await p.click('text=Sign Out'); await p.waitForTimeout(1000);
  check('sign out shows the sign-in form', await p.evaluate(() => document.getElementById('auth-screen').style.display === 'block'), null);
  await p.fill('#auth-email', 'rita.ames@example.com'); await p.fill('#auth-password', 'anything'); await p.click('#auth-submit-btn'); await p.waitForTimeout(1800);
  s = await state();
  check('signs in with a demo email', s.shell === 'block' && s.user === 'Rita Ames', s);

  await p.click('#demo-reset'); await p.waitForTimeout(1800);
  const reset = await p.evaluate(() => ({ user: _currentUserName, note: (S.households.find(h => h.id === 'h5').notes || []).some(n => n.id === 'check-note'), draft: S.proposed[0].households.includes('h12') }));
  check('Reset demo restores the invented ward', reset.user === 'Sam Carter' && !reset.note && !reset.draft, reset);

  for (const t of ['members', 'households', 'nearby', 'brothers', 'current', 'propose', 'sisters', 'currentRS', 'proposeRS', 'council', 'moves', 'idents', 'stats', 'notifications', 'messages', 'import']) {
    try { await p.evaluate(t => showTab(t), t); await p.waitForTimeout(150); } catch (e) { errors.push('tab ' + t + ': ' + e.message); }
  }
  check('every tab opens without a script error', errors.length === 0, errors.slice(0, 5));
  check('no request leaves this machine', outside.size === 0, [...outside]);

  await browser.close(); server.close();
  const failed = results.filter(x => !x).length;
  console.log(`${results.length - failed}/${results.length} demo checks passed`);
  process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
