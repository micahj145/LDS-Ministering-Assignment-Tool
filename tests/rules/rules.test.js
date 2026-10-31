// firestore.rules against the Firestore emulator, for both steps of the
// switch-over. Run with ./run.sh (starts the emulator). The rules file is
// loaded twice: as-is (step 1) and with finalRules() flipped to true (step 2).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs } = require('firebase/firestore');

const RULES = fs.readFileSync(path.join(__dirname, '..', '..', 'firestore.rules'), 'utf8');
const FINAL = RULES.replace('function finalRules() { return false; }', 'function finalRules() { return true; }');
assert.notStrictEqual(RULES, FINAL, 'finalRules() switch not found');
const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');

const NOW = Math.floor(Date.now() / 1000);
const DAY = 86400;
// Token claims for a signed-in user. mfa: true = signed in with a code.
const tok = (email, { mfa = true, age = 3600, verified = true } = {}) => ({
  email, email_verified: verified, auth_time: NOW - age,
  firebase: mfa ? { sign_in_provider: 'password', sign_in_second_factor: 'phone' } : { sign_in_provider: 'password' },
});
const people = {
  admin: { uid: 'uA', email: 'admin@x.org', role: 'eq', admin: true },
  eq: { uid: 'uE', email: 'eq@x.org', role: 'eq' },
  rs: { uid: 'uR', email: 'rs@x.org', role: 'rs' },
  council: { uid: 'uC', email: 'council@x.org', role: 'council' },
  legacy: { uid: 'uL', email: 'legacy@x.org' },           // approved profile, not on the allowed list
  outsider: { uid: 'uO', email: 'out@x.org' },            // no profile, not on the list
};

async function setup(env) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async ctx => {
    const db = ctx.firestore();
    for (const p of Object.values(people)) {
      if (p.uid !== 'uO') await setDoc(doc(db, 'profiles', p.uid), { email: p.email, firstName: 'F', lastName: 'L', status: 'approved', isAdmin: !!p.admin, role: p.role || null });
      if (p.role) await setDoc(doc(db, 'allowedUsers', p.email), { email: p.email, uid: p.uid, role: p.role, admin: !!p.admin });
    }
    await setDoc(doc(db, 'wardData', 'shared'), { members: [], households: [], current: [], proposed: [], currentRS: [], proposedRS: [],
      groups: { new: [], returning: [], mission: [], movein: [], moveout: [] }, users: [], identMeta: {}, activityLog: [], clientVersion: 2 });
    await setDoc(doc(db, 'wardData', 'stats'), { us: {} });
    await setDoc(doc(db, 'notes', 'byEq'), { text: 'x', author: 'E', authorId: 'uE', target: { type: 'household', id: 'h1', field: 'notes' } });
    await setDoc(doc(db, 'notes', 'onNew'), { text: 'x', author: 'E', authorId: 'uE', target: { type: 'group', group: 'new', id: 'g1', field: 'goals' } });
    await setDoc(doc(db, 'adminData', 'callings'), { users: {} });
  });
}
const as = (env, who, opts) => env.authenticatedContext(people[who].uid, tok(people[who].email, opts)).firestore();
const wardUpd = (db, who, fields) => updateDoc(doc(db, 'wardData', 'shared'), { ...fields, updatedByUid: people[who].uid, clientVersion: 2 });
const note = (who, target) => ({ text: 'hello', author: who, authorId: people[who].uid, date: new Date().toISOString(), target });

let finalEnv, step1Env;
test.before(async () => {
  finalEnv = await initializeTestEnvironment({ projectId: 'demo-rules-final', firestore: { rules: FINAL, host, port: +port } });
  step1Env = await initializeTestEnvironment({ projectId: 'demo-rules-step1', firestore: { rules: RULES, host, port: +port } });
});
test.after(async () => { await finalEnv?.cleanup(); await step1Env?.cleanup(); });

