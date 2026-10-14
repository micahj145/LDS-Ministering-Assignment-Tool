const test = require('node:test');
const assert = require('node:assert');
const { householdChanges, followMessage } = require('./follow');

const base = () => ({
  households: [{ id: 'h1', name: 'Whitfield, Daniel & Grace', address: '1 A St', phone: '', inPool: false, notes: [] },
               { id: 'h2', name: 'Okafor, Ruth', address: '2 B St', notes: [] }],
  members: [{ id: 'm1', name: 'Whitfield, Daniel', householdId: 'h1', isBrother: true, notes: [] },
            { id: 'm2', name: 'Whitfield, Grace', householdId: 'h1', isBrother: false, notes: [] },
            { id: 'm3', name: 'Okafor, Ruth', householdId: 'h2', notes: [] }],
  current: [], proposed: [],
  groups: { movein: [{ id: 'e1', householdId: 'h1', status: 'new', notes: [], nextSteps: [] }], new: [] },
});
const clone = x => JSON.parse(JSON.stringify(x));
const note = (id, author = 'Ana') => ({ id, author, text: 'secret detail', date: '2026-10-13T10:00:00Z' });

test('nothing changed -> nothing reported', () => {
  assert.deepStrictEqual(householdChanges(base(), base()), []);
});

test('household note, pool, address and phone changes', () => {
  const a = base(); const b = clone(a);
  b.households[0].notes.push(note('n1')); b.households[0].inPool = true; b.households[0].address = '9 Z St'; b.households[0].phone = '555';
  const ch = householdChanges(a, b);
  assert.deepStrictEqual(ch.map(c => c.hhId), ['h1', 'h1', 'h1', 'h1']);
  assert.match(ch[0].text, /Ana added a note on Whitfield/); assert.strictEqual(ch[0].link, '#open=household,h1');
  assert.match(ch[1].text, /Out → In Pool/);
});

test('member notes, brother pool, link changes, add and removal', () => {
  const a = base(); const b = clone(a);
  b.members[0].notes.push(note('n2')); b.members[0].inPool = 'maybe';
  b.members[2].householdId = 'h1';                         // Ruth relinked to h1
  b.members.push({ id: 'm4', name: 'Whitfield, Kid', householdId: 'h1' });
  b.members = b.members.filter(m => m.id !== 'm2');       // Grace removed
  const t = householdChanges(a, b).map(c => `${c.hhId}:${c.text}`);
  assert.ok(t.includes('h1:Ana added a note on Whitfield, Daniel'));
  assert.ok(t.includes('h1:Whitfield, Daniel: ministering pool Out → Maybe'));
  assert.ok(t.includes('h2:Okafor, Ruth is no longer linked to Okafor, Ruth'));
  assert.ok(t.includes('h1:Okafor, Ruth was linked to Whitfield, Daniel & Grace'));
  assert.ok(t.includes('h1:Whitfield, Kid was added to Whitfield, Daniel & Grace'));
  assert.ok(t.includes('h1:Whitfield, Grace was removed from the members list'));
});

test('companionship assigned, note, unassigned, removed — by id or older name form', () => {
  const a = base(); const b = clone(a);
  b.current.push({ id: 'c1', m1Name: 'Tom', m2Name: 'Sam', households: ['h1'], notes: [] });
  let t = householdChanges(a, b).map(c => c.text);
  assert.ok(t.includes('Whitfield, Daniel & Grace assigned to Tom + Sam (Current Assignments)'));
  const c = clone(b); c.current[0].notes.push(note('n3', 'Tom'));
  t = householdChanges(b, c).map(x => x.text);
  assert.ok(t[0].startsWith('Tom added a note on the companionship serving Whitfield'));
  const d = clone(c); d.current[0].households = ['Okafor, Ruth'];      // name form
  t = householdChanges(c, d).map(x => `${x.hhId}:${x.text}`);
  assert.ok(t.includes('h2:Okafor, Ruth assigned to Tom + Sam (Current Assignments)'));
  assert.ok(t.includes('h1:Whitfield, Daniel & Grace no longer assigned to Tom + Sam (Current Assignments)'));
  const e = clone(d); e.current = [];
  assert.ok(householdChanges(d, e).some(x => x.hhId === 'h2' && /companionship serving Okafor, Ruth was removed/.test(x.text)));
});

test('Move Ins status, next steps; council group entries follow the member\'s household', () => {
  const a = base(); const b = clone(a);
  b.groups.movein[0].status = 'contacted'; b.groups.movein[0].nextSteps.push(note('s1'));
  b.groups.new.push({ id: 'g1', memberId: 'm3', name: 'Okafor, Ruth', goals: [], notes: [] });
  const ch = householdChanges(a, b);
  const t = ch.map(c => `${c.hhId}:${c.text}`);
  assert.ok(t.includes('h1:Whitfield, Daniel & Grace: Move In status New → Contacted'));
  assert.ok(t.includes('h1:Ana added a next step for Whitfield, Daniel & Grace (Move Ins)'));
  assert.ok(t.includes('h2:Okafor, Ruth was added to New Members'));
  assert.strictEqual(ch.find(c => /next step/.test(c.text)).link, '#open=group,e1,movein,nextSteps');
});

test('household removed; note text never appears in change text', () => {
  const a = base(); const b = clone(a); b.households = b.households.filter(h => h.id !== 'h2');
  assert.ok(householdChanges(a, b).some(c => c.hhId === 'h2' && /removed from the households list/.test(c.text)));
  const c = clone(a); c.households[0].notes.push(note('n9'));
  assert.ok(!JSON.stringify(householdChanges(a, c)).includes('secret detail'));
});

test('push text names only the person who made the change', () => {
  assert.strictEqual(followMessage('Ana Reyes', 1), 'Ana Reyes updated a household you follow.');
  assert.strictEqual(followMessage('Ana Reyes', 3), 'Ana Reyes made 3 updates to households you follow.');
});

test('People Being Taught (no household) report under entry:<id>; labels use the new name', () => {
  const a = base(); a.groups.mission = [{ id: 'p1', name: 'Jordan Lee', goals: [], notes: [] }];
  const b = clone(a); b.groups.mission[0].goals.push(note('gl1'));
  const ch = householdChanges(a, b);
  assert.deepStrictEqual(ch.map(c => [c.hhId, c.text, c.link]),
    [['entry:p1', 'Ana added a goal for Jordan Lee (People Being Taught)', '#open=group,p1,mission,goals']]);
  const c = clone(b); c.groups.mission = [];
  assert.deepStrictEqual(householdChanges(b, c).map(x => [x.hhId, x.text]), [['entry:p1', 'Jordan Lee was removed from People Being Taught']]);
});

test('a council entry for an unlinked member also reports under entry:<id>', () => {
  const a = base(); a.members.push({ id: 'm9', name: 'Solo, Pat', notes: [] });
  a.groups.returning = [{ id: 'r1', memberId: 'm9', name: 'Solo, Pat', goals: [], notes: [] }];
  const b = clone(a); b.groups.returning[0].notes.push(note('nn'));
  assert.deepStrictEqual(householdChanges(a, b).map(x => x.hhId), ['entry:r1']);
});
