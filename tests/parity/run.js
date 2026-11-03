// Parity suite: drives the real app (served locally, unchanged) against the
// Firebase emulators with synthetic data, and records what each feature does.
// Run via run.sh (which starts the emulators and seeds them).
//
//   node run.js <label> [appFile]
//
// Writes results-<label>.json: one entry per check with pass/fail and an
// "obs" value (what was observed) so two versions of the app can be diffed.
// Checks tagged kind:'security' describe today's access behaviour; the
// hardening work is expected to change those on purpose.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { chromium } = require(process.env.PW_CORE || '/home/claude/mt/node_modules/playwright-core');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const LABEL = process.argv[2] || 'baseline';
const APP_FILE = process.argv[3] || 'ministering_tool.html';
const BASE = 'http://127.0.0.1:8766/';
const SDK = process.env.FB_SDK_DIR || path.join(__dirname, '..', '..', 'fbpkg', 'package');   // npm firebase@12.18.0 (compat builds)
const PDFJS = process.env.PDFJS_DIR || '/home/claude/mt/node_modules/pdfjs-dist/build/';     // pdfjs-dist@3.11.174
const HOOK = fs.readFileSync(path.join(__dirname, 'emuhook.js'), 'utf8');
const REAL_PDF_DIR = process.env.REAL_PDF_DIR || '';
const PW = 'parity-pass-1';

initializeApp({ projectId: 'demo-parity' });
const adb = getFirestore();
const results = [];
const blocked = new Set();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hash = s => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 10);