test('final: who gets in', async t => {
  const env = finalEnv; await setup(env);
  const read = db => getDoc(doc(db, 'wardData', 'shared'));
  await t.test('allowed + code + recent → can read', () => assertSucceeds(read(as(env, 'council'))));
  await t.test('not on the allowed list → denied (even with an approved profile)', () => assertFails(read(as(env, 'legacy'))));
  await t.test('no profile, not on the list → denied', () => assertFails(read(as(env, 'outsider'))));
  await t.test('on the list but signed in without a code → denied', () => assertFails(read(as(env, 'council', { mfa: false }))));
  await t.test('signed in 15 days ago → denied', () => assertFails(read(as(env, 'council', { age: 15 * DAY }))));
  await t.test('signed in 13 days ago → allowed', () => assertSucceeds(read(as(env, 'council', { age: 13 * DAY }))));
  await t.test('email not verified → denied', () => assertFails(read(as(env, 'council', { verified: false }))));
  await t.test('signed out → denied', () => assertFails(read(env.unauthenticatedContext().firestore())));
  await t.test('every other collection follows the same gate', async () => {
    await assertFails(getDocs(collection(as(env, 'council', { mfa: false }), 'notes')));
    await assertFails(getDoc(doc(as(env, 'council', { age: 15 * DAY }), 'wardData', 'stats')));
    await assertSucceeds(getDocs(collection(as(env, 'council'), 'notes')));
  });
});

test('final: the allowed list', async t => {
  const env = finalEnv; await setup(env);
  await t.test('you can read your own entry', () => assertSucceeds(getDoc(doc(as(env, 'council'), 'allowedUsers', 'council@x.org'))));
  await t.test("…but not someone else's", () => assertFails(getDoc(doc(as(env, 'council'), 'allowedUsers', 'eq@x.org'))));
  await t.test('a non-admin cannot add anyone', () => assertFails(setDoc(doc(as(env, 'eq'), 'allowedUsers', 'new@x.org'), { email: 'new@x.org', role: 'council', admin: false })));
  await t.test('a non-admin cannot raise their own role', () => assertFails(setDoc(doc(as(env, 'council'), 'allowedUsers', 'council@x.org'), { email: 'council@x.org', role: 'eq', admin: false })));
  await t.test('a non-admin cannot make themselves admin', () => assertFails(updateDoc(doc(as(env, 'council'), 'allowedUsers', 'council@x.org'), { admin: true })));
  await t.test('an admin can add someone', () => assertSucceeds(setDoc(doc(as(env, 'admin'), 'allowedUsers', 'new@x.org'), { email: 'new@x.org', role: 'council', admin: false })));
  await t.test('an admin can change a role', () => assertSucceeds(updateDoc(doc(as(env, 'admin'), 'allowedUsers', 'council@x.org'), { role: 'rs' })));
  await t.test('an admin cannot use a made-up role', () => assertFails(updateDoc(doc(as(env, 'admin'), 'allowedUsers', 'rs@x.org'), { role: 'bishop' })));
  await t.test('an admin cannot drop their own admin flag', () => assertFails(updateDoc(doc(as(env, 'admin'), 'allowedUsers', 'admin@x.org'), { admin: false })));
  await t.test('an admin cannot delete themselves', () => assertFails(deleteDoc(doc(as(env, 'admin'), 'allowedUsers', 'admin@x.org'))));
  await t.test('an admin signed in without a code cannot change the list', () => assertFails(updateDoc(doc(as(env, 'admin', { mfa: false }), 'allowedUsers', 'rs@x.org'), { role: 'council' })));
  await t.test('an admin can remove someone', () => assertSucceeds(deleteDoc(doc(as(env, 'admin'), 'allowedUsers', 'rs@x.org'))));
  await t.test('callings check is admin-only', async () => {
    await assertFails(getDoc(doc(as(env, 'eq'), 'adminData', 'callings')));
    await assertSucceeds(getDoc(doc(as(env, 'admin'), 'adminData', 'callings')));
  });
});

test('final: profiles', async t => {
  const env = finalEnv; await setup(env);
  const me = as(env, 'council');
  await t.test('you can update your own name and following', () => assertSucceeds(updateDoc(doc(me, 'profiles', 'uC'), { firstName: 'New', followHouseholds: ['h1'] })));
  await t.test('…but not your own role', () => assertFails(updateDoc(doc(me, 'profiles', 'uC'), { role: 'eq' })));
  await t.test('…or status or admin flag', async () => {
    await assertFails(updateDoc(doc(me, 'profiles', 'uC'), { status: 'pending' }));
    await assertFails(updateDoc(doc(me, 'profiles', 'uC'), { isAdmin: true }));
  });
  await t.test("you can't read someone else's profile", () => assertFails(getDoc(doc(me, 'profiles', 'uE'))));
});

