// Draft assignment changes, for the presidency that owns each draft:
// proposed (brothers) → EQ presidency, proposedRS (sisters) → RS presidency.
// Pure, so it can be unit-tested. Messages name only who acted — never member data.

const SIDE_OF = { proposed: 'eq', proposedRS: 'rs' };
const WHO = { eq: "brothers'", rs: "sisters'" };
const TAB = { eq: 'propose', rs: 'proposeRS' };

// Which drafts changed between two versions of wardData/shared.
function draftSides(before, after) {
  const B = before || {}, A = after || {};
  // Notes inside records (only ever there before notes had their own collection) don't count.
  const plain = list => JSON.stringify((list || []).map(c => { const { notes, goals, nextSteps, ...rest } = c || {}; return rest; }));
  return Object.keys(SIDE_OF).filter(k => plain(B[k]) !== plain(A[k])).map(k => SIDE_OF[k]);
}

// A note written or changed on a draft companionship → its side, else null.
// Removals tell nobody; a note moved between records isn't news.
function draftNoteSide(before, after) {
  if (!after || !after.target) return null;
  const side = SIDE_OF[after.target.type]; if (!side) return null;
  if (before && JSON.stringify(before.target) !== JSON.stringify(after.target)) return null;
  if (before && before.text === after.text && JSON.stringify(before.tags || []) === JSON.stringify(after.tags || [])) return null;
  return side;
}

function draftMessage(by, side, kind) {
  return kind === 'note' ? `${by || 'Someone'} added a note on a ${WHO[side]} draft companionship.`
    : `${by || 'Someone'} updated the ${WHO[side]} draft assignments.`;
}

// allowedUsers entries → uids of that presidency (role eq / rs), minus the editor.
function presidencyUids(allowedEntries, side, exceptUid) {
  return [...new Set((allowedEntries || []).filter(a => a && a.role === side && a.uid && a.uid !== exceptUid).map(a => a.uid))];
}

module.exports = { SIDE_OF, TAB, draftSides, draftNoteSide, draftMessage, presidencyUids };
