const test = require('node:test');
const assert = require('node:assert');
const { newTags, unreadCount, messageFor, accessRequestMessage } = require('./tags');

const J = { uid: 'u2', name: 'Jane' }, M = { uid: 'u1', name: 'Micah' };
const note = (id, author, authorId, tags, date = '2026-10-12T10:00:00Z', text = 'x') => ({ id, author, authorId, tags, date, text });

test('only tags added since the previous save notify, in every kind of thread', () => {
  const before = { members: [{ notes: [note('a', 'Jane', 'u2', [M])] }] };
  const after = {
    members: [{ notes: [note('a', 'Jane', 'u2', [M]), note('b', 'Jane', 'u2', [M])] }],
    households: [{ notes: [note('c', 'Jane', 'u2', [M])] }],
    current: [{ notes: [note('d', 'Jane', 'u2', [M])] }],
    proposed: [{ notes: [note('e', 'Jane', 'u2', [M])] }],
    groups: { movein: [{ nextSteps: [note('f', 'Jane', 'u2', [M])], goals: [note('g', 'Jane', 'u2', [M])], notes: [] }] },
  };
  const t = newTags(before, after);
  assert.deepStrictEqual(t.map(x => x.kind).sort(), ['goal', 'next step', 'note', 'note', 'note', 'note']);
});

test('adding a second person to an existing note notifies only them', () => {
  const before = { members: [{ notes: [note('a', 'Jane', 'u2', [M])] }] };
  const after = { members: [{ notes: [note('a', 'Jane', 'u2', [M, { uid: 'u3', name: 'Ann' }])] }] };
  assert.deepStrictEqual(newTags(before, after).map(x => x.uid), ['u3']);
});

test('tagging yourself never notifies; untouched saves send nothing', () => {
  const doc = { members: [{ notes: [note('a', 'Micah', 'u1', [M])] }] };
  assert.strictEqual(newTags({}, doc).length, 0);
  const d2 = { members: [{ notes: [note('a', 'Jane', 'u2', [M])] }] };
  assert.strictEqual(newTags(d2, JSON.parse(JSON.stringify(d2))).length, 0);
});

test('first ever save (no before document) notifies existing tags once', () => {
  assert.strictEqual(newTags(undefined, { members: [{ notes: [note('a', 'Jane', 'u2', [M])] }] }).length, 1);
});

test('unread count matches the app: after last seen, not authored by you, name fallback', () => {
  const doc = { members: [{ notes: [
    note('a', 'Jane', 'u2', [M], '2026-10-12T10:00:00Z'),
    note('b', 'Jane', 'u2', [M], '2026-10-01T10:00:00Z'),          // before last seen
    note('c', 'Micah', null, [M], '2026-10-12T11:00:00Z'),        // old note by me (no authorId)
    note('d', 'Jane', null, [M], '2026-10-12T12:00:00Z'),         // old note by Jane (no authorId)
    note('e', 'Jane', 'u2', [J], '2026-10-12T12:00:00Z'),          // not tagging me
  ] }] };
  assert.strictEqual(unreadCount(doc, 'u1', '2026-10-05T00:00:00Z', 'Micah'), 2);
});

test('message text names only the tagger, never members', () => {
  assert.strictEqual(messageFor([{ author: 'Jane', kind: 'next step' }]), 'Jane tagged you on a next step.');
  assert.strictEqual(messageFor([{ author: 'Jane', kind: 'note' }, { author: 'Jane', kind: 'goal' }]), 'Jane tagged you 2 times.');
  assert.strictEqual(messageFor([{ author: 'Jane', kind: 'note' }, { author: 'Ann', kind: 'goal' }]), 'You were tagged 2 times.');
});

test('access request text uses the requester name, or stays generic', () => {
  assert.strictEqual(accessRequestMessage({ firstName: 'Jane', lastName: 'Doe' }), 'New access request: Jane Doe.');
  assert.strictEqual(accessRequestMessage({}), 'New access request.');
});