test('final: ward data by role', async t => {
  const env = finalEnv; await setup(env);
  const E = as(env, 'eq'), R = as(env, 'rs'), C = as(env, 'council');
  await t.test('council: Covenant Path lists, directory, log', async () => {
    await assertSucceeds(wardUpd(C, 'council', { 'groups.new': [{ id: 'g1' }], users: [{ uid: 'uC', name: 'C' }], activityLog: [{ ts: 1 }] }));
    await assertSucceeds(wardUpd(C, 'council', { 'groups.returning': [], 'groups.mission': [{ id: 'p' }] }));
  });
  await t.test('council: not members, households, identifiers, assignments, move-ins', async () => {
    for (const f of ['members', 'households', 'current', 'proposed', 'currentRS', 'proposedRS'])
      await assertFails(wardUpd(C, 'council', { [f]: [{ id: 'x' }] }));
    await assertFails(wardUpd(C, 'council', { identMeta: { ysa: {} } }));
    await assertFails(wardUpd(C, 'council', { 'groups.movein': [{ id: 'e' }] }));
    await assertFails(wardUpd(C, 'council', { 'groups.moveout': [{ id: 'e' }] }));
  });
  await t.test('council: a whole-document overwrite is refused', () =>
    assertFails(setDoc(doc(C, 'wardData', 'shared'), { members: [], groups: {}, updatedByUid: 'uC', clientVersion: 2 })));
  await t.test('eq: members, households, brother lists, move-ins', async () => {
    await assertSucceeds(wardUpd(E, 'eq', { members: [{ id: 'm' }], households: [{ id: 'h' }], identMeta: { ysa: {} } }));
    await assertSucceeds(wardUpd(E, 'eq', { current: [{ id: 'c' }], proposed: [] }));
    await assertSucceeds(wardUpd(E, 'eq', { 'groups.movein': [{ id: 'e' }], 'groups.moveout': [] }));
  });
  await t.test('eq: not the sister lists', async () => {
    await assertFails(wardUpd(E, 'eq', { currentRS: [{ id: 'r' }] }));
    await assertFails(wardUpd(E, 'eq', { proposedRS: [{ id: 'r' }] }));
  });
  await t.test('rs: members, households, sister lists; not the brother lists', async () => {
    await assertSucceeds(wardUpd(R, 'rs', { members: [{ id: 'm2' }], currentRS: [{ id: 'r' }], proposedRS: [] }));
    await assertFails(wardUpd(R, 'rs', { current: [{ id: 'c2' }] }));
    await assertFails(wardUpd(R, 'rs', { proposed: [{ id: 'c2' }] }));
  });
  await t.test('a save must be stamped with your own uid', () => assertFails(updateDoc(doc(E, 'wardData', 'shared'), { members: [], updatedByUid: 'uC', clientVersion: 2 })));
  await t.test('an old copy of the app (no clientVersion) is refused', () =>
    assertFails(setDoc(doc(E, 'wardData', 'shared'), { members: [], households: [], updatedByUid: 'uE' })));
  await t.test('nobody can delete the ward document', async () => {
    await assertFails(deleteDoc(doc(E, 'wardData', 'shared')));
    await assertFails(deleteDoc(doc(as(env, 'admin'), 'wardData', 'shared')));
  });
  await t.test('unit statistics: presidencies import, council reads', async () => {
    await assertSucceeds(updateDoc(doc(R, 'wardData', 'stats'), { 'us.x': 1 }));
    await assertFails(updateDoc(doc(C, 'wardData', 'stats'), { 'us.x': 2 }));
    await assertSucceeds(getDoc(doc(C, 'wardData', 'stats')));
  });
  await t.test('no other wardData documents', () => assertFails(setDoc(doc(E, 'wardData', 'other'), { x: 1 })));
});

