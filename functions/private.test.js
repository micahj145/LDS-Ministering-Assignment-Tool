const test = require('node:test');
const assert = require('node:assert');
const { dmMessage, restrictedMessage, newViewers, threadsUnread, restrictedUnread } = require('./private');

test('messages name only the sender', () => {
  assert.strictEqual(dmMessage('Ana Reyes'), 'New message from Ana Reyes.');
  assert.strictEqual(restrictedMessage('Ana Reyes'), 'Ana Reyes shared a restricted note with you.');
  assert.strictEqual(dmMessage(''), 'New message from someone.');
});

test('newViewers: only people added, never the author', () => {
  assert.deepStrictEqual(newViewers(null, { authorId: 'a', viewers: ['a', 'b', 'c'] }), ['b', 'c']);
  assert.deepStrictEqual(newViewers({ viewers: ['a', 'b'] }, { authorId: 'a', viewers: ['a', 'b', 'c'] }), ['c']);
  assert.deepStrictEqual(newViewers({ viewers: ['a', 'b'] }, { authorId: 'a', viewers: ['a'] }), []);
});

test('threadsUnread: newer than last opened, from someone else', () => {
  const t = [
    { id: 't1', lastBy: 'b', lastAt: '2026-10-19T10:00:00Z' },
    { id: 't2', lastBy: 'a', lastAt: '2026-10-19T10:00:00Z' },        // my own message
    { id: 't3', lastBy: 'b', lastAt: '2026-10-19T09:00:00Z' },        // already seen
    { id: 't4' },                                                    // no messages yet
  ];
  assert.strictEqual(threadsUnread(t, 'a', { t3: '2026-10-19T09:30:00Z' }), 1);
  assert.strictEqual(threadsUnread(t, 'a', undefined), 2);
});

test('restrictedUnread: shared after last seen, not my own; sharedAt wins over createdAt', () => {
  const n = [
    { authorId: 'b', createdAt: '2026-10-19T10:00:00Z' },
    { authorId: 'a', createdAt: '2026-10-19T10:00:00Z' },
    { authorId: 'b', createdAt: '2026-10-01T10:00:00Z', sharedAt: { a: '2026-10-19T11:00:00Z' } },
    { authorId: 'b', createdAt: '2026-10-01T10:00:00Z' },
  ];
  assert.strictEqual(restrictedUnread(n, 'a', '2026-10-18T00:00:00Z'), 2);
  assert.strictEqual(restrictedUnread(n, 'a', null), 3);
});
