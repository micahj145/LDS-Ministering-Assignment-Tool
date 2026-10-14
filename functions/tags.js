// Pure helpers for finding tags in the shared ward document. Kept separate
// from index.js so they can be unit-tested without Firebase.
//
// The traversal must cover every place the app stores notes — it mirrors
// allTaggedNotes() in ministering_tool.html.

const KIND = { goals: 'goal', nextSteps: 'next step', notes: 'note' };

// Calls fn(note, kind) for every note, goal and next step in the document.
function forEachNote(doc, fn) {
  const d = doc || {};
  (d.members || []).forEach(m => (m.notes || []).forEach(n => fn(n, 'note')));
  (d.households || []).forEach(h => (h.notes || []).forEach(n => fn(n, 'note')));
  ['current', 'proposed'].forEach(k => (d[k] || []).forEach(c => (c.notes || []).forEach(n => fn(n, 'note'))));
  Object.values(d.groups || {}).forEach(list => (Array.isArray(list) ? list : []).forEach(e =>
    ['goals', 'notes', 'nextSteps'].forEach(f => (e[f] || []).forEach(n => fn(n, KIND[f])))));
}

// A stable key per note: its id where it has one (all notes written by the
// current app do), otherwise date + start of text.
function noteKey(n) {
  return n.id ? `id:${n.id}` : `dt:${n.date || ''}:${String(n.text || '').slice(0, 40)}`;
}

function tagPairs(doc) {
  const out = new Map();
  forEachNote(doc, (n, kind) => (n.tags || []).forEach(t => {
    if (t && t.uid) out.set(`${noteKey(n)}|${t.uid}`, { uid: t.uid, author: n.author || 'Someone', authorId: n.authorId || null, kind });
  }));
  return out;
}

// Tags present after a save that weren't there before — each (note, person)
// pair once. Tagging yourself never notifies you.
function newTags(beforeDoc, afterDoc) {
  const before = tagPairs(beforeDoc);
  const fresh = [];
  tagPairs(afterDoc).forEach((v, k) => {
    if (!before.has(k) && v.uid !== v.authorId) fresh.push(v);
  });
  return fresh;
}

// Same definition of "unread" as the app: tagged, dated after the user last
// opened Notifications, and not written by them.
function unreadCount(doc, uid, seenAtIso, userName, cleared) {
  const seen = Date.parse(seenAtIso) || 0;
  const hidden = new Set(cleared || []);       // notes the person cleared from their list
  let n = 0;
  forEachNote(doc, note => {
    if (!(note.tags || []).some(t => t.uid === uid)) return;
    if (hidden.has(noteKey(note))) return;
    const mine = note.authorId ? note.authorId === uid : (userName && note.author === userName);
    if (!mine && (Date.parse(note.date) || 0) > seen) n++;
  });
  return n;
}

// Notification text. Deliberately names only the user who did the tagging —
// never a member, household or note text — so no member data lands in a
// phone's notification history.
function messageFor(tags) {
  if (tags.length === 1) return `${tags[0].author} tagged you on a ${tags[0].kind}.`;
  const authors = [...new Set(tags.map(t => t.author))];
  return authors.length === 1
    ? `${authors[0]} tagged you ${tags.length} times.`
    : `You were tagged ${tags.length} times.`;
}

// Text for an admin when someone signs up. The requester's own name is fine to
// show — it's a person asking for access, not member data.
function accessRequestMessage(profile) {
  const name = [profile && profile.firstName, profile && profile.lastName].filter(Boolean).join(' ').trim();
  return name ? `New access request: ${name}.` : 'New access request.';
}

module.exports = { forEachNote, noteKey, newTags, unreadCount, messageFor, accessRequestMessage };
