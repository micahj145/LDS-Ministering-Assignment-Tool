const test = require('node:test');
const assert = require('node:assert');
const { insertNotes, callerProblem, roleFlags, roleReviewMessage } = require('./access');
const { newTags } = require('./tags');
const { householdChanges } = require('./follow');

const ward = {
  members: [{ id: 'm1', name: 'A, B', householdId: 'h1' }],
  households: [{ id: 'h1', name: 'A household', notes: [{ id: 'old', text: 'still inside', date: '2026-01-01' }] }],
  current: [{ id: 'c1', m1Name: 'X', households: ['h1'] }],
  groups: { movein: [{ id: 'e1', householdId: 'h1', nextSteps: [] }] },
};
const note = (id, target, extra = {}) => ({ id, text: 't', author: 'Jane', authorId: 'u2', date: '2026-10-01T00:00:00Z', target, ...extra });

test('notes go back into their records; ones for missing records are dropped', () => {
  const d = insertNotes(ward, [
    note('n1', { type: 'member', id: 'm1', field: 'notes' }),
    note('n2', { type: 'group', group: 'movein', id: 'e1', field: 'nextSteps' }),
    note('n3', { type: 'current', id: 'c1', field: 'notes' }),
    note('n4', { type: 'household', id: 'gone', field: 'notes' }),
  ]);
  assert.deepStrictEqual(d.members[0].notes.map(n => n.id), ['n1']);
  assert.deepStrictEqual(d.groups.movein[0].nextSteps.map(n => n.id), ['n2']);
  assert.deepStrictEqual(d.current[0].notes.map(n => n.id), ['n3']);
  assert.deepStrictEqual(d.households[0].notes.map(n => n.id), ['old']);
  assert.ok(!('target' in d.members[0].notes[0]));
  assert.ok(!ward.members[0].notes, 'the input is not changed');
});

test('a collection note replaces an embedded copy with the same id', () => {
  const d = insertNotes(ward, [note('old', { type: 'household', id: 'h1', field: 'notes' }, { text: 'moved' })]);
  assert.deepStrictEqual(d.households[0].notes.map(n => n.text), ['moved']);
});

test('a new tagged note, placed before/after, notifies through tags.js and follow.js', () => {
  const M = { uid: 'u1', name: 'Micah' };
  const base = insertNotes(ward, []);
  const n = note('n9', { type: 'household', id: 'h1', field: 'notes' }, { tags: [M] });
  const before = insertNotes(base, []), after = insertNotes(base, [n]);
  assert.deepStrictEqual(newTags(before, after).map(t => t.uid), ['u1']);
  assert.deepStrictEqual(householdChanges(before, after).map(c => c.hhId), ['h1']);
  // An edit that adds nobody new tells nobody.
  assert.strictEqual(newTags(insertNotes(base, [n]), insertNotes(base, [{ ...n, text: 'edited' }])).length, 0);
});

test('callerProblem mirrors the rules', () => {
  const now = 2_000_000_000;
  const ok = { email: 'a@x.org', email_verified: true, auth_time: now - 3600, firebase: { sign_in_second_factor: 'phone' } };
  assert.strictEqual(callerProblem(ok, { role: 'eq' }, now), null);
  assert.strictEqual(callerProblem(null, {}, now), 'not signed in');
  assert.strictEqual(callerProblem({ ...ok, email_verified: false }, {}, now), 'email not verified');
  assert.strictEqual(callerProblem(ok, null, now), 'not on the allowed list');
  assert.strictEqual(callerProblem({ ...ok, firebase: {} }, {}, now), 'no two-step sign-in');
  assert.strictEqual(callerProblem({ ...ok, auth_time: now - 15 * 86400 }, {}, now), 'sign-in older than 14 days');
  assert.strictEqual(callerProblem({ ...ok, firebase: { sign_in_second_factor: 'totp' }, auth_time: now - 13 * 86400 }, {}, now), null);
});

test('roleFlags lists only people on the allowed list whose role differs', () => {
  const callings = { users: { 'a@x': { expected: 'eq' }, 'b@x': { expected: 'council' }, 'c@x': { expected: 'rs' }, 'gone@x': { expected: 'eq' } } };
  const allowed = new Map([['a@x', { role: 'eq' }], ['b@x', { role: 'rs' }], ['c@x', {}]]);
  assert.deepStrictEqual(roleFlags(callings, allowed), ['b@x', 'c@x']);
  assert.deepStrictEqual(roleFlags(null, allowed), []);
  assert.strictEqual(roleReviewMessage(1), '1 person’s role needs your review.');
});
