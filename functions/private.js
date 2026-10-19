// Direct messages (threads/{id}/messages/{id}) and restricted notes
// (privateNotes/{id}). Both live outside the shared ward document so that
// firestore.rules can limit each one to the people in it.
//
// Notification text names only the sender — never the message, the note or
// who it's about — so nothing sensitive lands in a phone's notification history.

function dmMessage(authorName) {
  return `New message from ${authorName || 'someone'}.`;
}

function restrictedMessage(authorName) {
  return `${authorName || 'Someone'} shared a restricted note with you.`;
}

// People who can see the note now and couldn't before (never the author).
function newViewers(before, after) {
  const was = new Set((before && before.viewers) || []);
  const author = after && after.authorId;
  return [...new Set((after && after.viewers) || [])].filter(uid => uid && uid !== author && !was.has(uid));
}

// Conversations with a message from someone else since the person last opened them.
function threadsUnread(threads, uid, seenMap) {
  const seen = seenMap || {};
  return threads.filter(t => t && t.lastBy && t.lastBy !== uid
    && (Date.parse(t.lastAt) || 0) > (Date.parse(seen[t.id]) || 0)).length;
}

// Restricted notes shared by someone else since the person last opened Messages.
function restrictedUnread(notes, uid, seenAtIso) {
  const seen = Date.parse(seenAtIso) || 0;
  return notes.filter(n => n && n.authorId !== uid && (Date.parse(n.sharedAt?.[uid] || n.createdAt) || 0) > seen).length;
}

module.exports = { dmMessage, restrictedMessage, newViewers, threadsUnread, restrictedUnread };
