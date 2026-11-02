const test = require('node:test');
const assert = require('node:assert');
const { draftSides, draftNoteSide, draftMessage, presidencyUids } = require('./drafts');

test('draftSides: only the drafts that changed', () => {
  const a = { proposed: [{ id: 'p1' }], proposedRS: [], current: [] };
  assert.deepStrictEqual(draftSides(a, { ...a, current: [{ id: 'c' }] }), []);
  assert.deepStrictEqual(draftSides(a, { ...a, proposed: [{ id: 'p1', households: ['h1'] }] }), ['eq']);
  assert.deepStrictEqual(draftSides(a, { ...a, proposedRS: [{ id: 'r' }] }), ['rs']);
  assert.deepStrictEqual(draftSides({ proposed: [{ id: 'p1', notes: [{ id: 'n' }] }] }, { proposed: [{ id: 'p1' }] }), [], 'notes moving out of the document');
});

test('draftNoteSide: new or edited draft notes only', () => {
  const t = { type: 'proposedRS', id: 'r1', field: 'notes' };
  assert.strictEqual(draftNoteSide(null, { text: 'x', target: t }), 'rs');
  assert.strictEqual(draftNoteSide({ text: 'x', target: t }, { text: 'x', target: t }), null);
  assert.strictEqual(draftNoteSide({ text: 'x', target: t }, { text: 'y', target: t }), 'rs');
  assert.strictEqual(draftNoteSide(null, { text: 'x', target: { type: 'current', id: 'c' } }), null);
  assert.strictEqual(draftNoteSide({ text: 'x', target: { type: 'group', id: 'e' } }, { text: 'x', target: { ...t, type: 'proposed' } }), null);
});

test('messages name only who acted; recipients are that presidency minus the editor', () => {
  assert.strictEqual(draftMessage('Sam', 'eq'), "Sam updated the brothers' draft assignments.");
  assert.strictEqual(draftMessage('Rita', 'rs', 'note'), "Rita added a note on a sisters' draft companionship.");
  assert.deepStrictEqual(presidencyUids([{ role: 'eq', uid: 'a' }, { role: 'eq', uid: 'b' }, { role: 'rs', uid: 'c' }, { role: 'council', uid: 'd' }], 'eq', 'a'), ['b']);
});
