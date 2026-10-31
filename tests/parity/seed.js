// Synthetic seed for the parity suite: invented people and addresses only.
// Runs against the emulators (FIREBASE_AUTH_EMULATOR_HOST / FIRESTORE_EMULATOR_HOST).
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) throw new Error('emulators only');
initializeApp({ projectId: 'demo-parity' });
const auth = getAuth(), db = getFirestore();
const PW = 'parity-pass-1';
const hrs = h => new Date(Date.now() - h * 3600e3).toISOString();
const md = d => { const x = new Date(Date.now() + d * 864e5); return String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };

const USERS = [
  { uid: 'uAdmin', email: 'micahj145@gmail.com', firstName: 'Avery', lastName: 'Admin', status: 'approved', isAdmin: true, role: 'eq' },
  { uid: 'uEq', email: 'sam@example.com', firstName: 'Sam', lastName: 'Carter', status: 'approved', isAdmin: false, role: 'eq' },
  { uid: 'uRs', email: 'rita@example.com', firstName: 'Rita', lastName: 'Ames', status: 'approved', isAdmin: false, role: 'rs' },
  { uid: 'uCouncil', email: 'cora@example.com', firstName: 'Cora', lastName: 'Lane', status: 'approved', isAdmin: false },
  { uid: 'uPending', email: 'pete@example.com', firstName: 'Pete', lastName: 'Moss', status: 'pending', isAdmin: false },
  { uid: 'uDenied', email: 'dale@example.com', firstName: 'Dale', lastName: 'Nope', status: 'denied', isAdmin: false },
  { uid: 'uUnverified', email: 'val@example.com', firstName: 'Val', lastName: 'Unver', status: 'approved', isAdmin: false, unverified: true },
  // Approved and on the allowed list, but hasn't set up two-step sign-in yet.
  { uid: 'uFresh', email: 'finn@example.com', firstName: 'Finn', lastName: 'Fresh', status: 'approved', isAdmin: false, role: 'council', noMfa: true },
];
// Everyone approved and verified has a phone set up for two-step sign-in
// (the emulator hands out the texted codes over its REST API).
const PHONE = { uAdmin: '+15555550100', uEq: '+15555550101', uRs: '+15555550102', uCouncil: '+15555550103' };
const tag = u => ({ uid: u.uid, name: u.firstName + ' ' + u.lastName });
const [ADM, EQ, RS, CO] = USERS;

const M = (id, name, gender, age, householdId, extra = {}) => ({ id, name, gender, age, householdId, notes: [], ...extra });
const members = [
  M('m1', 'Whitfield, Daniel', 'M', 34, 'h1', { inPool: true, notes: [{ id: 'n1', author: 'Rita Ames', authorId: 'uRs', text: 'Would like a ride to the temple next month.', date: hrs(5), tags: [tag(EQ)] }] }),
  M('m2', 'Whitfield, Grace', 'F', 32, 'h1', { rsPool: true }),
  M('m3', 'Okafor, Ruth', 'F', 71, 'h2', { rsRecipient: true }),
  M('m4', 'Lindqvist, Erik', 'M', 28, 'h3', { ident: { ysa: true, noCalling: true } }),
  M('m5', 'Brandt, Hugo', 'M', 45, 'h4', { inPool: true, ident: { bday: md(5) } }),
  M('m6', 'Brandt, Ilse', 'F', 44, 'h4', { rsPool: true }),
  M('m7', 'Moreau, Jules', 'M', 52, 'h5', { inPool: true }),
  M('m8', 'Moreau, Claire', 'F', 50, 'h5', { rsPool: true, ident: { noCalling: true } }),
  M('m9', 'Tanaka, Ken', 'M', 39, 'h6', { inPool: true }),
  M('m10', 'Tanaka, Yumi', 'F', 37, 'h6', { ident: { partMember: true } }),
  M('m11', 'Osei, Kofi', 'M', 23, 'h7', { ident: { ysa: true } }),
  M('m12', 'Delgado, Marta', 'F', 66, 'h8', { rsRecipient: true }),
];
const H = (id, name, mem, address, lat, lng, extra = {}) => ({ id, name, members: mem, address, lat, lng, notes: [], ...extra });
const households = [
  H('h1', 'Whitfield, Daniel & Grace', ['Whitfield, Daniel', 'Whitfield, Grace'], '120 Sample Ave, Palm Bay FL 32909', 28.0, -80.60, { inPool: true }),
  H('h2', 'Okafor, Ruth', ['Okafor, Ruth'], '45 Example Ct, Palm Bay FL 32905', 28.03, -80.62, { rsPool: true, notes: [{ id: 'n2', author: 'Cora Lane', authorId: 'uCouncil', text: 'Recovering from surgery; would welcome a visit.', date: hrs(20), tags: [tag(EQ), tag(RS)] }] }),
  H('h3', 'Lindqvist, Erik', ['Lindqvist, Erik'], '9 Demo Dr Apt 4, Melbourne FL 32901', null, null, { inPool: 'maybe' }),
  H('h4', 'Brandt, Hugo & Ilse', ['Brandt, Hugo', 'Brandt, Ilse'], '300 Test Blvd, Palm Bay FL 32907', 27.98, -80.66, { inPool: true, rsPool: true }),
  H('h5', 'Moreau, Jules & Claire', ['Moreau, Jules', 'Moreau, Claire'], '77 Mock St, Palm Bay FL 32908', 27.95, -80.70, { inPool: true }),
  H('h6', 'Tanaka, Ken & Yumi', ['Tanaka, Ken', 'Tanaka, Yumi'], '15 Fixture Ln, Palm Bay FL 32909', 28.01, -80.58, { inPool: true, partMember: true, rsPool: true }),
  H('h7', 'Osei, Kofi', ['Osei, Kofi'], '8 Stub Way, Malabar FL 32950', 27.99, -80.57, {}),
  H('h8', 'Delgado, Marta', ['Delgado, Marta'], '61 Sample Ave, Palm Bay FL 32909', 28.005, -80.605, { rsPool: true }),
];
const C = (id, m1, m2, hh, position) => ({ id, m1Id: m1.id, m1Name: m1.name, m2Id: m2?.id || null, m2Name: m2?.name || '', households: hh, notes: [], position });
const byId = Object.fromEntries(members.map(m => [m.id, m]));
const ward = {
  members, households,
  current: [C('c1', byId.m1, byId.m5, ['h2', 'h3'], 0), C('c2', byId.m7, byId.m9, ['h6'], 1)],
  proposed: [C('p1', byId.m1, byId.m9, ['h3', 'h5'], 0)],
  currentRS: [{ ...C('r1', byId.m2, byId.m6, ['h2'], 0), m3Id: null, m3Name: '', assignees: ['m12'] }],
  proposedRS: [],
  users: USERS.filter(u => u.status === 'approved').map(tag),
  activityLog: [],
  identMeta: {},
  groups: {
    new: [{ id: 'g1', memberId: 'm4', name: 'Lindqvist, Erik', goals: [{ id: 'n3', author: 'Rita Ames', authorId: 'uRs', text: 'Introduce Erik to the quorum presidency.', date: hrs(50), tags: [tag(EQ)] }], notes: [] }],
    movein: [
      { id: 'e1', householdId: 'h1', name: 'Whitfield, Daniel & Grace', people: [{ memberId: 'm1', name: 'Whitfield, Daniel', position: 'Primary Household Contact', age: 34 }, { memberId: 'm2', name: 'Whitfield, Grace', position: 'Spouse', age: 32 }], moveInDate: '2026-10-03', status: 'contacted', statusBy: 'Rita Ames', statusDate: hrs(24), notes: [], nextSteps: [{ id: 's1', author: 'Rita Ames', authorId: 'uRs', text: 'Visit Sunday afternoon.', date: hrs(3), tags: [tag(EQ), tag(CO)] }], goals: [] },
      { id: 'e2', householdId: 'h3', name: 'Lindqvist, Erik', people: [{ memberId: 'm4', name: 'Lindqvist, Erik', position: 'Primary Household Contact', age: 28 }], moveInDate: '2026-09-21', status: 'new', notes: [], nextSteps: [], goals: [] }],
  },
  updatedBy: 'seed', updatedByUid: null,
};

