// Pure helpers for the security changes, kept apart from index.js so they can
// be unit-tested without Firebase.
//
//  - Notes live in notes/{id} ({ …note, target: { type, id, group?, field } })
//    rather than inside wardData/shared. insertNotes() puts them back into a
//    copy of the ward document, so tags.js and follow.js keep working on the
//    shape they always did. Mirrors insertNotes() in ministering_tool.html.
//  - callerProblem() is the server-side version of the checks firestore.rules
//    makes: allowed list, two-step sign-in, a sign-in under 14 days old.
//  - roleFlags() lists people whose role here doesn't match the callings report.

const NOTE_FIELDS = ['notes', 'goals', 'nextSteps'];
const MAX_SESSION_S = 14 * 24 * 3600;
const COUNCIL_GROUPS = ['new', 'returning', 'mission'];

function forEachNoteHolder(d, fn) {
  (d.members || []).forEach(m => m && fn(m, { type: 'member', id: m.id }));
  (d.households || []).forEach(h => h && fn(h, { type: 'household', id: h.id }));
  ['current', 'proposed', 'currentRS', 'proposedRS'].forEach(k => (d[k] || []).forEach(c => c && fn(c, { type: k, id: c.id })));
  Object.entries(d.groups || {}).forEach(([g, list]) => (Array.isArray(list) ? list : []).forEach(e => e && fn(e, { type: 'group', id: e.id, group: g })));
}
const holderKey = t => `${t.type}|${t.group || ''}|${t.id}`;

// A deep copy of the ward document with `notes` placed into their records.
// Notes already inside the document (from before the move) stay too, unless a
// note with the same id is in `notes`.
function insertNotes(ward, notes) {
  const d = JSON.parse(JSON.stringify(ward || {}));
  const idx = new Map();
  forEachNoteHolder(d, (o, t) => idx.set(holderKey(t), o));
  const ids = new Set();
  [...(notes || [])].forEach(n => n && n.id && ids.add(n.id));
  forEachNoteHolder(d, o => NOTE_FIELDS.forEach(f => { if (Array.isArray(o[f])) o[f] = o[f].filter(n => !(n && n.id && ids.has(n.id))); }));
  [...(notes || [])].sort((a, b) => (Date.parse(a.date) || 0) - (Date.parse(b.date) || 0)).forEach(n => {
    const t = n && n.target; if (!t || !NOTE_FIELDS.includes(t.field)) return;
    const o = idx.get(holderKey(t)); if (!o) return;
    const { target, ...note } = n;
    (o[t.field] = Array.isArray(o[t.field]) ? o[t.field] : []).push(note);
  });
  return d;
}

// What firestore.rules would say about this caller (a decoded ID token and
// their allowedUsers entry), or null if they may act.
function callerProblem(token, allowEntry, nowS) {
  if (!token) return 'not signed in';
  if (!token.email || token.email_verified !== true) return 'email not verified';
  if (!allowEntry) return 'not on the allowed list';
  if (!(token.firebase && token.firebase.sign_in_second_factor)) return 'no two-step sign-in';
  if ((nowS || Math.floor(Date.now() / 1000)) - (token.auth_time || 0) > MAX_SESSION_S) return 'sign-in older than 14 days';
  return null;
}

// People with access whose role doesn't match what the callings report says.
// `callings`: adminData/callings ({ users: { email: { expected, name } } });
// `allowed`: Map email → allowedUsers entry. Returns sorted emails.
function roleFlags(callings, allowed) {
  const users = (callings && callings.users) || {};
  return Object.keys(users).filter(email => {
    const a = allowed.get(email); if (!a) return false;
    const role = a.role === 'eq' || a.role === 'rs' ? a.role : 'council';
    return users[email].expected !== role;
  }).sort();
}

function roleReviewMessage(n) {
  return n === 1 ? '1 person’s role needs your review.' : `${n} people’s roles need your review.`;
}

module.exports = { NOTE_FIELDS, COUNCIL_GROUPS, MAX_SESSION_S, insertNotes, callerProblem, roleFlags, roleReviewMessage };