test('final: notes', async t => {
  const env = finalEnv; await setup(env);
  const E = as(env, 'eq'), C = as(env, 'council');
  await t.test('council adds their own note anywhere', async () => {
    await assertSucceeds(setDoc(doc(C, 'notes', 'c1'), note('council', { type: 'household', id: 'h1', field: 'notes' })));
    await assertSucceeds(setDoc(doc(C, 'notes', 'c2'), note('council', { type: 'group', group: 'movein', id: 'e1', field: 'nextSteps' })));
  });
  await t.test("…but not one signed as someone else", () => assertFails(setDoc(doc(C, 'notes', 'c3'), note('eq', { type: 'household', id: 'h1', field: 'notes' }))));
  await t.test('…and not a malformed one', () => assertFails(setDoc(doc(C, 'notes', 'c4'), { ...note('council', { type: 'secret', id: 'x', field: 'notes' }) })));
  await t.test("council can't edit or delete someone else's household note", async () => {
    await assertFails(updateDoc(doc(C, 'notes', 'byEq'), { text: 'changed' }));
    await assertFails(deleteDoc(doc(C, 'notes', 'byEq')));
  });
  await t.test('council can edit and delete their own', async () => {
    await assertSucceeds(updateDoc(doc(C, 'notes', 'c1'), { text: 'changed' }));
    await assertSucceeds(deleteDoc(doc(C, 'notes', 'c1')));
  });
  await t.test("council can remove others' goals on a Covenant Path person", () => assertSucceeds(deleteDoc(doc(C, 'notes', 'onNew'))));
  await t.test("a presidency member can remove others' notes", () => assertSucceeds(deleteDoc(doc(E, 'notes', 'byEq'))));
  await t.test('nobody can re-sign a note as someone else', () => assertFails(updateDoc(doc(E, 'notes', 'c2'), { authorId: 'uE' })));
});

test('step 1 (transition): old way still works alongside the new', async t => {
  const env = step1Env; await setup(env);
  await t.test('approved profile without the list or a code → can read and save', async () => {
    const L = as(env, 'legacy', { mfa: false });
    await assertSucceeds(getDoc(doc(L, 'wardData', 'shared')));
    await assertSucceeds(wardUpd(L, 'legacy', { members: [{ id: 'm' }] }));
    await assertSucceeds(setDoc(doc(L, 'notes', 'mig1'), { ...note('eq', { type: 'member', id: 'm', field: 'notes' }), migrated: true }));
  });
  await t.test('allowed list + code → can read', () => assertSucceeds(getDoc(doc(as(env, 'council'), 'wardData', 'shared'))));
  await t.test('no profile, not on the list → denied', () => assertFails(getDoc(doc(as(env, 'outsider'), 'wardData', 'shared'))));
  await t.test('a pending profile → denied', async () => {
    await env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), 'profiles', 'uO'), { email: 'out@x.org', status: 'pending', isAdmin: false }));
    await assertFails(getDoc(doc(as(env, 'outsider', { mfa: false }), 'wardData', 'shared')));
  });
  await t.test('nobody can delete the ward document', () => assertFails(deleteDoc(doc(as(env, 'legacy', { mfa: false }), 'wardData', 'shared'))));
  await t.test('an old copy of the app is refused once the new one has saved', () =>
    assertFails(setDoc(doc(as(env, 'legacy', { mfa: false }), 'wardData', 'shared'), { members: [], updatedByUid: 'uL' })));
  await t.test('before the new app has saved, an old copy can still save', async () => {
    await env.withSecurityRulesDisabled(ctx => setDoc(doc(ctx.firestore(), 'wardData', 'shared'), { members: [] }));
    await assertSucceeds(setDoc(doc(as(env, 'legacy', { mfa: false }), 'wardData', 'shared'), { members: [{ id: 'm' }], updatedByUid: 'uL' }));
  });
  await t.test('a profile admin (not yet on the list) can fill the allowed list', async () => {
    await env.withSecurityRulesDisabled(async ctx => {
      await deleteDoc(doc(ctx.firestore(), 'allowedUsers', 'admin@x.org'));
      await setDoc(doc(ctx.firestore(), 'profiles', 'uA'), { email: 'admin@x.org', status: 'approved', isAdmin: true });
    });
    await assertSucceeds(setDoc(doc(as(env, 'admin', { mfa: false }), 'allowedUsers', 'legacy@x.org'), { email: 'legacy@x.org', role: 'council', admin: false }));
  });
  await t.test('a non-admin still cannot', () => assertFails(setDoc(doc(as(env, 'legacy', { mfa: false }), 'allowedUsers', 'legacy@x.org'), { email: 'legacy@x.org', role: 'eq', admin: false })));
  await t.test("you still can't change your own role on your profile", () => assertFails(updateDoc(doc(as(env, 'legacy', { mfa: false }), 'profiles', 'uL'), { role: 'eq' })));
});