function rec(group, name, pass, obs, kind = 'feature') {
  results.push({ group, name, kind, pass: !!pass, obs });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${group}] ${name}${obs !== undefined ? '  ' + JSON.stringify(obs).slice(0, 160) : ''}`);
}
async function check(group, name, fn, kind) {
  if (process.env.ONLY && !new RegExp(process.env.ONLY).test(group)) return { pass: true };
  pushSince = Date.now();
  // A check that hangs fails after 2 minutes instead of stalling the whole run.
  try { const r = await Promise.race([fn(), sleep(120000).then(() => { throw new Error('timed out after 2 minutes'); })]); rec(group, name, r.pass, r.obs, kind); return r; }
  catch (e) { rec(group, name, false, { error: e.message.split('\n')[0] }, kind); return { pass: false }; }
}
async function until(fn, ms = 15000) {
  const t0 = Date.now(); let v;
  while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await sleep(300); }
  return v;
}
const wardRaw = async () => (await adb.doc('wardData/shared').get()).data();
// The ward data with notes in place, wherever they're stored (inside the
// document in the old version, notes/{id} in the new) — same shape for both.
const { insertNotes } = require('../../functions/access');
const ward = async () => insertNotes(await wardRaw(), (await adb.collection('notes').get()).docs.map(d => ({ ...d.data(), id: d.id })));
const profile = async uid => (await adb.doc('profiles/' + uid).get()).data();
let pushSince = 0;   // each check only looks at pushes sent after it started
const pushesFor = async tok => (await adb.collection('__pushLog').get()).docs.map(d => d.data()).filter(p => p.tokens.includes(tok) && p.at >= pushSince);

let browser;
async function open(email, opts = {}) {
  const ctx = await browser.newContext({ viewport: opts.phone ? { width: 390, height: 844 } : { width: 1280, height: 900 } });
  await ctx.route('**/*', async r => {
    const u = r.request().url();
    if (u.includes('/firebasejs/')) {
      const f = u.split('/').pop().split('?')[0];
      let body = fs.readFileSync(path.join(SDK, f), 'utf8');
      if (f === 'firebase-messaging-compat.js') body += '\n' + HOOK;
      return r.fulfill({ contentType: 'text/javascript', body });
    }
    if (/cdnjs.*pdf\.(worker\.)?min\.js/.test(u)) return r.fulfill({ contentType: 'text/javascript', body: fs.readFileSync(PDFJS + (u.includes('worker') ? 'pdf.worker.min.js' : 'pdf.min.js'), 'utf8') });
    if (u.startsWith('http://127.0.0.1') || u.startsWith('http://localhost')) return r.continue();
    blocked.add(new URL(u).host); return r.abort();
  });
  // Read by the modular bundle (vendor/firebase-12.18.0.js); the compat build ignores it.
  await ctx.addInitScript(() => { window.__FIREBASE_EMULATORS__ = { projectId: 'demo-parity', auth: 'http://127.0.0.1:9099', firestoreHost: '127.0.0.1', firestorePort: 8080, functionsHost: '127.0.0.1', functionsPort: 5001 }; });
  // Answers "Save these changes?" automatically (yes, unless a check sets
  // window.__confirmAnswer = 'no'), keeping what it showed in window.__lastConfirm.
  await ctx.addInitScript(() => {
    window.__confirmAnswer = 'yes'; window.__lastConfirm = null;
    setInterval(() => {
      const m = document.getElementById('chg-modal');
      if (!m || !m.classList.contains('open')) return;
      window.__lastConfirm = document.getElementById('chg-body').innerText;
      document.getElementById(window.__confirmAnswer === 'no' ? 'chg-cancel' : 'chg-ok').click();
    }, 50);
  });
  const page = await ctx.newPage();
  const s = { ctx, page, errors: [], dialogs: [], email };
  page.on('pageerror', e => s.errors.push(e.message));
  page.on('dialog', d => { s.dialogs.push(d.type() + ': ' + d.message().slice(0, 120)); d.type() === 'prompt' ? d.dismiss() : d.accept(); });
  await page.goto(BASE + APP_FILE);
  await page.waitForFunction(ids => ids.some(id => document.getElementById(id)?.style.display === 'block'), SCREENS, { timeout: 20000 });
  if (email) await signIn(s, email, opts.password || PW);
  return s;
}
// Screens the app can be on; the two-step ones exist only in the version with two-step sign-in.
const SCREENS = ['auth-screen', 'app-shell', 'pending-screen', 'mfa-signin-screen', 'mfa-enroll-screen'];
const waitScreen = (page, ids = SCREENS) => page.waitForFunction(ids => ids.some(id => document.getElementById(id)?.style.display === 'block')
  || (document.getElementById('auth-error')?.textContent || '').length > 0, ids, { timeout: 20000 });
// The newest code the Auth emulator "texted" to a phone number.
async function smsCode(phone, after = 0) {
  return until(async () => {
    const r = await fetch('http://127.0.0.1:9099/emulator/v1/projects/demo-parity/verificationCodes').then(r => r.json());
    const c = (r.verificationCodes || []).filter(v => v.phoneNumber === phone);
    return c.length > after ? c[c.length - 1].code : null;
  }, 10000);
}
async function codeCount(phone) {
  const r = await fetch('http://127.0.0.1:9099/emulator/v1/projects/demo-parity/verificationCodes').then(r => r.json());
  return (r.verificationCodes || []).filter(v => v.phoneNumber === phone).length;
}
const PHONES = { 'micahj145@gmail.com': '+15555550100', 'sam@example.com': '+15555550101', 'rita@example.com': '+15555550102', 'cora@example.com': '+15555550103' };
async function signIn(s, email, password, { code = true } = {}) {
  const { page } = s;
  const before = PHONES[email] ? await codeCount(PHONES[email]) : 0;
  await page.fill('#auth-email', email); await page.fill('#auth-password', password);
  await page.click('#auth-submit-btn');
  await waitScreen(page, ['app-shell', 'pending-screen', 'mfa-signin-screen', 'mfa-enroll-screen']);
  if (code && await screen(s) === 'mfa-signin-screen' && PHONES[email]) {
    const c = await smsCode(PHONES[email], before);
    await page.fill('#mfa-signin-code', c); await page.click('#mfa-signin-btn');
    await waitScreen(page, ['app-shell', 'pending-screen', 'auth-screen', 'mfa-enroll-screen']);
  }
  await sleep(500);
}
const ev = (s, fn, arg) => s.page.evaluate(fn, arg);
// Saves now, answering "Save these changes?" with yes (or no, with { confirm: false }).
// What the confirmation showed (null if it didn't ask) is kept in s.lastConfirm.
async function flush(s, { confirm = true } = {}) {
  await ev(s, a => { window.__confirmAnswer = a; }, confirm ? 'yes' : 'no');
  await ev(s, () => (typeof _syncTimer !== 'undefined' && _syncTimer) ? (clearTimeout(_syncTimer), runSync()) : null);
  s.lastConfirm = await ev(s, () => { const c = window.__lastConfirm; window.__lastConfirm = null; window.__confirmAnswer = 'yes'; return c; });
}
const screen = s => ev(s, ids => ids.find(id => document.getElementById(id)?.style.display === 'block'), SCREENS);
async function tryOp(s, code) {   // run a raw SDK call as this user; report allowed / denied
  return ev(s, async code => { try { await (new Function('return (async () => {' + code + '})()'))(); return 'allowed'; } catch (e) { return e.code || e.message; } }, code);
}

(async () => {
  let exe; try { exe = require('child_process').execSync('ls -d /opt/pw-browsers/chromium-*/chrome-linux/chrome 2>/dev/null').toString().trim().split('\n')[0]; } catch {}
  browser = await chromium.launch(exe ? { executablePath: exe } : {});

  // ── Auth ───────────────────────────────────────────────────
  const out = await open(null);
  await check('auth', 'signed-out shows sign-in', async () => ({ pass: await screen(out) === 'auth-screen', obs: await screen(out) }));
  await check('auth', 'wrong password shows error', async () => {
    await signIn(out, 'sam@example.com', 'wrong-pass'); const t = await ev(out, () => document.getElementById('auth-error').textContent);
    return { pass: t.length > 0 && await screen(out) === 'auth-screen', obs: !!t };
  });
  const states = {};
  for (const [email, want, title] of [['pete@example.com', 'pending-screen', 'Awaiting Approval'], ['dale@example.com', 'pending-screen', 'Access Denied'], ['val@example.com', 'pending-screen', null]]) {
    await check('auth', 'gate for ' + email.split('@')[0], async () => {
      const s = await open(email); const sc = await screen(s);
      const t = await ev(s, () => document.getElementById('pending-title').textContent);
      const verify = await ev(s, () => document.getElementById('verify-wrap').style.display === 'block');
      states[email] = s;
      return { pass: sc === want && (title ? t === title : verify), obs: { screen: sc, title: t, verify } };
    });
  }
  await check('auth', 'sign-up creates pending profile + verify screen + admin push', async () => {
    const s = await open(null);
    await ev(s, () => toggleAuthMode());
    await s.page.fill('#auth-first-name', 'Nia'); await s.page.fill('#auth-last-name', 'Newby');
    await s.page.fill('#auth-email', 'nia@example.com'); await s.page.fill('#auth-password', PW);
    await s.page.click('#auth-submit-btn');
    await s.page.waitForFunction(() => document.getElementById('pending-screen').style.display === 'block', null, { timeout: 20000 });
    const verify = await ev(s, () => document.getElementById('verify-wrap').style.display === 'block');
    const snap = await adb.collection('profiles').where('email', '==', 'nia@example.com').get();
    const p = snap.docs[0]?.data();
    const push = await until(async () => (await pushesFor('tok-uAdmin')).find(x => x.data.tag === 'ministering-access'));
    await s.ctx.close();
    return { pass: verify && p?.status === 'pending' && !!push, obs: { verify, status: p?.status, pushBody: push?.data?.body } };
  });

  // Someone signed in on the old version should still be signed in after the upgrade.
  if (process.env.UPGRADE_FROM) await check('upgrade', 'signed-in session carries over from ' + process.env.UPGRADE_FROM, async () => {
    const s = await open(null);
    await s.page.goto(BASE + process.env.UPGRADE_FROM); await s.page.waitForFunction(() => document.getElementById('auth-screen').style.display === 'block', null, { timeout: 20000 });
    await signIn(s, 'sam@example.com', PW); const before = await screen(s);
    await s.page.goto(BASE + APP_FILE);
    await s.page.waitForFunction(() => ['auth-screen', 'app-shell'].some(id => document.getElementById(id)?.style.display === 'block'), null, { timeout: 20000 });
    const after = await screen(s); const sdk = await ev(s, () => firebase.SDK_VERSION); await s.ctx.close();
    return { pass: before === 'app-shell' && after === 'app-shell', obs: { before, after, sdk } };
  }, 'info');

  // ── Sessions for the approved users ────────────────────────
  const A = await open('micahj145@gmail.com');
  const E = await open('sam@example.com');
  const R = await open('rita@example.com');
  const C = await open('cora@example.com');
  for (const [s, nm] of [[A, 'admin'], [E, 'eq'], [R, 'rs'], [C, 'council']]) {
    await check('auth', nm + ' signs in to app', async () => {
      const o = await ev(s, () => ({ m: S.members.length, h: S.households.length, role: _currentUserRole, admin: _currentUserIsAdmin, adminNav: document.getElementById('nav-admin-btn').style.display !== 'none', eq: canEditEQ(), rs: canEditRS() }));
      return { pass: await screen(s) === 'app-shell' && o.m === 12 && o.h === 8, obs: o };
    });
  }

  // ── Every tab renders (synthetic data only) ────────────────
  const TABS = ['import', 'notifications', 'messages', 'members', 'households', 'nearby', 'brothers', 'current', 'propose', 'sisters', 'currentRS', 'proposeRS', 'council', 'moves', 'idents', 'stats', 'admin'];
  for (const [s, nm] of [[A, 'admin'], [C, 'council'], [E, 'eq'], [R, 'rs']]) {
    for (const t of TABS) {
      await check('tabs:' + nm, t, async () => {
        const before = s.errors.length;
        const o = await ev(s, t => { showTab(t); const el = document.querySelector('.tab-content.active');
          const txt = el.innerText.replace(/\d+ (minute|hour|day|week|month)s? ago|just now|\b\d{1,2}:\d\d\s?[AP]M\b/gi, '~').replace(/\s+/g, ' ').trim();
          return { id: el.id, len: txt.length, txt, rows: el.querySelectorAll('tr, .card, .comp-card, .ident-dot').length }; }, t);
        await sleep(150);
        return { pass: s.errors.length === before && o.len > 0, obs: { id: o.id, rows: o.rows, text: hash(o.txt), textLen: o.len } };
      });
    }
  }
  await ev(E, () => showTab('import'));

  // ── EQ presidency edits ────────────────────────────────────
  await check('eq', 'toggle household EQ pool', async () => {
    await ev(E, () => toggleHHPool('h7')); await flush(E);
    const h = (await ward()).households.find(x => x.id === 'h7'); return { pass: h.inPool !== undefined && h.inPool !== false && h.inPool !== null, obs: h.inPool };
  });
  await check('eq', 'toggle brother pool', async () => {
    await ev(E, () => toggleBrotherPool('m11')); await flush(E);
    const m = (await ward()).members.find(x => x.id === 'm11'); return { pass: !!m.inPool, obs: m.inPool };
  });
  await check('eq', 'add draft companionship via modal', async () => {
    await ev(E, () => { showTab('propose'); openAddModal('proposed'); });
    await E.page.selectOption('#add-m1', 'm5'); await ev(E, () => refreshAddM2 && refreshAddM2());
    await E.page.selectOption('#add-m2', 'm7').catch(() => {});
    await E.page.check('#add-hh-list input[value="h1"]');
    await ev(E, () => saveNewCompanionship()); await flush(E);
    const p = (await ward()).proposed; const n = p.find(c => c.m1Id === 'm5');
    return { pass: p.length === 2 && !!n && n.households.includes('h1'), obs: { count: p.length, m2: n?.m2Id, hh: n?.households } };
  });
  await check('eq', 'edit draft companionship households', async () => {
    await ev(E, () => openEditModal('p1', 'proposed'));
    await E.page.check('#edit-hh-list input[value="h7"]'); await ev(E, () => saveEditCompanionship()); await flush(E);
    // h3 is a "Maybe" household, so the picker doesn't list it; today an edit drops it (recorded, not asserted).
    const c = (await ward()).proposed.find(x => x.id === 'p1'); return { pass: c.households.includes('h7') && c.households.includes('h5'), obs: { hh: c.households, keptMaybeHH: c.households.includes('h3') } };
  });
  await check('eq', 'reorder draft companionship', async () => {
    const first = (await ward()).proposed[0].id; await ev(E, () => moveCompanionship('proposed', S.proposed[0].id, 1)); await flush(E);
    const w = await ward(); return { pass: w.proposed[1].id === first, obs: w.proposed.map(c => c.id === first ? 'moved' : 'other') };
  });
  await check('eq', 'delete draft companionship', async () => {
    const id = (await ward()).proposed.find(c => c.m1Id === 'm5').id;
    await ev(E, id => openEditModal(id, 'proposed'), id); await ev(E, () => deleteCompanionship()); await flush(E);
    const p = (await ward()).proposed; return { pass: p.length === 1, obs: p.length };
  });
  await check('eq', 'copy current → draft', async () => {
    await ev(E, () => copyCurrentToProposed()); await sleep(200); await flush(E);
    const w = await ward(); return { pass: w.proposed.length === w.current.length, obs: { current: w.current.length, proposed: w.proposed.length } };
  });
  await check('eq', 'add note with tag → tagged person gets push', async () => {
    await ev(E, () => { showTab('households'); openNotesModal('household', 'h4'); });
    await E.page.fill('#note-text', 'Parity note for Brandt household.');
    await E.page.evaluate(() => { const box = document.querySelector('#note-tags input[value="uRs"]'); if (box) box.checked = true; });
    await ev(E, () => addNote()); await flush(E);
    const h = (await ward()).households.find(x => x.id === 'h4'); const n = (h.notes || []).find(x => x.text.startsWith('Parity note'));
    const push = await until(async () => (await pushesFor('tok-uRs')).find(x => x.data.tag === 'ministering-tagged'));
    return { pass: !!n && (n.tags || []).some(t => t.uid === 'uRs') && !!push, obs: { tags: (n?.tags || []).map(t => t.uid), push: push?.data?.body } };
  });
  await check('eq', 'delete own note', async () => {
    await ev(E, () => { openNotesModal('household', 'h4'); const t = getNotesTarget(_notesCtx); deleteNote(t.notes.findIndex(n => n.text.startsWith('Parity note'))); }); await flush(E);
    const h = (await ward()).households.find(x => x.id === 'h4'); return { pass: !(h.notes || []).some(n => n.text.startsWith('Parity note')), obs: (h.notes || []).length };
  });
  await check('eq', 'move-in status change', async () => {
    await ev(E, () => { showTab('moves'); setMoveInStatus('e2', 'contacted'); }); await flush(E);
    const e = (await ward()).groups.movein.find(x => x.id === 'e2'); return { pass: e.status === 'contacted' && e.statusBy === 'Sam Carter', obs: { status: e.status, by: e.statusBy } };
  });
  await check('eq', 'move-in EQ pool select', async () => {
    await ev(E, () => setMoveInPool('h3', 'in')); await flush(E);
    const h = (await ward()).households.find(x => x.id === 'h3'); return { pass: h.inPool === true, obs: h.inPool };
  });
  await check('eq', 'add member', async () => {
    await ev(E, () => openAddMemberModal());
    await E.page.fill('#nmem-name', 'Parity, Newman'); await E.page.selectOption('#nmem-gender', { index: 1 }).catch(() => {});
    await ev(E, () => saveNewMember()); await flush(E);
    const m = (await ward()).members.find(x => x.name === 'Parity, Newman'); return { pass: !!m, obs: { gender: m?.gender, count: (await ward()).members.length } };
  });
  await check('eq', 'delete member', async () => {
    const id = (await ward()).members.find(x => x.name === 'Parity, Newman').id;
    await ev(E, id => deleteMember(id), id); await flush(E);
    return { pass: !(await ward()).members.some(x => x.id === id), obs: (await ward()).members.length };
  });
  await check('eq', 'add + delete household', async () => {
    await ev(E, () => openAddHouseholdModal());
    const ids = await ev(E, () => [...document.querySelectorAll('#add-household-modal input, #add-household-modal textarea, .modal-overlay.open input')].map(i => i.id).filter(Boolean));
    const nameId = ids.find(i => /name/i.test(i)), addrId = ids.find(i => /addr/i.test(i));
    if (nameId) await E.page.fill('#' + nameId, 'Parity, Household'); if (addrId) await E.page.fill('#' + addrId, '1 Nowhere Rd, Palm Bay FL 32909');
    await ev(E, () => saveNewHousehold()); await sleep(500); await flush(E);
    const h = (await ward()).households.find(x => x.name === 'Parity, Household');
    if (h) { await ev(E, id => deleteHousehold(id), h.id); await flush(E); }
    const gone = h && !(await ward()).households.some(x => x.id === h.id);
    return { pass: !!h && gone, obs: { added: !!h, deleted: !!gone, fields: [nameId, addrId] } };
  });
  await check('eq', 'cannot change RS household pool', async () => {
    const before = (await ward()).households.find(x => x.id === 'h7').rsPool;
    await ev(E, () => toggleHHRSPool('h7')); await flush(E);
    const after = (await ward()).households.find(x => x.id === 'h7').rsPool; return { pass: before === after, obs: { changed: before !== after, alert: E.dialogs.slice(-1)[0] } };
  });
  await check('eq', 'cannot edit sister lists', async () => ({ pass: !(await ev(E, () => canEditList('currentRS') || canEditList('proposedRS'))), obs: await ev(E, () => [canEditList('current'), canEditList('proposed'), canEditList('currentRS'), canEditList('proposedRS')]) }));

  // ── RS presidency edits ────────────────────────────────────
  await check('rs', 'toggle RS household pool', async () => {
    const before = (await ward()).households.find(x => x.id === 'h7').rsPool;
    await ev(R, () => toggleHHRSPool('h7')); await flush(R);
    const after = (await ward()).households.find(x => x.id === 'h7').rsPool; return { pass: before !== after, obs: { before: before ?? null, after } };
  });
  await check('rs', 'toggle sister pool + recipient', async () => {
    await ev(R, () => { toggleSisterPool('m10'); toggleSisterRecipient('m3'); }); await flush(R);
    const w = await ward(); const a = w.members.find(x => x.id === 'm10'), b = w.members.find(x => x.id === 'm3');
    return { pass: !!a.rsPool && b.rsRecipient === 'maybe', obs: { pool: a.rsPool, recipient: b.rsRecipient } };   // In → Maybe (Nov 2026: three states)
  });
  await check('rs', 'move-in RS pool select', async () => {
    await ev(R, () => setMoveInRSPool('h3', 'in')); await flush(R);
    const h = (await ward()).households.find(x => x.id === 'h3'); return { pass: h.rsPool === true, obs: h.rsPool };
  });
  await check('rs', 'add draft sister companionship', async () => {
    await ev(R, () => { showTab('proposeRS'); openRSModal('proposedRS'); });
    await R.page.selectOption('#rs-m1', 'm8'); await R.page.selectOption('#rs-m2', 'm10').catch(() => {});
    await ev(R, () => { rsPick('hh', 'h5', true); rsPick('mem', 'm12', true); saveRSCompanionship(); }); await flush(R);
    const p = (await ward()).proposedRS; const c = p[0];
    return { pass: p.length === 1 && c.m1Id === 'm8' && c.households.includes('h5') && c.assignees.includes('m12'), obs: { count: p.length, m2: c?.m2Id, hh: c?.households, as: c?.assignees } };
  });
  await check('rs', 'copy current → draft (sisters)', async () => {
    await ev(R, () => copyRSToDraft()); await sleep(300); await flush(R);
    const w = await ward(); return { pass: w.proposedRS.length === w.currentRS.length, obs: { cur: w.currentRS.length, draft: w.proposedRS.length } };
  });
  await check('rs', 'cannot change EQ household pool', async () => {
    const before = (await ward()).households.find(x => x.id === 'h8').inPool;
    await ev(R, () => toggleHHPool('h8')); await flush(R);
    const after = (await ward()).households.find(x => x.id === 'h8').inPool; return { pass: before === after, obs: { changed: before !== after } };
  });

  // ── Ward council member ────────────────────────────────────
  await check('council', 'cannot change pools', async () => {
    const w0 = await ward();
    await ev(C, () => { toggleHHPool('h8'); toggleHHRSPool('h8'); toggleBrotherPool('m9'); toggleSisterPool('m6'); }); await flush(C);
    const w1 = await ward(); const same = JSON.stringify(w0.households) === JSON.stringify(w1.households) && JSON.stringify(w0.members) === JSON.stringify(w1.members);
    return { pass: same, obs: { changed: !same } };
  });
  await check('council', 'follow household → feed + push when EQ edits it', async () => {
    await ev(C, () => toggleFollow('h4')); await sleep(400);
    const fol = (await profile('uCouncil')).followHouseholds || [];
    await ev(E, () => { refreshFromCloud && null; toggleHHPool('h4'); }); await flush(E);
    const feed = await until(async () => ((await profile('uCouncil')).feed || []).find(f => f.hhId === 'h4'));
    const push = await until(async () => (await pushesFor('tok-uCouncil')).find(x => x.data.tag === 'ministering-follow'));
    return { pass: fol.includes('h4') && !!feed && !!push, obs: { feedText: feed?.text, push: push?.data?.body } };
  });
  await check('council', 'feed shows in Notifications + clear', async () => {
    await ev(C, () => reloadMyFollowState && reloadMyFollowState()); await sleep(800);
    const n = await ev(C, () => { showTab('notifications'); return document.querySelector('#tab-notifications').innerText.includes('Brandt'); });
    await ev(C, () => clearAllFeed()); await sleep(600);
    const left = ((await profile('uCouncil')).feed || []).length; return { pass: n && left === 0, obs: { shown: n, left } };
  });
  await check('council', 'covenant path: add person + goal note', async () => {
    await ev(C, () => { showTab('council'); openGroupAddModal('returning'); });
    const ok = await ev(C, () => { const sel = document.querySelector('.modal-overlay.open select'); if (!sel) return false; const o = [...sel.options].find(o => o.value === 'm9'); if (!o) return false; sel.value = 'm9'; sel.dispatchEvent(new Event('change')); addToGroup(); return true; });
    await flush(C);
    const g = (await ward()).groups.returning || []; const e = g.find(x => x.memberId === 'm9');
    if (e) { await ev(C, id => { openNotesModal('group', id, 'returning', 'goals'); document.getElementById('note-text').value = 'Parity goal'; addNote(); }, e.id); await flush(C); }
    // Nov 2026: a member's Goals live on the member, wherever they're opened from.
    const m9 = (await ward()).members.find(x => x.id === 'm9');
    return { pass: !!e && (m9.goals || []).some(n => n.text === 'Parity goal'), obs: { added: !!e, picked: ok, onMember: (m9.goals || []).length } };
  });
  await check('council', 'covenant path: remove person', async () => {
    const e = ((await ward()).groups.returning || []).find(x => x.memberId === 'm9');
    await ev(C, id => removeGroupEntry('returning', id), e?.id); await flush(C);
    return { pass: !((await ward()).groups.returning || []).some(x => x.memberId === 'm9'), obs: null };
  });
  await check('council', 'move-in next step note', async () => {
    await ev(C, () => { openNotesModal('group', 'e1', 'movein', 'nextSteps'); document.getElementById('note-text').value = 'Parity next step'; addNote(); }); await flush(C);
    const w = await ward(); const e = w.groups.movein.find(x => x.id === 'e1'); const h = w.households.find(x => x.id === e.householdId);   // on the household now
    return { pass: (h.nextSteps || []).some(n => n.text === 'Parity next step'), obs: (h.nextSteps || []).length };
  });

  // ── Notifications (tags) ───────────────────────────────────
  await check('notifications', 'tagged notes listed for EQ user', async () => {
    const o = await ev(E, () => { showTab('notifications'); return { n: visibleTaggedNotes().length, unread: unreadCount() }; });
    return { pass: o.n >= 3, obs: o };
  });
  await check('notifications', 'clear one + clear all tags', async () => {
    await ev(E, () => clearTagged(0)); await sleep(500);
    const one = ((await profile('uEq')).clearedTags || []).length;
    await ev(E, () => clearAllTagged()); await sleep(500);
    const all = ((await profile('uEq')).clearedTags || []).length; const vis = await ev(E, () => visibleTaggedNotes().length);
    return { pass: one === 1 && all >= 3 && vis === 0, obs: { one, all, vis } };
  });

  // ── Messages + restricted notes ────────────────────────────
  for (const s of [A, E, R, C]) await ev(s, () => document.querySelectorAll('.modal-overlay.open').forEach(o => o.classList.remove('open')));
  await check('messages', 'DM: start thread + send, recipient sees it + push', async () => {
    await ev(E, () => { showTab('messages'); openMsgPeople('new'); });
    await E.page.click('#msg-people-pick label:has-text("Rita Ames") input'); await E.page.click('#msg-people-ok'); await sleep(600);
    await E.page.fill('#msg-text', 'Parity hello'); await E.page.click('#msg-send'); await sleep(800);
    const box = await ev(E, () => document.getElementById('msg-text')?.value);
    const seen = await until(() => ev(R, () => { showTab('messages'); return _threads.length > 0 && document.getElementById('tab-messages').innerText.includes('Sam'); }), 8000);
    const push = await until(async () => (await pushesFor('tok-uRs')).find(x => x.data.tag === 'ministering-dm'));
    const unread = await ev(R, () => msgUnreadCount());
    return { pass: box === '' && seen && !!push, obs: { boxCleared: box === '', seen, unread, push: push?.data?.body } };
  });
  await check('messages', 'DM: reply + delete own message', async () => {
    await ev(R, () => openThread(_threads[0].id)); await sleep(400);
    await R.page.fill('#msg-text', 'Parity reply'); await R.page.click('#msg-send'); await sleep(800);
    const n1 = await until(() => ev(E, () => _openMsgs && _openMsgs.length >= 2), 8000);
    const mine = await ev(R, () => _openMsgs.find(m => m.text === 'Parity reply')?.id);
    await ev(R, id => deleteMessage(id), mine); await sleep(600);
    const n2 = await ev(R, () => _openMsgs.length);
    return { pass: !!n1 && n2 === 1, obs: { afterDelete: n2 } };
  });
  await check('messages', 'restricted note visible to chosen viewer only', async () => {
    await ev(E, () => { showTab('households'); openNotesModal('household', 'h2'); openRestrictedModal(); });
    await E.page.fill('#restricted-text', 'Parity restricted');
    await ev(E, () => { const b = document.querySelector('#restricted-pick input[value="uRs"]') || [...document.querySelectorAll('#restricted-pick label')].find(l => l.innerText.includes('Rita'))?.querySelector('input'); b.click(); });
    await ev(E, () => saveRestrictedNote()); await sleep(800);
    const rSees = await until(() => ev(R, () => _restricted.some(n => n.text === 'Parity restricted')), 8000);
    const cSees = await ev(C, () => _restricted.some(n => n.text === 'Parity restricted'));
    const push = await until(async () => (await pushesFor('tok-uRs')).find(x => x.data.tag === 'ministering-restricted'));
    return { pass: rSees && !cSees && !!push, obs: { rita: rSees, cora: cSees, push: push?.data?.body } };
  });
  await check('messages', 'restricted note delete', async () => {
    const id = await ev(E, () => _restricted.find(n => n.text === 'Parity restricted')?.id);
    await ev(E, id => deleteRestrictedNote(id), id); await sleep(800);
    return { pass: !(await adb.doc('privateNotes/' + id).get()).exists, obs: null };
  });

  // ── Identifiers tab lists link to the rows ───────────────────
  await check('idents', 'identifier lists link to the Members / Households rows', async () => {
    const o = await ev(C, async () => {
      showTab('members'); document.getElementById('member-search').value = 'zzz'; renderMembers();   // a stale search must not hide the row
      showTab('idents');
      const cards = [...document.querySelectorAll('#ident-body .card')];
      const card = t => cards.find(c => c.querySelector('h2').innerText.includes(t));
      const names = t => [...card(t).querySelectorAll('.ident-link')].map(b => b.innerText);
      const res = { noCalling: names('without callings'), ysa: names('Young single'), partMember: names('Part-member') };
      card('without callings').querySelector('.ident-link').click();
      await new Promise(r => setTimeout(r, 300));
      const row = document.querySelector('#tab-members tr.row-flash');
      res.memberTab = document.querySelector('.tab-content.active').id; res.memberRow = row ? row.querySelector('strong').innerText : null;
      showTab('idents'); [...document.querySelectorAll('#ident-body .card')].find(c => c.querySelector('h2').innerText.includes('Part-member')).querySelector('.ident-link').click();
      await new Promise(r => setTimeout(r, 300));
      const hrow = document.querySelector('#tab-households tr.row-flash');
      res.hhTab = document.querySelector('.tab-content.active').id; res.hhRow = hrow ? hrow.querySelector('strong').innerText : null;
      return res;
    });
    return { pass: o.memberTab === 'tab-members' && o.memberRow === o.noCalling[0] && o.hhTab === 'tab-households' && o.hhRow === o.partMember[0] && o.ysa.length > 0,
      obs: o };
  });

  // ── Nov 2026 round: Current import-only, diffs, more companions, last import ──
  if (await ev(E, () => typeof ministersOf === 'function')) {
    await check('round3', 'Current is import-only (no Add / Promote / edit)', async () => {
      const o = await ev(E, () => { showTab('current');
        const vis = el => el && el.offsetParent !== null;
        const btns = [...document.querySelectorAll('#tab-current button, #tab-currentRS button')].filter(vis).map(b => b.innerText.trim());
        const n = S.current.length; window.__alertMsg = null; const oa = window.alert; window.alert = m => { window.__alertMsg = m; };
        promoteProposedToCurrent(); window.alert = oa;
        return { canEdit: canEditList('current') || canEditList('currentRS'), add: btns.some(b => /^\+ Add$/.test(b)), promote: btns.some(b => /Promote/.test(b)), clear: btns.some(b => /Clear All/.test(b)), same: S.current.length === n, alerted: !!window.__alertMsg }; });
      return { pass: !o.canEdit && !o.add && !o.promote && !o.clear && o.same && o.alerted, obs: o };
    });
    await check('round3', 'geocoding is on the Households tab, not the Draft tab', async () => {
      const o = await ev(E, () => ({ hh: !!document.querySelector('#tab-households #geo-status'), draft: !!document.querySelector('#tab-propose #geo-status') }));
      return { pass: o.hh && !o.draft, obs: o };
    });
    await check('round3', 'brothers: + Add another companion saves 4 ministers', async () => {
      const ids = await ev(E, () => { showTab('propose'); openAddModal('proposed');
        const a = [...document.getElementById('add-m1').options].filter(o => !o.disabled).map(o => o.value).filter(Boolean);
        document.getElementById('add-m1').value = a[0]; refreshAddM2();
        const b = [...document.getElementById('add-m2').options].filter(o => !o.disabled).map(o => o.value).filter(v => v && v !== '__spouse__' && v !== a[0]);
        if (b[0]) document.getElementById('add-m2').value = b[0];
        const rest = brothers().map(x => x.id).filter(id => id !== a[0] && id !== b[0]).slice(0, b[0] ? 2 : 3);
        rest.forEach(() => addCompanionSelect('add'));
        document.querySelectorAll('#add-more select.more-min').forEach((sel, i) => { sel.value = rest[i]; });
        return [a[0], ...(b[0] ? [b[0]] : []), ...rest]; });
      await ev(E, () => saveNewCompanionship()); await flush(E);
      const c = (await ward()).proposed.find(c => c.m1Id === ids[0] && (c.moreMinisters || [])[0]?.id === ids[3]);
      const card = await ev(E, id => { renderProposed(); return [...document.querySelectorAll('#proposed-list .companionship-card')].find(el => el.innerHTML.includes(id))?.innerText || ''; }, c?.id);
      const edit = await ev(E, id => { openEditModal(id, 'proposed'); const n = document.querySelectorAll('#edit-more select.more-min').length; closeModal('edit-modal'); return n; }, c?.id);
      return { pass: !!c && c.m2Id === ids[1] && c.m3Id === ids[2] && c.moreMinisters.length === 1 && edit === 2 && /New — not in Current/.test(card),
        obs: { saved: !!c, more: c?.moreMinisters?.length, editPickers: edit, newChip: /New — not in Current/.test(card) } };
    });
    await check('round3', 'sisters: + Add another companion saves a 3rd sister', async () => {
      const ids = await ev(R, () => sisters().map(m => m.id).slice(0, 3));
      await ev(R, () => { showTab('proposeRS'); openRSModal('proposedRS'); });
      await R.page.selectOption('#rs-m1', ids[0]); await R.page.selectOption('#rs-m2', ids[1]).catch(() => {});
      await ev(R, id => { addCompanionSelect('rs'); document.querySelector('#rs-more select.more-min').value = id; rsPick('hh', 'h5', true); saveRSCompanionship(); }, ids[2]); await flush(R);
      const c = (await ward()).proposedRS.find(c => c.m3Id === ids[2]);
      return { pass: !!c && c.m1Id === ids[0] && c.m3Id === ids[2], obs: { saved: !!c, m3: !!c?.m3Id } };
    });
    await check('round3', 'Draft vs Current: changed parts marked, changes sort first', async () => {
      const o = await ev(E, () => {
        const d = S.proposed.find(p => p.fromId); const extra = S.households.find(h => !d.households.includes(h.id));
        d.households = [...d.households, extra.id]; showTab('propose');
        document.getElementById('cs-sort-proposed').value = 'changes'; renderProposed();
        const cards = [...document.querySelectorAll('#proposed-list .companionship-card')];
        const first = cards[0]?.innerText || '', summary = document.getElementById('diff-summary-proposed').innerText;
        const arrows = cards.some(c => /▲/.test(c.innerText));
        document.getElementById('cs-sort-proposed').value = ''; renderProposed();
        const arrowsBack = [...document.querySelectorAll('#proposed-list .companionship-card')].some(c => /▲/.test(c.innerText));
        d.households = d.households.filter(h => h !== extra.id); renderProposed();
        return { first: first.slice(0, 120), hasChip: first.includes('+ 🏠 ' + extra.name), changedFirst: /Changed from Current/.test(first), summary, arrows, arrowsBack };
      });
      return { pass: o.hasChip && o.changedFirst && /1<\/b>|1 changed/.test(o.summary.replace(/\s+/g, ' ')) && !o.arrows && o.arrowsBack, obs: { ...o, first: undefined } };
    });
    await check('round3', 'last import shows when and by whom; each line only by its owners', async () => {
      await ev(C, () => { noteImport('cp-new', 3); noteImport('members-csv', 9); scheduleSync(); }); await flush(C);
      const m = (await ward()).importMeta?.['cp-new'], notMine = (await ward()).importMeta?.['members-csv'];
      await ev(E, () => { noteImport('ministering-eq', 2); scheduleSync(); }); await flush(E);
      const eqLine = (await ward()).importMeta?.['ministering-eq'];
      const shown = await ev(C, () => { showTab('council'); return document.querySelector('.import-last[data-imp="cp-new"]')?.innerText || ''; });
      const other = await ev(C, () => document.querySelector('.import-last[data-imp="movein"]')?.innerText || '');
      return { pass: !!m && !notMine && eqLine?.count === 2 && m.count === 3 && /Last imported .* by .*\(3 on the page\)/.test(shown) && /Not imported/.test(other), obs: { stored: !!m, councilWroteMembersLine: !!notMine, eqLine: !!eqLine, by: m?.by, shown, other } };
    });
    await check('round3', 'birthday names link to the member row', async () => {
      const o = await ev(C, async () => { const t = new Date(); const m0 = S.members.find(m => m.householdId); m0.ident = { ...(m0.ident || {}), bday: String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0') }; showTab('idents'); const b = [...document.querySelectorAll('#ident-body .card')].find(c => /Birthday/i.test(c.querySelector('h2')?.innerText || ''));
        const link = b?.querySelector('.ident-link'); if (!link) return { link: false };
        const name = link.innerText; link.click(); await new Promise(r => setTimeout(r, 300));
        const row = document.querySelector('#tab-members tr.row-flash'); return { link: true, name, row: row?.querySelector('strong')?.innerText }; });
      return { pass: o.link && o.row && o.name.includes(o.row.split(',')[0]), obs: o };
    });
  }

  // ── Search + nearby ────────────────────────────────────────
  await check('search', 'companionship search (minister / served / either)', async () => {
    const o = await ev(E, () => { showTab('current'); const q = document.getElementById('cs-q-current'), m = document.getElementById('cs-mode-current'); const out = {};
      for (const [mode, term] of [['minister', 'Whitfield'], ['served', 'Tanaka'], ['either', 'Okafor'], ['either', 'zzz']]) { q.value = term; m.value = mode; q.dispatchEvent(new Event('input')); m.dispatchEvent(new Event('change'));
        out[mode + ':' + term] = document.getElementById('cs-count-current').innerText.trim(); }
      q.value = ''; q.dispatchEvent(new Event('input')); return out; });
    return { pass: Object.keys(o).length === 4, obs: o };
  });
  await check('search', 'find nearby (household name, EQ pool)', async () => {
    const o = await ev(E, async () => { showTab('nearby'); document.getElementById('nearby-addr').value = 'Brandt, Hugo & Ilse'; document.getElementById('nearby-pool').value = 'eq'; await findNearby(); await new Promise(r => setTimeout(r, 300));
      return { status: document.getElementById('nearby-status').innerText, rows: document.getElementById('nearby-results').innerText.replace(/\s+/g, ' ').slice(0, 400) }; });
    return { pass: o.rows.length > 0, obs: { status: o.status, text: hash(o.rows) } };
  });


  // ── Two-step sign-in, allowed list, roles, confirmations (new) ──
  if (await ev(A, () => typeof sessionProblem === 'function')) {
    await check('security', 'notes moved to their own collection on first open', async () => {
      const notes = (await adb.collection('notes').get()).docs.map(d => d.data());
      const w = await wardRaw();
      const embedded = JSON.stringify(w).match(/"(notes|goals|nextSteps)":\[\{/g) || [];
      return { pass: notes.length >= 4 && !embedded.length && w.clientVersion === 2 && notes.every(n => n.target && n.target.field),
        obs: { notesInCollection: notes.length, migrated: notes.filter(n => n.migrated).length, embeddedLeft: embedded.length, clientVersion: w.clientVersion } };
    });
    await check('security', 'first sign-in: set up a texted code, then in', async () => {
      const s = await open('finn@example.com', { }); const first = await screen(s);
      await ev(s, () => mfaEnrollStep('phone'));
      await s.page.fill('#mfa-enroll-phone', '555-555-0199'); await s.page.click('#mfa-enroll-send');
      const c = await smsCode('+15555550199');
      await s.page.waitForFunction(() => document.getElementById('mfa-step-code').style.display === 'block', null, { timeout: 10000 });
      await s.page.fill('#mfa-enroll-code', c); await s.page.click('#mfa-enroll-confirm');
      await waitScreen(s.page, ['app-shell', 'auth-screen']);
      let after = await screen(s);
      const notice = await ev(s, () => document.getElementById('auth-notice')?.innerText || '');
      if (after === 'auth-screen') { await signIn(s, 'finn@example.com', PW, { code: false });
        if (await screen(s) === 'mfa-signin-screen') { await s.page.fill('#mfa-signin-code', await smsCode('+15555550199', 1)); await s.page.click('#mfa-signin-btn'); await waitScreen(s.page, ['app-shell']); }
        after = await screen(s); }
      const u = await require('firebase-admin/auth').getAuth().getUser('uFresh');
      await s.ctx.close();
      return { pass: first === 'mfa-enroll-screen' && after === 'app-shell' && (u.multiFactor?.enrolledFactors || []).length === 1,
        obs: { first, after, factors: (u.multiFactor?.enrolledFactors || []).map(f => f.factorId), signedInAgain: !!notice } };
    });
    await check('security', 'wrong code is refused, right code gets in', async () => {
      const s = await open(null);
      const before = await codeCount('+15555550103');
      await s.page.fill('#auth-email', 'cora@example.com'); await s.page.fill('#auth-password', PW); await s.page.click('#auth-submit-btn');
      await waitScreen(s.page, ['mfa-signin-screen']); await smsCode('+15555550103', before);
      await s.page.fill('#mfa-signin-code', '000000'); await s.page.click('#mfa-signin-btn'); await sleep(1200);
      const err = await ev(s, () => document.getElementById('mfa-signin-error').innerText); const still = await screen(s);
      await s.page.fill('#mfa-signin-code', await smsCode('+15555550103', before)); await s.page.click('#mfa-signin-btn');
      await waitScreen(s.page, ['app-shell']); const after = await screen(s);
      const claims = await ev(s, async () => (await fbAuth.currentUser.getIdTokenResult()).claims.firebase.sign_in_second_factor);
      await s.ctx.close();
      return { pass: still === 'mfa-signin-screen' && !!err && after === 'app-shell' && claims === 'phone', obs: { err, after, secondFactor: claims } };
    });
    await check('security', 'wrong password never reaches the code step', async () => {
      const s = await open(null); await signIn(s, 'cora@example.com', 'nope-nope', { code: false });
      const sc = await screen(s); await s.ctx.close(); return { pass: sc === 'auth-screen', obs: sc };
    });
    await check('security', 'household change: before → after shown; Cancel puts it back', async () => {
      await ev(E, () => { window.__lastConfirm = null; }); await ev(E, () => { const h = S.households.find(h => h.id === 'h6'); h.address = '99 New Rd, Palm Bay FL 32909'; dbUpsertHousehold(h); });
      await flush(E, { confirm: false });
      const shown = E.lastConfirm || '';
      const cloud = (await ward()).households.find(h => h.id === 'h6').address;
      const local = await ev(E, () => S.households.find(h => h.id === 'h6').address);
      return { pass: /15 Fixture Ln/.test(shown) && /99 New Rd/.test(shown) && cloud.startsWith('15 Fixture') && local.startsWith('15 Fixture'),
        obs: { shownBeforeAfter: /15 Fixture Ln/.test(shown) && /99 New Rd/.test(shown), cloud: cloud.slice(0, 9), local: local.slice(0, 9) } };
    });
    await check('security', 'household change: Save these changes saves it', async () => {
      await ev(E, () => { const h = S.households.find(h => h.id === 'h6'); h.phone = '321-555-0000'; dbUpsertHousehold(h); });
      await flush(E); const shown = E.lastConfirm || '';
      const cloud = (await ward()).households.find(h => h.id === 'h6').phone;
      return { pass: /Phone/.test(shown) && cloud === '321-555-0000', obs: { asked: !!shown, saved: cloud === '321-555-0000' } };
    });
    await check('security', 'pool toggles and notes save without asking', async () => {
      await ev(E, () => { window.__lastConfirm = null; }); await ev(E, () => toggleHHPool('h7')); await flush(E); const a = E.lastConfirm;
      await ev(E, () => { openNotesModal('household', 'h7'); document.getElementById('note-text').value = 'No confirm for notes'; addNote(); closeModal('notes-modal'); }); await flush(E); const b = E.lastConfirm;
      const n = (await adb.collection('notes').get()).docs.map(d => d.data()).find(x => x.text === 'No confirm for notes');
      return { pass: a === null && b === null && !!n && n.authorId === 'uEq' && n.target.type === 'household', obs: { askedForPool: a !== null, askedForNote: b !== null, noteStored: !!n } };
    });
    await check('security', 'draft assignment edits save without asking; Current asks', async () => {
      await ev(E, () => { window.__lastConfirm = null; }); await ev(E, () => moveCompanionship('proposed', S.proposed[0].id, 1)); await flush(E); const a = E.lastConfirm;
      await ev(E, () => { const c = S.current.find(c => c.id === 'c2'); c.households = [...c.households, 'h8']; dbUpsertCompanionship('current', c); }); await flush(E); const b = E.lastConfirm || '';
      return { pass: a === null && /Delgado/.test(b), obs: { askedForDraft: a !== null, askedForCurrent: !!b } };
    });
    await check('security', 'council: member/household controls hidden, edits refused', async () => {
      const o = await ev(C, () => { showTab('members'); const btn = [...document.querySelectorAll('#tab-members button')].find(b => /Add Member/.test(b.innerText));
        return { hidden: !btn || btn.offsetParent === null, guard: (() => { const n = S.members.length; openAddMemberModal(); return !document.getElementById('new-member-modal')?.classList.contains('open') && S.members.length === n; })() }; });
      await ev(C, () => { const m = S.members.find(m => m.id === 'm4'); m.age = 99; dbUpsertMember(m); }); await flush(C);
      const age = (await ward()).members.find(m => m.id === 'm4').age;
      const local = await ev(C, () => S.members.find(m => m.id === 'm4').age);
      return { pass: o.hidden && o.guard && age === 28 && local === 28, obs: { ...o, cloudAge: age, localAge: local } };
    });
    await check('security', 'council: own notes yes, others\' notes no', async () => {
      await ev(C, () => { openNotesModal('household', 'h5'); document.getElementById('note-text').value = 'Council note'; addNote(); closeModal('notes-modal'); }); await flush(C);
      const mine = (await adb.collection('notes').get()).docs.map(d => d.data()).find(n => n.text === 'Council note');
      await ev(C, () => refreshFromCloud()); await sleep(500);
      const others = await ev(C, () => { openNotesModal('household', 'h7'); const t = getNotesTarget(_notesCtx); const i = t.notes.findIndex(n => n.text === 'No confirm for notes'); const n0 = t.notes.length; deleteNote(i); const n1 = t.notes.length; closeModal('notes-modal'); return { n0, n1 }; });
      return { pass: !!mine && mine.authorId === 'uCouncil' && others.n0 === others.n1, obs: { mine: !!mine, othersDeleteBlocked: others.n0 === others.n1 } };
    });
  } else rec('security', 'two-step sign-in not in this version', true, null, 'info');

  // ── Admin panel ────────────────────────────────────────────
  await check('admin', 'approve pending user', async () => {
    await ev(A, () => showTab('admin')); await sleep(800);
    await ev(A, () => setUserStatus('uPending', 'approved')); await sleep(800);
    return { pass: (await profile('uPending')).status === 'approved', obs: (await profile('uPending')).status };
  });
  await check('admin', 'set role', async () => {
    await ev(A, () => setUserRole('uPending', 'rs')); await sleep(800);
    // Roles live on the allowed list now (profiles/{uid}.role in the old version).
    const a = (await adb.doc('allowedUsers/pete@example.com').get()).data();
    const role = a ? a.role : (await profile('uPending')).role;
    return { pass: role === 'rs', obs: role };
  });
  await check('admin', 'approved user now gets in', async () => {
    const s = states['pete@example.com']; await s.page.reload(); await s.page.waitForFunction(() => ['app-shell', 'mfa-enroll-screen'].some(id => document.getElementById(id)?.style.display === 'block'), null, { timeout: 20000 }).catch(() => {});
    // With two-step sign-in, a newly approved person sets it up first.
    const sc = await screen(s); await s.ctx.close(); return { pass: sc === 'app-shell' || sc === 'mfa-enroll-screen', obs: sc };
  });
  if (await ev(A, () => typeof handleCallingsPdf === 'function')) {
    await check('admin', 'approve puts them on the allowed list', async () => {
      const a = (await adb.doc('allowedUsers/pete@example.com').get()).data();
      return { pass: !!a && a.uid === 'uPending', obs: a ? { role: a.role, admin: a.admin } : null };
    });
    await check('admin', 'callings import flags roles that don\'t match + tells the admin', async () => {
      const rows = [['Carter, Sam', 'M', '40', '1 Jan 1986', 'Elders Quorum', 'Elders Quorum President'],
        ['Ames, Rita', 'F', '38', '2 Feb 1988', 'Relief Society', 'Relief Society Secretary'],
        ['Lane, Cora', 'F', '45', '3 Mar 1981', 'Relief Society', 'Relief Society First Counselor'],
        ['Lane, Cora', 'F', '45', '3 Mar 1981', 'Primary', 'Primary Teacher'],
        ['Admin, Avery', 'M', '50', '4 Apr 1976', 'Elders Quorum', 'Elders Quorum First Counselor'],
        ['Brandt, Hugo', 'M', '45', '5 May 1981', 'Sunday School', 'Sunday School Teacher'],
        ['Fresh, Finn', 'M', '30', '6 Jun 1996', 'Primary', 'Primary Teacher']];
      const pg = await browser.newPage();
      await pg.setContent(`<style>body{font:10px Arial;margin:30px}td,th{padding:6px 8px;text-align:left;vertical-align:top}</style>
        <div>Palm Bay Test Ward</div><div>Members with Callings</div><table><tr><th>Name</th><th>Gender</th><th>Age</th><th>Birth Date</th><th>Organization</th><th>Calling</th><th>Sustained</th><th>Set Apart</th></tr>
        ${rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}<td>1 Jan 2026</td><td>✔</td></tr>`).join('')}</table>`);
      const f = path.join(__dirname, 'synthetic-callings.pdf'); await pg.pdf({ path: f, format: 'Letter' }); await pg.close();
      await ev(A, () => showTab('admin')); await sleep(800);
      await A.page.setInputFiles('#callings-file', f); await sleep(3000); fs.unlinkSync(f);
      const st = await ev(A, () => document.getElementById('callings-status').innerText);
      const flags = await ev(A, () => [...document.querySelectorAll('#tab-admin .role-flag')].map(e => e.innerText).filter(t => /suggests/.test(t)).length);
      const doc = (await adb.doc('adminData/callings').get()).data();
      const push = await until(async () => (await pushesFor('tok-uAdmin')).find(x => x.data.tag === 'ministering-roles'));
      // Finn's only calling (Primary Teacher) isn't on the access list: flagged, nothing changed.
      const finnFlag = await ev(A, () => [...document.querySelectorAll('#tab-admin .role-flag')].some(e => /Primary Teacher/.test(e.innerText) && /list of callings that come with access/.test(e.innerText)));
      if (doc?.users) Object.assign(doc, { finn: doc.users['finn@example.com'] });
      const finnStill = (await adb.doc('allowedUsers/finn@example.com').get()).exists;
      return { pass: doc?.users?.['cora@example.com']?.expected === 'rs' && doc?.users?.['sam@example.com']?.expected === 'eq' && flags >= 1 && !!push
          && finnFlag && doc?.finn?.accessOk === false && doc?.users?.['sam@example.com']?.accessOk === true && finnStill,
        obs: { status: st.replace(/\d+ callings/, 'N callings'), flags, cora: doc?.users?.['cora@example.com']?.callings, finnAccessFlag: finnFlag, finnStillAllowed: finnStill, push: push?.data?.body } };
    });
    await check('admin', '"Make RS Presidency" fixes the flagged role (then put back)', async () => {
      await ev(A, () => setUserRole('uCouncil', 'rs')); await sleep(800);
      const a = (await adb.doc('allowedUsers/cora@example.com').get()).data();
      await ev(A, () => setUserRole('uCouncil', 'council')); await sleep(800);
      return { pass: a.role === 'rs', obs: a.role };
    });
    await check('admin', 'Bishopric role can be set (acts as Ward Council)', async () => {
      await ev(A, () => setUserRole('uPending', 'bishopric')); await sleep(800);
      const a = (await adb.doc('allowedUsers/pete@example.com').get()).data();
      const opt = await ev(A, () => !!document.querySelector('#tab-admin option[value="bishopric"]'));
      await ev(A, () => setUserRole('uPending', 'rs')); await sleep(800);
      return { pass: a.role === 'bishopric' && opt, obs: { role: a.role, option: opt } };
    });
    await check('admin', 'Bishopric can add members and run move-ins, not identifiers', async () => {
      await adb.doc('allowedUsers/cora@example.com').update({ role: 'bishopric' });
      const B = await open('cora@example.com');
      const o = await ev(B, () => ({ role: _currentUserRole, addBtn: !!document.querySelector('#tab-members .member-edit') && document.querySelector('#tab-members .member-edit').style.display !== 'none',
        moveIn: document.querySelector('[onclick*="movein-file"]').style.display !== 'none', ident: document.querySelector('[onclick*="ident-file-ysa"]').style.display !== 'none',
        pools: canEditEQ() || canEditRS() }));
      await ev(B, () => openAddMemberModal()); await B.page.fill('#nmem-name', 'Bishopric, Added'); await ev(B, () => saveNewMember()); await flush(B);
      const added = (await ward()).members.some(m => m.name === 'Bishopric, Added');
      const id = (await ward()).members.find(m => m.name === 'Bishopric, Added')?.id;
      if (id) { await ev(B, id => deleteMember(id), id); await flush(B); }
      const removed = !(await ward()).members.some(m => m.name === 'Bishopric, Added');
      await B.ctx.close(); await adb.doc('allowedUsers/cora@example.com').update({ role: 'council' });
      return { pass: o.role === 'bishopric' && o.addBtn && o.moveIn && !o.ident && !o.pools && added && removed, obs: { ...o, added, removed } };
    });
    await check('admin', 'reset two-step sign-in (lost phone)', async () => {
      const before = ((await require('firebase-admin/auth').getAuth().getUser('uFresh')).multiFactor?.enrolledFactors || []).length;
      await ev(A, () => resetTwoStep('uFresh')); await sleep(1500);
      const after = ((await require('firebase-admin/auth').getAuth().getUser('uFresh')).multiFactor?.enrolledFactors || []).length;
      const msg = A.dialogs.slice(-1)[0] || '';
      return { pass: before === 1 && after === 0, obs: { before, after, msg: msg.slice(0, 40) } };
    });
    await check('admin', 'Admin tab shows who has set up two-step sign-in', async () => {
      await ev(A, () => showTab('admin'));
      await A.page.waitForFunction(() => [...document.querySelectorAll('#tab-admin .ts-status')].length && ![...document.querySelectorAll('#tab-admin .ts-status')].some(e => /checking/.test(e.innerText)), null, { timeout: 30000 });
      const o = await ev(A, () => { const by = uid => document.querySelector(`#tab-admin .ts-status[data-uid="${uid}"]`)?.innerText || '';
        return { sam: by('uEq'), finn: by('uFresh'), summary: document.getElementById('admin-twostep-summary').innerText.replace(/\s+/g, ' ').slice(0, 120) }; });
      const r = await ev(E, async () => { try { await firebase.functions().httpsCallable('twoStepStatus')({}); return 'allowed'; } catch (e) { return e.code; } });
      return { pass: /text ✓/.test(o.sam) && /not set up/.test(o.finn) && /Not yet:.*Finn/.test(o.summary) && r !== 'allowed', obs: { ...o, nonAdminCall: r } };
    });
    await check('admin', 'a non-admin can\'t call reset', async () => {
      const r = await ev(E, async () => { try { await firebase.functions().httpsCallable('resetTwoStep')({ uid: 'uRs' }); return 'allowed'; } catch (e) { return e.code; } });
      return { pass: r !== 'allowed', obs: r };
    });
  }
  await check('admin', 'non-admin cannot open admin tab', async () => ({ pass: (await ev(C, () => { showTab('admin'); return document.querySelector('.tab-content.active').id; })) !== 'tab-admin', obs: null }));

  // ── Sign out / back in ─────────────────────────────────────
  await check('auth', 'sign out returns to sign-in', async () => {
    await ev(C, () => signOut()); await sleep(800); return { pass: await screen(C) === 'auth-screen', obs: await screen(C) };
  });
  await check('auth', 'session persists across reload', async () => {
    await E.page.reload(); await E.page.waitForFunction(() => document.getElementById('app-shell').style.display === 'block', null, { timeout: 20000 }).catch(() => {});
    return { pass: await screen(E) === 'app-shell', obs: await screen(E) };
  });

  // ── Access rules as they are today (expected to change) ─────
  const C2 = await open('cora@example.com');
  const P = await open('dale@example.com');
  const V = states['val@example.com'];
  const rules = [
    [P, 'denied user reads ward data', `await db.doc('wardData/shared').get()`],
    [V, 'unverified user reads ward data', `await db.doc('wardData/shared').get()`],
    [C2, 'council reads ward data', `await db.doc('wardData/shared').get()`],
    [C2, 'council overwrites members list', `const d=(await db.doc('wardData/shared').get()).data(); await db.doc('wardData/shared').update({members:d.members})`],
    [C2, 'council edits a household field', `const d=(await db.doc('wardData/shared').get()).data(); d.households[0].inPool=d.households[0].inPool; await db.doc('wardData/shared').update({households:d.households})`],
    [C2, 'council creates another wardData doc', `await db.doc('wardData/__probe').set({x:1})`],
    [C2, 'council sets own role to eq', `await db.doc('profiles/uCouncil').update({role:'eq'})`],
    [C2, 'council sets own isAdmin', `await db.doc('profiles/uCouncil').update({isAdmin:true})`],
    [C2, 'council reads another profile', `await db.doc('profiles/uEq').get()`],
    [C2, 'council writes unit stats', `await db.doc('wardData/stats').set({probe:1},{merge:true})`],
    [C2, 'council reads restricted note not shared with them', `await db.collection('privateNotes').where('viewers','array-contains','uEq').get()`],
    [C2, 'council reads a thread they are not in', `const s=await db.collection('threads').where('participants','array-contains','uEq').get()`],
    [P, 'denied user writes profile status approved', `await db.doc('profiles/uDenied').update({status:'approved'})`],
  ];
  for (const [s, name, code] of rules) await check('rules-today', name, async () => { const r = await tryOp(s, code); return { pass: true, obs: r }; }, 'security');
  await ev(C2, () => db.doc('profiles/uCouncil').update({ role: null }).catch(() => {}));
  await adb.doc('profiles/uCouncil').update({ role: null, isAdmin: false });

  // ── Imports from real LCR PDFs (local only; results keep counts only) ──
  if (REAL_PDF_DIR && fs.existsSync(REAL_PDF_DIR)) {
    const pdf = pat => { const f = fs.readdirSync(REAL_PDF_DIR).find(x => pat.test(x)); return f ? path.join(REAL_PDF_DIR, f) : null; };
    const imp = async (s, group, name, input, file, apply, measure) => {
      if (!file) return rec(group, name, false, { error: 'pdf not found' });
      await check(group, name, async () => {
        const before = s.errors.length;
        await s.page.setInputFiles(input, file); await sleep(2500);
        const review = await ev(s, () => (document.querySelector('.tab-content.active').innerText.match(/\d+/g) || []).length);
        await ev(s, apply); await sleep(600); await flush(s); await sleep(400);
        const m = await measure(); return { pass: s.errors.length === before && m.ok, obs: m.obs };
      });
    };
    // Imports match report names to Members, so this stage swaps in the local
    // real roster (emulator only; nothing here is written to the results).
    if (process.env.REAL_ROSTER && fs.existsSync(process.env.REAL_ROSTER)) {
      global.window = {}; global.location = { search: '' };
      require(process.env.REAL_ROSTER); const w = JSON.parse(JSON.stringify(window.__store['wardData/shared']));
      w.current = []; w.proposed = []; w.currentRS = []; w.proposedRS = []; w.groups = { ...(w.groups || {}), new: [], returning: [], mission: [] }; w.users = (await ward()).users;
      await adb.doc('wardData/shared').set(w);
      for (const s of [E, R]) { await s.page.reload(); await s.page.waitForFunction(() => document.getElementById('app-shell').style.display === 'block', null, { timeout: 20000 }); }
      rec('import', 'real roster loaded for imports', true, { members: w.members.length, households: w.households.length }, 'info');
    }
    await ev(E, () => showTab('current'));
    await imp(E, 'import', 'ministering assignments → Current (EQ)', '#min-file-eq', pdf(/Ministering_Assignments/), () => applyMinPlan(),
      async () => { const w = await ward(); return { ok: w.current.length > 0, obs: { current: w.current.length, households: w.households.length, members: w.members.length, hhLinks: w.current.reduce((n, c) => n + (c.households || []).length, 0) } }; });
    await ev(R, () => showTab('currentRS'));
    await imp(R, 'import', 'ministering assignments → Current (RS)', '#min-file-rs', pdf(/Ministering_Assignments/), () => applyMinPlan(),
      async () => { const w = await ward(); return { ok: w.currentRS.length > 0, obs: { currentRS: w.currentRS.length, current: w.current.length, links: w.currentRS.reduce((n, c) => n + (c.households || []).length + (c.assignees || []).length, 0) } }; });
    await ev(E, () => showTab('idents'));
    for (const [kind, pat] of [['noCalling', /without_Callings/], ['partMember', /Part-Member/], ['ysa', /YSA/], ['bday', /Birthday/]]) {
      await imp(E, 'import', 'identifiers: ' + kind, '#ident-file-' + kind, pdf(pat), () => applyIdentPlan(),
        async () => { const w = await ward(); return { ok: !!w.identMeta?.[kind], obs: { flagged: w.members.filter(m => m.ident?.[kind]).length, hh: w.households.filter(h => h.partMember).length, count: w.identMeta?.[kind]?.count, unmatched: (w.identMeta?.[kind]?.unmatched || []).length } }; });
    }
    await ev(C, () => 0);
    const C3 = await open('cora@example.com');
    await ev(C3, () => showTab('council'));
    for (const [key, pat] of [['new', /NewMembers/], ['returning', /returning/], ['mission', /_pbt/]]) {
      await imp(C3, 'import', 'covenant path: ' + key, '#cp-file-' + key, pdf(pat), () => applyCovenantPlan(),
        async () => { const g = ((await ward()).groups || {})[key] || []; return { ok: g.length > 0, obs: { entries: g.length, withSnapshot: g.filter(e => e.lcr).length } }; });
    }
    await ev(E, () => showTab('stats'));
    for (const [kind, pat] of [['us', /Unit_Statistics/], ['qr', /quarterly_report_recent/], ['ki', /Key_Indicators_and_Trends_full/], ['fh', /Family_History/]]) {
      await imp(E, 'import', 'unit stats: ' + kind, '#stats-file-' + kind, pdf(pat), () => applyStatsPlan(),
        async () => { const d = (await adb.doc('wardData/stats').get()).data() || {}; return { ok: !!d[kind], obs: { keys: Object.keys(d[kind] || {}).sort() } }; });
    }
  } else rec('import', 'real-PDF imports skipped (set REAL_PDF_DIR)', true, null, 'info');

  await check('round3', 'sisters: every female member listed; ministers can include a husband; no RS household pool', async () => {
    const o = await ev(R, () => { showTab('sisters'); const n = document.querySelectorAll('#sisters-table tbody tr').length;
      openRSModal('proposedRS'); const opts = [...document.querySelectorAll('#rs-m1 optgroup')].map(g => g.label + ':' + g.children.length); closeModal('rs-modal');
      showTab('households'); const hhRsCol = [...document.querySelectorAll('#tab-households th')].some(th => /RS Pool/.test(th.innerText));
      return { listed: n, females: S.members.filter(m => isFemale(m.gender)).length, opts, hhRsCol }; });
    const admin = await ev(A, () => canEditRS());
    const eq = await ev(E, () => canEditRS());
    return { pass: o.listed === o.females && o.opts.length === 2 && /Brothers/.test(o.opts[1]) && !o.hhRsCol && admin && !eq, obs: { ...o, adminCanEditRS: admin, eqCan: eq } };
  });
  // Late, since it replaces Current: the Ministering Interviews – Elders Quorum page.
  await check('round3', 'EQ Ministering Interviews PDF → Current (districts, households by name)', async () => {
    const rows = [
      ['District 1', 'Lindqvist, Erik', [[['Brandt, Hugo', 'Moreau, Jules'], ['Brandt, Hugo & Ilse', 'Tanaka, Ken', 'Nobody, Notin Ward']]]],
      ['District 2', 'Carter, Sam', [[['Osei, Kofi', 'Tanaka, Ken'], ['Whitfield, Daniel & Grace']], [['Whitfield, Daniel'], ['Okafor, Ruth', 'Osei, Kofi']]]]];
    const cell = 'padding:2px 0 2px 2px;vertical-align:middle;font:10px Arial';
    const html = `<style>body{margin:40px;font:10px Arial} table{border-collapse:collapse;width:100%} th{text-align:left;${cell};background:#e3edf0}
      tr.s td{background:#e3edf0}</style><div>Ministering Interviews - Elders Quorum</div><div>Current Quarter</div>` +
      rows.map(([d, lead, comps]) => `<p>${d}</p><p>Presidency Member: ${lead}</p><table><tr><th style="width:150px">Companionships</th><th>Oct</th><th>Nov</th><th>Dec</th><th>Quarter 4</th><th style="width:150px">Households</th></tr>` +
        comps.map(([ms, hh], i) => `<tr class="${i % 2 ? '' : 's'}"><td style="${cell}">${ms.map(n => `<div>${n}</div>`).join('')}</td><td></td><td></td><td></td><td></td><td style="${cell}">${hh.map(n => `<div>${n}</div>`).join('')}</td></tr>`).join('') + '</table>').join('');
    const pg = await browser.newPage(); await pg.setContent(html);
    const f = path.join(__dirname, 'synthetic-interviews.pdf'); await pg.pdf({ path: f, format: 'Letter', printBackground: true }); await pg.close();
    await ev(E, () => showTab('current')); await E.page.setInputFiles('#min-file-eq', f); await sleep(2500); fs.unlinkSync(f);
    const review = await ev(E, () => document.getElementById('min-review-eq').innerText.replace(/\s+/g, ' '));
    await ev(E, () => applyMinPlan()); await sleep(600); await flush(E);
    const cur = (await ward()).current;
    const a = cur.find(c => c.m1Id === 'm5'), b = cur.find(c => c.m1Id === 'm11'), solo = cur.find(c => c.m1Id === 'm1');
    const meta = (await ward()).importMeta?.['ministering-eq'];
    const wp = await until(async () => { const x = await ward(); return x.members.find(m => m.id === 'm11')?.inPool === true && x; }) || await ward();
    const pooled = { osei: wp.members.find(m => m.id === 'm11').inPool, h7: wp.households.find(h => h.id === 'h7').inPool, h2: wp.households.find(h => h.id === 'h2').inPool };
    return { pass: cur.length === 3 && a && a.m2Id === 'm7' && a.households.join() === 'h4,h6' && a.extraAssignees.join() === 'Nobody, Notin Ward' && a.district === 'District 1' && a.districtLeader === 'Lindqvist, Erik'
        && b && b.households.join() === 'h1' && b.district === 'District 2' && solo && solo.households.join() === 'h2,h7' && /3 companionships/.test(review) && /Nobody, Notin Ward/.test(review) && meta?.count === 3 && pooled.osei === true && pooled.h7 === true && pooled.h2 === true,
      obs: { pooled, n: cur.length, a: a && [a.m2Id, a.households, a.extraAssignees, a.district, a.districtLeader], b: b && [b.households, b.district], solo: solo && solo.households, review: review.slice(0, 120) } };
  });

  await check('round3', 'districts: grouped, ▲▼ only within a district, draft district changeable and marked', async () => {
    await ev(E, () => { window.confirm = () => true; S.proposed = []; return copyCurrentToProposed(); }); await sleep(300); await flush(E);
    const o = await ev(E, async () => {
      showTab('current'); const curHeads = [...document.querySelectorAll('#current-list .district-head')].map(h => h.innerText.split('·')[0].trim());
      showTab('propose'); const heads = [...document.querySelectorAll('#proposed-list .district-head')].map(h => h.innerText.split('·')[0].trim());
      const d1 = S.proposed.filter(c => c.district === 'District 1'), d2 = S.proposed.find(c => c.district === 'District 2');
      // the one in District 2 can't move up into District 1
      const before = S.proposed.map(c => c.id).join(); await moveCompanionship('proposed', d2.id, -1); const blocked = S.proposed.map(c => c.id).join() === before;
      if (d1.length > 1) await moveCompanionship('proposed', d1[1].id, -1);
      const moved = d1.length > 1 ? S.proposed.filter(c => c.district === 'District 1')[0].id === d1[1].id : true;
      openEditModal(d2.id, 'proposed'); const opts = [...document.querySelectorAll('#edit-district option')].map(x => x.value);
      document.getElementById('edit-district').value = 'District 1'; saveEditCompanionship();
      const rec = S.proposed.find(c => c.id === d2.id);
      const chip = [...document.querySelectorAll('#proposed-list .companionship-card')].find(el => el.innerHTML.includes(d2.id))?.innerText || '';
      return { curHeads, heads, blocked, moved, opts, district: rec.district, leader: rec.districtLeader, chip: /District 2 → District 1/.test(chip) };
    });
    await flush(E);
    return { pass: o.curHeads.join() === 'District 1,District 2' && o.heads.join() === 'District 1,District 2' && o.blocked && o.moved && o.opts.join() === ',District 1,District 2' && o.district === 'District 1' && o.leader === 'Lindqvist, Erik' && o.chip, obs: o };
  });
  await check('round3', 'Draft vs Current: same people stored differently aren\'t changes; Match to Current fixes or dismisses', async () => {
    const o = await ev(E, async () => {
      window.confirm = () => true; S.proposed = []; await copyCurrentToProposed();
      const st = id => draftDiff('proposed').byId.get(id)?.status;
      const d = S.proposed.find(c => c.m1Id === 'm5');
      // same minister by name only (no id), and a household written by name instead of id
      d.m2Id = null; d.households = d.households.map(h => S.households.find(x => x.id === h)?.name || h);
      const normalised = st(d.id);
      // real-looking differences: drop a household, add another, change district
      d.households = d.households.slice(1).concat(['h8']); d.district = 'District 2';
      const changed = st(d.id);
      renderProposed(); const btn = [...document.querySelectorAll('#proposed-list .companionship-card')].find(el => el.innerHTML.includes(d.id))?.querySelector('button[onclick*="openMatchModal"]');
      btn?.click(); const rows = [...document.querySelectorAll('#match-body label')].map(l => l.innerText.trim());
      applyMatch(true); const after = st(d.id);
      // dismiss: make it differ again, disregard, and the offer goes away
      d.households = [...d.households, 'h3']; renderProposed(); openMatchModal('proposed', d.id); applyMatch(false);
      const offered = draftDiff('proposed').byId.get(d.id).offer;
      return { normalised, changed, button: !!btn, rows, after, offered, dismissed: d.matchDismissed };
    });
    await flush(E);
    return { pass: o.normalised === 'same' && o.changed === 'changed' && o.button && o.rows.length === 3 && o.after === 'same' && o.offered === false, obs: o };
  });
  await check('round3', 'threads follow the person: Goals from Covenant Path show on Members; switcher; companionship notes stay separate', async () => {
    const o = await ev(E, async () => {
      showTab('members'); openNotesModal('member', 'm9', '', 'goals');
      const goals = [...document.querySelectorAll('#notes-list > div')].map(d => d.innerText).filter(t => /Parity goal/.test(t)).length;
      const pills = [...document.querySelectorAll('#notes-field-switch button')].map(b => b.innerText);
      setNotesField('nextSteps'); document.getElementById('note-text').value = 'Person next step'; addNote(); closeModal('notes-modal');
      // a companionship note naming a member doesn't appear in their Covenant Path notes
      const c = S.current[0]; openNotesModal('current', c.id); document.getElementById('note-text').value = 'Companionship note about Tanaka, Ken'; addNote(); closeModal('notes-modal');
      const entry = groupList('returning').find(e => e.memberId === 'm9');
      const merged = entry ? groupMergedNotes(entry).map(r => r.n.text) : [];
      const btn = [...document.querySelectorAll('#mrow-m9 button')].map(b => b.innerText).find(t => /Goals/.test(t));
      return { goals, pills, merged: merged.some(t => /Companionship note/.test(t)), btn, hasEntry: !!entry };
    });
    await flush(E);
    const m9 = (await ward()).members.find(x => x.id === 'm9');
    return { pass: o.goals === 1 && o.pills.length === 3 && !o.merged && (m9.nextSteps || []).some(n => n.text === 'Person next step') && /Goals 1/.test(o.btn || ''), obs: o };
  });
  await check('round3', 'old list-entry threads move onto the member / household (presidency load)', async () => {
    // a goal written on an entry the old way
    const w0 = await ward(); const e = (w0.groups.new || [])[0];
    if (!e) return { pass: true, obs: 'no entry in seed' };
    await adb.collection('notes').doc('oldgoal1').set({ id: 'oldgoal1', text: 'Old-style goal', author: 'Cora Lane', authorId: 'uCouncil', date: '2026-01-01T00:00:00Z', target: { type: 'group', group: 'new', id: e.id, field: 'goals' } });
    await E.page.reload(); await E.page.waitForFunction(() => document.getElementById('app-shell').style.display === 'block', null, { timeout: 20000 }); await sleep(1500); await flush(E);
    const n = (await adb.collection('notes').doc('oldgoal1').get()).data();
    return { pass: n.target.type === 'member' && n.target.id === e.memberId && n.target.field === 'goals', obs: n.target };
  });
  await check('round3', 'draft changes notify the other EQ presidency members (not the editor)', async () => {
    await ev(E, () => { openNotesModal('proposed', S.proposed[0].id); document.getElementById('note-text').value = 'Draft note'; addNote(); closeModal('notes-modal'); }); await flush(E);
    // Pushes are throttled (one per person per 3 minutes, and earlier checks edited the draft), so look for the feed entry and any push this run.
    const f = await until(async () => ((await adb.doc('profiles/uAdmin').get()).data().feed || []).find(x => /note on a brothers' draft companionship/.test(x.text)));
    const all = (await adb.collection('__pushLog').get()).docs.map(d => d.data()).filter(x => x.data.tag === 'ministering-draft');
    const toAdmin = all.some(x => x.tokens.includes('tok-uAdmin')), toEditor = all.some(x => x.tokens.includes('tok-eq')), toRs = all.some(x => x.tokens.includes('tok-uRs'));
    return { pass: !!f && f.link === '#tab=propose' && toAdmin && !toEditor && !toRs, obs: { feed: f?.text, toAdmin, toEditor, toRs, editorBodies: all.filter(x => x.tokens.includes('tok-eq')).map(x => x.data.body) } };
  });
  await check('round3', 'a companionship removed from the draft is marked on Current and shown greyed in the draft', async () => {
    const o = await ev(E, async () => {
      window.confirm = () => true; S.proposed = []; await copyCurrentToProposed();
      const gone = S.current[0]; S.proposed = S.proposed.filter(p => p.fromId !== gone.id);
      showTab('current'); renderCurrent();
      const curCard = [...document.querySelectorAll('#current-list .companionship-card')].find(el => el.innerHTML.includes(esc(compLabel(gone)).split(' + ')[0]) && el.classList.contains('diff-removed'));
      showTab('propose'); renderProposed();
      const ghost = [...document.querySelectorAll('#proposed-list .companionship-card.diff-removed')].map(el => el.innerText);
      return { cur: !!curCard && /Removed in the draft/.test(curCard.innerText), ghost: ghost.length, ghostText: (ghost[0] || '').slice(0, 80), otherMarked: document.querySelectorAll('#current-list .diff-removed').length };
    });
    await flush(E);
    return { pass: o.cur && o.ghost === 1 && /Removed — in Current/.test(o.ghostText), obs: o };
  });
  await check('round3', 'households: Not geocoded filter and Sort by', async () => {
    const o = await ev(E, () => { showTab('households');
      const rows = () => [...document.querySelectorAll('#households-table tbody tr')].map(r => r.id.replace('hrow-', ''));
      const f = document.getElementById('hh-addr-filter'), so = document.getElementById('hh-sort');
      f.value = 'not-geocoded'; renderHouseholds(); const notGeo = rows();
      f.value = ''; so.value = 'name-desc'; renderHouseholds(); const desc = rows();
      so.value = 'geo'; renderHouseholds(); const geo = rows();
      so.value = 'name'; renderHouseholds(); const asc = rows();
      const expectNot = S.households.filter(h => h.address && !h.lat).map(h => h.id).sort();
      return { notGeo: [...notGeo].sort(), expectNot, descFirst: desc[0], ascLast: asc[asc.length - 1], geoFirst: geo[0], geoFirstOk: expectNot.includes(geo[0]) || !expectNot.length };
    });
    return { pass: o.notGeo.join() === o.expectNot.join() && o.descFirst === o.ascLast && o.geoFirstOk, obs: o };
  });
  await check('round3', 'households: map location pasted by hand (coordinates or a Google Maps link)', async () => {
    const o = await ev(E, async () => {
      const parsed = [parseLatLng('28.03456, -80.60123'), parseLatLng('https://www.google.com/maps/place/X/@28.0101,-80.6202,17z/data=!3d28.0105!4d-80.6207'), parseLatLng('hello')];
      const h = S.households.find(x => !x.lat && x.address) || S.households[0];
      openHHEditModal(h.id); document.getElementById('hh-edit-latlng').value = '27.9901, -80.6501'; await saveHHAddress(true);
      const saved = { lat: h.lat, lng: h.lng, manual: h.geoManual };
      const snap = S.households.map(x => [x, x.lat, x.lng]);
      clearGeoCache(); const kept = h.lat === 27.9901;
      snap.forEach(([x, la, ln]) => { if (la != null) { x.lat = la; x.lng = ln; } }); dbUpsertHouseholds(S.households);   // put the others back
      return { parsed, saved, kept, id: h.id };
    });
    await flush(E);
    const h = (await ward()).households.find(x => x.id === o.id);
    return { pass: o.parsed[0]?.lat === 28.03456 && o.parsed[1]?.lat === 28.0105 && o.parsed[1]?.lng === -80.6207 && o.parsed[2] === null && h.lat === 27.9901 && h.lng === -80.6501 && h.geoManual === true && o.kept, obs: o };
  });
  await check('round3', 'draft districts: add one with a leader, rename one, delete one', async () => {
    const o = await ev(E, async () => {
      window.confirm = () => true; S.proposed = []; await copyCurrentToProposed();
      showTab('propose'); openDistrictsModal('proposed');
      const before = _ddCtx.rows.map(r => r.name);
      _ddCtx.rows[0].name = 'District One';                      // rename District 1
      _ddCtx.rows.splice(1, 1);                                  // delete District 2
      _ddCtx.rows.push({ name: 'District 4', orig: '', leaderId: 'm7', origLeaderId: '' });
      saveDistricts();
      const heads = [...document.querySelectorAll('#proposed-list .district-head')].map(h => h.innerText);
      const summary = document.getElementById('diff-summary-proposed').innerText;
      const d1 = S.proposed.filter(c => c.district === 'District One').length, none = S.proposed.filter(c => !c.district).length;
      openEditModal(S.proposed[0].id, 'proposed'); const opts = [...document.querySelectorAll('#edit-district option')].map(x => x.value); closeModal('edit-modal');
      return { before, heads, summary, d1, none, opts, dd: S.draftDistricts };
    });
    await flush(E);
    const w = await ward();
    return { pass: o.before.join() === 'District 1,District 2' && o.d1 === 1 && o.none === 2 && o.opts.join() === ',District One,District 4'
        && /\+ 🗺️ District 4 · Moreau, Jules/.test(o.summary) && /− 🗺️ District 2/.test(o.summary) && (w.draftDistricts || []).map(d => d.name).join() === 'District One,District 4'
        && o.heads.some(h => /No district/.test(h)), obs: o };
  });
  await check('round3', 'a brother already in a companionship can be picked for another', async () => {
    const o = await ev(E, () => { showTab('propose'); const taken = ministersOf(S.proposed.find(c => c.m1Id) || {})[0]?.id;
      openAddModal('proposed'); const opt = [...document.getElementById('add-m1').options].find(x => x.value === taken);
      closeModal('add-modal'); return { taken, listed: !!opt, text: opt?.text || '' }; });
    return { pass: !!o.taken && o.listed && /already in \d/.test(o.text), obs: o };
  });
  await check('round3', 'unmatched name: pick a household → linked and remembered for next import', async () => {
    const mk = async () => {
      const cell = 'padding:2px 0 2px 2px;vertical-align:middle;font:10px Arial';
      const html = `<style>body{margin:40px;font:10px Arial} table{border-collapse:collapse;width:100%} th{text-align:left;${cell};background:#e3edf0} tr.s td{background:#e3edf0}</style>
        <div>Ministering Interviews - Elders Quorum</div><p>District 1</p><p>Presidency Member: Carter, Sam</p><table><tr><th style="width:150px">Companionships</th><th>Oct</th><th>Nov</th><th>Dec</th><th>Quarter 4</th><th style="width:150px">Households</th></tr>
        <tr class="s"><td style="${cell}"><div>Brandt, Hugo</div><div>Moreau, Jules</div></td><td></td><td></td><td></td><td></td><td style="${cell}"><div>Lindqvist, E.</div><div>Okafor, Ruth</div></td></tr></table><div>2 Nov 2026</div>`;
      const pg = await browser.newPage(); await pg.setContent(html); const f = path.join(__dirname, 'synthetic-iv2.pdf'); await pg.pdf({ path: f, format: 'Letter', printBackground: true }); await pg.close(); return f;
    };
    let f = await mk(); await ev(E, () => showTab('current')); await E.page.setInputFiles('#min-file-eq', f); await sleep(2500);
    const picker = await ev(E, () => { const sel = [...document.querySelectorAll('#min-review-eq select')].find(x => /Lindqvist, E\./.test(x.parentElement.innerText)); return sel ? [...sel.options].slice(0, 4).map(o => o.text) : null; });
    await ev(E, () => { _minPlan.fixes['Lindqvist, E.'] = 'h3'; return applyMinPlan(); }); await flush(E);
    let w = await until(async () => { const x = await ward(); return x.current.length === 1 && x; }) || await ward(); const c1 = w.current.find(c => c.m1Id === 'm5'); const alt = w.households.find(h => h.id === 'h3').altNames;
    await E.page.setInputFiles('#min-file-eq', f); await sleep(2500); fs.unlinkSync(f);
    const second = await ev(E, () => _minPlan.comps[0].hhs.map(x => x.h?.id || null));
    await ev(E, () => cancelMinImport());
    return { pass: !!picker && picker.some(t => /Lindqvist, Erik/.test(t)) && c1 && c1.households.join() === 'h3,h2' && (alt || []).includes('Lindqvist, E.') && second.join() === 'h3,h2',
      obs: { picker, hh: c1?.households, alt, second } };
  });
  await check('round3', 'interviews: tick a month on Current, saved, counted; import adds LCR months', async () => {
    const o = await ev(E, () => { showTab('current'); const c = S.current[0]; const q = quarterNow();
      toggleInterview('current', c.id, q.months[1]); const pill = [...document.querySelectorAll('#current-list .iv-pill.on')].map(b => b.innerText);
      const stat = document.getElementById('current-stats').innerText;
      const merged = mergeInterviews(c.interviews, q.key, { months: { [q.months[0]]: ['X'] }, done: true }, c);
      return { id: c.id, q: q.key, m: q.months[1], pill, stat, merged: Object.keys(merged[q.key].months).sort() }; });
    await flush(E);
    const c = (await ward()).current.find(x => x.id === o.id);
    const R0 = await ev(R, () => { showTab('currentRS'); return [...document.querySelectorAll('#currentRS-list .iv-pill')].every(b => b.disabled) || !document.querySelector('#currentRS-list .iv-pill'); });
    const council = await ev(C, () => { refreshFromCloud && null; showTab('current'); return [...document.querySelectorAll('#current-list .iv-pill')].every(b => b.disabled); });
    return { pass: c?.interviews?.[o.q]?.months?.[o.m]?.length > 0 && o.pill.length === 1 && /1\/\d+\s*Interviewed/.test(o.stat) && o.merged.length === 2 && council,
      obs: { stored: !!c?.interviews?.[o.q], pill: o.pill, merged: o.merged, councilReadOnly: council, rsSeesOwnOnly: R0 } };
  });
  await check('round3', 'RS Ministering Interviews PDF → Current sisters (individual sisters, districts)', async () => {
    const cell = 'padding:2px 0 2px 2px;vertical-align:middle;font:10px Arial';
    const html = `<style>body{margin:40px;font:10px Arial} table{border-collapse:collapse;width:100%} th{text-align:left;${cell};background:#e3edf0} tr.s td{background:#e3edf0}</style>
      <div>Ministering Interviews - Relief Society</div><p>District 4 - Do not contact</p><p>Presidency Member: Unassigned</p><table><tr><th style="width:150px">Companionships</th><th>Oct</th><th>Nov</th><th>Dec</th><th>Quarter 4</th><th style="width:150px">Households</th></tr>
      <tr class="s"><td style="${cell}"><div>Brandt, Ilse</div><div>Moreau, Claire</div></td><td></td><td></td><td></td><td></td><td style="${cell}"><div>Okafor, Ruth</div><div>Delgado, Marta</div><div>Tanaka, Ken &amp; Yumi</div></td></tr></table><div>2 Nov 2026</div>`;
    const pg = await browser.newPage(); await pg.setContent(html); const f = path.join(__dirname, 'synthetic-rs.pdf'); await pg.pdf({ path: f, format: 'Letter', printBackground: true }); await pg.close();
    await ev(R, () => showTab('currentRS')); await R.page.setInputFiles('#min-file-rs', f); await sleep(2500); fs.unlinkSync(f);
    const boxes = await ev(R, () => document.getElementById('min-review-rs').innerText.match(/Replace/g)?.length || 0);
    await ev(R, () => applyMinPlan()); await flush(R);
    const c = (await until(async () => { const x = await ward(); return x.currentRS.some(y => y.m1Id === 'm6') && x; }) || await ward()).currentRS.find(x => x.m1Id === 'm6');
    const wr = await until(async () => { const x = await ward(); return x.members.find(m => m.id === 'm10')?.rsRecipient === true && x; }) || await ward();
    const rp = ['m3', 'm12', 'm10'].map(id => wr.members.find(m => m.id === id).rsRecipient);
    return { pass: rp.every(v => v === true) && !!c && c.m2Id === 'm8' && c.assignees.join() === 'm3,m12,m10' && !c.households.length && c.district === 'District 4 - Do not contact' && boxes === 1,
      obs: { receivesPool: rp, assignees: c?.assignees, hh: c?.households, district: c?.district, replaceBoxes: boxes } };
  });
  await check('round3', 'Member List PDF: rename kept as the same person, changes chosen, new and gone listed', async () => {
    const rows = [['Whitfield, Daniel James', 'M', 34, '(321) 555-0101'], ['Whitfield, Grace', 'F', 32, '(321) 555-0999'], ['Okafor, Ruth', 'F', 71, ''], ['Lindqvist, Erik', 'M', 28, ''], ['Brandt, Hugo', 'M', 46, ''], ['Brandt, Ilse', 'F', 44, ''],
      ['Moreau, Jules', 'M', 52, ''], ['Moreau, Claire', 'F', 50, ''], ['Tanaka, Ken', 'M', 39, ''], ['Tanaka, Yumi', 'F', 37, ''], ['Osei, Kofi', 'M', 23, ''], ['Newcomer, Nina Rose', 'F', 30, '(321) 555-0303']];
    const html = `<style>body{margin:40px;font:10px Arial} td,th{text-align:left;padding:6px 8px}</style><div>Member List</div><div>Test Ward</div><table><tr><th>Name</th><th>Gender</th><th>Age</th><th>Birth Date</th><th>Phone Number</th><th>Email</th></tr>
      ${rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td><td>${r[2]}</td><td>${/Newcomer/.test(r[0]) ? '14 Mar 1996' : '1 Jan 1990'}</td><td>${r[3]}</td><td>${/Newcomer/.test(r[0]) ? 'nina@example.org' : ''}</td></tr>`).join('')}</table><div>Count: ${rows.length}</div>`;
    const pg = await browser.newPage(); await pg.setContent(html); const f = path.join(__dirname, 'synthetic-members.pdf'); await pg.pdf({ path: f, format: 'Letter' }); await pg.close();
    await ev(E, () => showTab('import')); await E.page.setInputFiles('#rec-file-members', f); await sleep(2500); fs.unlinkSync(f);
    const o = await ev(E, () => { const p = _recPlan; const r = p.pairs.find(x => x.rename); const ph = p.pairs.find(x => x.ex.id === 'm2').fields.find(f => f.key === 'phone');
      if (ph) ph.use = false;   // keep ours
      return { total: p.total, rename: r && [r.ex.id, r.r.name, r.same], phoneChange: !!ph, adds: p.adds.map(a => a.r.name), gone: p.gone.map(g => g.ex.name), text: document.getElementById('rec-review').innerText.slice(0, 200) }; });
    await ev(E, () => applyRecPlan()); await flush(E);
    const w = await until(async () => { const x = await ward(); return x.members.some(m => m.name === 'Newcomer, Nina Rose') && x; }) || await ward(); const d = w.members.find(m => m.id === 'm1'), g = w.members.find(m => m.id === 'm2'), h = w.members.find(m => m.id === 'm5');
    const nn = w.members.find(m => m.name === 'Newcomer, Nina Rose');
    const ui = await ev(E, id => { showTab('members'); const row = document.getElementById('mrow-' + id); return { tel: row?.querySelector('a[href^="tel:"]')?.getAttribute('href'), mail: row?.querySelector('a[href^="mailto:"]')?.getAttribute('href'), shown: /1996|Mar 14/.test(row?.innerText || '') }; }, nn?.id);
    const hhLink = await ev(E, async () => { const b = document.querySelector('#mrow-m3 button.ident-link'); if (!b) return null; b.click(); await new Promise(r => setTimeout(r, 300)); return document.querySelector('#tab-households tr.row-flash')?.id; });
    return { pass: nn?.email === 'nina@example.org' && nn?.birthDate === '1996-03-14' && nn?.ident?.bday === '03-14' && ui.tel === 'tel:+13215550303' && ui.mail === 'mailto:nina@example.org' && !ui.shown && hhLink === 'hrow-h2'
        && o.total === 12 && o.rename?.[0] === 'm1' && o.rename[2] === true && o.phoneChange && o.adds.join() === 'Newcomer, Nina Rose' && o.gone.join() === 'Delgado, Marta'
        && d.name === 'Whitfield, Daniel James' && (d.altNames || []).includes('Whitfield, Daniel') && g.phone !== '(321) 555-0999' && h.age === 46 && w.members.some(m => m.name === 'Newcomer, Nina Rose') && w.members.some(m => m.id === 'm12'),
      obs: { ...o, text: undefined, dName: d.name, alt: d.altNames, grace: g.phone, hugoAge: h.age, email: nn?.email, bday: nn?.ident?.bday, ui, hhLink } };
  });
  await check('round3', 'Member List PDF (Households view): address change, people linked to their household', async () => {
    const H = [['Whitfield, Daniel James &amp; Grace', '(321) 555-0101', ['120 Sample Ave', 'Palm Bay FL 32909-1234'], [['Daniel James', 'male', 34], ['Grace', 'female', 32]]],
      ['Okafor, Ruth', '', ['46 Example Ct', 'Palm Bay FL 32905'], [['Ruth', 'female', 71]]],
      ['Newcomer, Nina Rose', '(321) 555-0303', ['5 New St', 'Palm Bay FL 32909'], [['Nina Rose', 'female', 30], ['Osei, Kofi', 'male', 23]]]];
    const L = 'line-height:14px;font:10px Arial';
    const html = `<style>body{margin:40px;font:10px Arial} td,th{text-align:left;padding:4px 8px;vertical-align:top;${L}}</style><div>Member List</div><table><tr><th>Name</th><th>Household<br>Members</th><th>Gender</th><th>Age</th></tr>
      ${H.map(([n, ph, ad, pp]) => `<tr><td><b>${n}</b><br>${[ph, ...ad].filter(Boolean).join('<br>')}</td><td>${pp.map(q => `<b>${q[0]}</b>`).join('<br>')}</td><td>${pp.map(q => q[1]).join('<br>')}</td><td>${pp.map(q => q[2]).join('<br>')}</td></tr>`).join('')}</table><div>Count: 3</div>`;
    const pg = await browser.newPage(); await pg.setContent(html); const f = path.join(__dirname, 'synthetic-hh.pdf'); await pg.pdf({ path: f, format: 'Letter' }); await pg.close();
    await E.page.setInputFiles('#rec-file-households', f); await sleep(2500); fs.unlinkSync(f);
    const o = await ev(E, () => { const p = _recPlan; return { total: p.total, renames: p.pairs.filter(x => x.rename).map(x => [x.ex.id, x.same]), changes: p.pairs.flatMap(x => x.fields.map(f => x.ex.id + ':' + f.key)), adds: p.adds.map(a => a.r.name), gone: p.gone.length }; });
    await ev(E, () => applyRecPlan()); await flush(E);
    const w = await until(async () => { const x = await ward(); return x.households.some(h => /Newcomer/.test(h.name)) && x; }) || await ward(); const h1 = w.households.find(h => h.id === 'h1'), h2 = w.households.find(h => h.id === 'h2'), nh = w.households.find(h => /Newcomer/.test(h.name));
    const kofi = w.members.find(m => m.id === 'm11'), nina = w.members.find(m => m.name === 'Newcomer, Nina Rose');
    const row = await ev(E, id => { showTab('households'); const r = document.getElementById('hrow-' + id); const p = [...(r?.querySelectorAll('.hh-person') || [])].find(x => /Newcomer/.test(x.innerText));
      return p ? { tel: p.querySelector('a[href^="tel:"]')?.getAttribute('href'), mail: p.querySelector('a[href^="mailto:"]')?.getAttribute('href') } : null; }, nh?.id);
    return { pass: o.total === 3 && o.renames.length === 1 && o.renames[0][0] === 'h1' && o.changes.includes('h2:address') && !o.changes.includes('h1:address') && o.adds.join() === 'Newcomer, Nina Rose'
        && row?.tel === 'tel:+13215550303' && row?.mail === 'mailto:nina@example.org' && h1.name.startsWith('Whitfield, Daniel James') && h1.lat && h2.address.startsWith('46 Example') && !h2.lat && nh && kofi.householdId === nh.id && nina.householdId === nh.id,
      obs: { ...o, row, h1: h1?.name, h1geo: !!h1?.lat, h2: h2?.address, h2geo: !!h2?.lat, kofiMoved: kofi?.householdId === nh?.id, nina: nina?.householdId === nh?.id } };
  });

  await check('round3', 'phone: tab menu instead of the strip, tables as cards, no sideways scrolling', async () => {
    await E.page.setViewportSize({ width: 390, height: 844 });
    const out = {};
    for (const tab of ['members', 'households', 'current', 'propose', 'sisters']) {
      await ev(E, t => showTab(t), tab); await sleep(400);
      out[tab] = await ev(E, () => ({ wide: document.documentElement.scrollWidth > window.innerWidth + 2, select: getComputedStyle(document.getElementById('nav-select-wrap')).display !== 'none',
        nav: getComputedStyle(document.querySelector('nav')).display, cards: document.querySelectorAll('.tab-content.active table.phone-cards').length,
        opt: document.getElementById('nav-select').value }));
      if (process.env.SHOTS) await E.page.screenshot({ path: path.join(process.env.SHOTS, 'phone-' + tab + '.png') });
    }
    await E.page.setViewportSize({ width: 1280, height: 900 });
    const ok = Object.entries(out).every(([t, o]) => !o.wide && o.select && o.nav === 'none' && o.opt === t);
    return { pass: ok && out.members.cards > 0 && out.households.cards > 0, obs: out };
  });

  // Last, since it wipes the shared doc: can a council member delete it?
  await check('rules-today', 'council deletes the whole ward doc', async () => ({ pass: true, obs: await tryOp(C2, `await db.doc('wardData/shared').delete()`) }), 'security');

  // Taken off the allowed list while signed in: the next refused save signs them out (final rules only).
  if (process.env.PHASE === 'final' && await ev(R, () => typeof sessionProblem === 'function')) {
    await check('signout', 'removed from the allowed list → signed out with the notice', async () => {
      await R.page.reload(); await waitScreen(R.page, ['app-shell']);
      await adb.doc('allowedUsers/rita@example.com').delete();
      await ev(R, () => toggleHHRSPool('h8'));
      await flush(R).catch(() => {});          // the page reloads itself mid-save
      await waitScreen(R.page, ['auth-screen']).catch(() => {}); await sleep(1000);
      const sc = await screen(R), notice = await ev(R, () => document.getElementById('auth-notice').innerText);
      return { pass: sc === 'auth-screen' && notice === 'For security, please sign in again.', obs: { screen: sc, notice } };
    });
  }

  // ── Wrap-up ────────────────────────────────────────────────
  const errs = {}; for (const [s, n] of [[A, 'admin'], [E, 'eq'], [R, 'rs'], [C, 'council']]) errs[n] = s.errors;
  rec('health', 'no uncaught page errors', Object.values(errs).every(e => !e.length), errs);
  rec('health', 'blocked outside hosts', true, [...blocked].sort(), 'info');
  rec('health', 'SDK', true, await ev(E, () => ({ version: firebase.SDK_VERSION, modular: !!firebase.modular })), 'info');
  const dialogs = {}; for (const [s, n] of [[A, 'admin'], [E, 'eq'], [R, 'rs'], [C, 'council']]) dialogs[n] = s.dialogs.filter(d => !/^confirm/.test(d));
  rec('health', 'alerts shown', true, dialogs, 'info');
  await browser.close();
  const out2 = path.join(__dirname, `results-${LABEL}.json`);
  fs.writeFileSync(out2, JSON.stringify({ label: LABEL, app: APP_FILE, at: new Date().toISOString(), results }, null, 1));
  const f = results.filter(r => r.kind === 'feature');
  console.log(`\n${f.filter(r => r.pass).length}/${f.length} feature checks passed; ${results.filter(r => r.kind === 'security').length} access-rule observations recorded → ${out2}`);
  process.exit(0);
})().catch(async e => { console.error(e); try { await browser?.close(); } catch {} process.exit(1); });