(async () => {
  for (const u of USERS) {
    const mfa = PHONE[u.uid] ? { multiFactor: { enrolledFactors: [{ phoneNumber: PHONE[u.uid], displayName: 'Phone', factorId: 'phone' }] } } : {};
    await auth.createUser({ uid: u.uid, email: u.email, password: PW, emailVerified: !u.unverified, displayName: u.firstName + ' ' + u.lastName, ...mfa });
    if (u.status === 'approved' && !u.unverified)
      await db.doc('allowedUsers/' + u.email.toLowerCase()).set({ email: u.email.toLowerCase(), uid: u.uid, role: u.role || 'council', admin: !!u.isAdmin });
    const p = { email: u.email, firstName: u.firstName, lastName: u.lastName, status: u.status, isAdmin: u.isAdmin, createdAt: new Date(), emailVerified: !u.unverified };
    if (u.role) p.role = u.role;
    if (u.uid === 'uEq') { p.notifSeenAt = hrs(30); p.fcmTokens = ['tok-eq']; }
    if (u.uid === 'uRs' || u.uid === 'uCouncil' || u.uid === 'uAdmin') p.fcmTokens = ['tok-' + u.uid];
    await db.doc('profiles/' + u.uid).set(p);
  }
  if (process.env.PHASE === 'final') {
    // By step 2 the notes have long since moved out: store them the new way.
    const { NOTE_FIELDS } = require('../../functions/access');
    const holders = [...ward.members.map(o => [o, { type: 'member', id: o.id }]), ...ward.households.map(o => [o, { type: 'household', id: o.id }]),
      ...['current', 'proposed', 'currentRS', 'proposedRS'].flatMap(k => ward[k].map(o => [o, { type: k, id: o.id }])),
      ...Object.entries(ward.groups).flatMap(([g, l]) => l.map(o => [o, { type: 'group', group: g, id: o.id }]))];
    for (const [o, t] of holders) for (const f of NOTE_FIELDS) {
      for (const n of o[f] || []) await db.doc('notes/' + n.id).set({ ...n, target: { ...t, field: f }, migrated: true });
      delete o[f];
    }
    ward.clientVersion = 2; ward.notesMigrated = true;
  }
  await db.doc('wardData/shared').set(ward);
  console.log('seeded', USERS.length, 'users,', members.length, 'members,', households.length, 'households');
})().catch(e => { console.error(e); process.exit(1); });
module.exports = { USERS, PW, PHONE };
