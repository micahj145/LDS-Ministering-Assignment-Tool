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
  try { const r = await fn(); rec(group, name, r.pass, r.obs, kind); return r; }
  catch (e) { rec(group, name, false, { error: e.message.split('\n')[0] }, kind); return { pass: false }; }
}
async function until(fn, ms = 15000) {
  const t0 = Date.now(); let v;
  while (Date.now() - t0 < ms) { v = await fn(); if (v) return v; await sleep(300); }
  return v;
}
const ward = async () => (await adb.doc('wardData/shared').get()).data();
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
  await ctx.addInitScript(() => { window.__FIREBASE_EMULATORS__ = { projectId: 'demo-parity', auth: 'http://127.0.0.1:9099', firestoreHost: '127.0.0.1', firestorePort: 8080 }; });
  const page = await ctx.newPage();
  const s = { ctx, page, errors: [], dialogs: [], email };
  page.on('pageerror', e => s.errors.push(e.message));
  page.on('dialog', d => { s.dialogs.push(d.type() + ': ' + d.message().slice(0, 120)); d.type() === 'prompt' ? d.dismiss() : d.accept(); });
  await page.goto(BASE + APP_FILE);
  await page.waitForFunction(() => ['auth-screen', 'app-shell', 'pending-screen'].some(id => document.getElementById(id)?.style.display === 'block'), null, { timeout: 20000 });
  if (email) await signIn(s, email, opts.password || PW);
  return s;
}
async function signIn(s, email, password) {
  const { page } = s;
  await page.fill('#auth-email', email); await page.fill('#auth-password', password);
  await page.click('#auth-submit-btn');
  await page.waitForFunction(() => document.getElementById('app-shell').style.display === 'block'
    || document.getElementById('pending-screen').style.display === 'block'
    || (document.getElementById('auth-error').textContent || '').length > 0, null, { timeout: 20000 });
  await sleep(500);
}
const ev = (s, fn, arg) => s.page.evaluate(fn, arg);
const flush = s => ev(s, () => (typeof _syncTimer !== 'undefined' && _syncTimer) ? (clearTimeout(_syncTimer), runSync()) : null);
const screen = s => ev(s, () => ['auth-screen', 'app-shell', 'pending-screen'].find(id => document.getElementById(id).style.display === 'block'));
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
    return { pass: !!a.rsPool && b.rsRecipient === false, obs: { pool: a.rsPool, recipient: b.rsRecipient } };
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
    const e2 = ((await ward()).groups.returning || []).find(x => x.memberId === 'm9');
    return { pass: !!e2 && (e2.goals || []).some(n => n.text === 'Parity goal'), obs: { added: !!e, picked: ok } };
  });
  await check('council', 'covenant path: remove person', async () => {
    const e = ((await ward()).groups.returning || []).find(x => x.memberId === 'm9');
    await ev(C, id => removeGroupEntry('returning', id), e?.id); await flush(C);
    return { pass: !((await ward()).groups.returning || []).some(x => x.memberId === 'm9'), obs: null };
  });
  await check('council', 'move-in next step note', async () => {
    await ev(C, () => { openNotesModal('group', 'e1', 'movein', 'nextSteps'); document.getElementById('note-text').value = 'Parity next step'; addNote(); }); await flush(C);
    const e = (await ward()).groups.movein.find(x => x.id === 'e1'); return { pass: (e.nextSteps || []).some(n => n.text === 'Parity next step'), obs: (e.nextSteps || []).length };
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

  // ── Admin panel ────────────────────────────────────────────
  await check('admin', 'approve pending user', async () => {
    await ev(A, () => showTab('admin')); await sleep(800);
    await ev(A, () => setUserStatus('uPending', 'approved')); await sleep(800);
    return { pass: (await profile('uPending')).status === 'approved', obs: (await profile('uPending')).status };
  });
  await check('admin', 'set role', async () => {
    await ev(A, () => setUserRole('uPending', 'rs')); await sleep(800);
    return { pass: (await profile('uPending')).role === 'rs', obs: (await profile('uPending')).role };
  });
  await check('admin', 'approved user now gets in', async () => {
    const s = states['pete@example.com']; await s.page.reload(); await s.page.waitForFunction(() => document.getElementById('app-shell').style.display === 'block', null, { timeout: 20000 }).catch(() => {});
    const sc = await screen(s); await s.ctx.close(); return { pass: sc === 'app-shell', obs: sc };
  });
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

  // Last, since it wipes the shared doc: can a council member delete it?
  await check('rules-today', 'council deletes the whole ward doc', async () => ({ pass: true, obs: await tryOp(C2, `await db.doc('wardData/shared').delete()`) }), 'security');

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
