// What changed for each household between two versions of wardData/shared,
// for people who follow households. Pure, so it can be unit-tested.
//
// A household's "world" is the household record, every member linked to it,
// companionships that serve it, and ward council / Move Ins entries for it or
// its members. Each change becomes { hhId, text, link } where link is an app
// hash (#open=… opens the right thread, #tab=… the right tab).
//
// `hhId` is really a *follow key*: a household id, or `entry:<id>` for a
// Covenant Path Progress entry that has no household (People Being Taught, or
// a member not linked to one) — the same keys the app stores in
// profiles/{uid}.followHouseholds.

const GROUP_LABEL = { new: 'New Members', returning: 'Returning Members', mission: 'People Being Taught', movein: 'Move Ins' };
const STATUS_LABEL = { new: 'New', contacted: 'Contacted', pool: 'Ministering pool decided', assigned: 'Ministering assignments done' };
const KIND = { goals: 'goal', notes: 'note', nextSteps: 'next step' };

const poolLabel = v => v === true ? 'In Pool' : v === 'maybe' ? 'Maybe' : 'Out';
const byId = list => new Map((list || []).map(x => [x.id, x]));
const noteKey = n => n.id ? `id:${n.id}` : `dt:${n.date || ''}:${String(n.text || '').slice(0, 40)}`;
const newNotes = (a, b) => { const seen = new Set((a || []).map(noteKey)); return (b || []).filter(n => !seen.has(noteKey(n))); };
const pairName = c => `${c.m1Name || ''}${c.m2Name ? ' + ' + c.m2Name : ''}`.trim();
const enc = s => encodeURIComponent(s);

// Companionships list households by id, or (older records) by name.
function servesHH(c, hh) { return (c.households || []).some(h => h === hh.id || h === hh.name); }

function householdChanges(beforeDoc, afterDoc) {
  const B = beforeDoc || {}, A = afterDoc || {};
  const out = [];
  const add = (hhId, text, link) => out.push({ hhId, text, link });
  const hhB = byId(B.households), hhA = byId(A.households);
  const memB = byId(B.members), memA = byId(A.members);

  // Households: notes, pool, address, phone, removal.
  hhA.forEach((h, id) => {
    const o = hhB.get(id);
    if (!o) return;                                  // brand-new household: nobody follows it yet
    newNotes(o.notes, h.notes).forEach(n => add(id, `${n.author || 'Someone'} added a note on ${h.name}`, `#open=household,${enc(id)}`));
    if (poolLabel(o.inPool) !== poolLabel(h.inPool)) add(id, `${h.name}: ministering pool ${poolLabel(o.inPool)} → ${poolLabel(h.inPool)}`, '#tab=households');
    if ((o.address || '') !== (h.address || '')) add(id, `${h.name}: address updated`, '#tab=households');
    if ((o.phone || '') !== (h.phone || '')) add(id, `${h.name}: phone updated`, '#tab=households');
  });
  hhB.forEach((o, id) => { if (!hhA.has(id)) add(id, `${o.name} was removed from the households list`, '#tab=households'); });

  // Members linked to a household (before or after the save).
  const hhName = id => (hhA.get(id) || hhB.get(id) || {}).name || 'the household';
  memA.forEach((m, id) => {
    const o = memB.get(id);
    if (!o) { if (m.householdId) add(m.householdId, `${m.name} was added to ${hhName(m.householdId)}`, '#tab=members'); return; }
    if (o.householdId !== m.householdId) {
      if (o.householdId) add(o.householdId, `${m.name} is no longer linked to ${hhName(o.householdId)}`, '#tab=members');
      if (m.householdId) add(m.householdId, `${m.name} was linked to ${hhName(m.householdId)}`, '#tab=members');
    }
    if (!m.householdId) return;
    newNotes(o.notes, m.notes).forEach(n => add(m.householdId, `${n.author || 'Someone'} added a note on ${m.name}`, `#open=member,${enc(id)}`));
    if (o.inPool !== m.inPool && (o.isBrother !== false)) add(m.householdId, `${m.name}: ministering pool ${poolLabel(o.inPool)} → ${poolLabel(m.inPool)}`, '#tab=brothers');
  });
  memB.forEach((o, id) => { if (!memA.has(id) && o.householdId) add(o.householdId, `${o.name} was removed from the members list`, '#tab=members'); });

  // Companionships: newly assigned / unassigned, and notes.
  const allHH = [...new Map([...hhB, ...hhA]).values()];
  [['current', 'Current Assignments'], ['proposed', 'Proposed Assignments']].forEach(([key, label]) => {
    const cB = byId(B[key]), cA = byId(A[key]);
    allHH.forEach(hh => {
      cA.forEach((c, id) => {
        const o = cB.get(id);
        const was = !!o && servesHH(o, hh), is = servesHH(c, hh);
        if (is && !was) add(hh.id, `${hh.name} assigned to ${pairName(c)} (${label})`, `#tab=${key === 'current' ? 'current' : 'propose'}`);
        if (is && o) newNotes(o.notes, c.notes).forEach(n => add(hh.id, `${n.author || 'Someone'} added a note on the companionship serving ${hh.name} (${label})`, `#open=${key},${enc(id)}`));
        if (!is && was) add(hh.id, `${hh.name} no longer assigned to ${pairName(c)} (${label})`, `#tab=${key === 'current' ? 'current' : 'propose'}`);
      });
      cB.forEach((o, id) => { if (!cA.has(id) && servesHH(o, hh)) add(hh.id, `${pairName(o)} companionship serving ${hh.name} was removed (${label})`, `#tab=${key === 'current' ? 'current' : 'propose'}`); });
    });
  });

  // Ward council lists and Move Ins.
  const entryHH = e => e.householdId || (e.memberId && (memA.get(e.memberId) || memB.get(e.memberId) || {}).householdId) || null;
  const gA = A.groups || {}, gB = B.groups || {};
  Object.keys(GROUP_LABEL).forEach(g => {
    const label = GROUP_LABEL[g], tab = g === 'movein' ? 'moves' : 'council';
    const eB = byId(gB[g]), eA = byId(gA[g]);
    eA.forEach((e, id) => {
      const hh = entryHH(e) || `entry:${id}`;
      const name = e.householdId ? hhName(e.householdId) : (e.name || 'A member');
      const o = eB.get(id);
      if (!o) { add(hh, `${name} was added to ${label}`, `#tab=${tab}`); return; }
      if (g === 'movein' && (o.status || 'new') !== (e.status || 'new'))
        add(hh, `${name}: Move In status ${STATUS_LABEL[o.status || 'new'] || o.status} → ${STATUS_LABEL[e.status || 'new'] || e.status}`, '#tab=moves');
      ['goals', 'notes', 'nextSteps'].forEach(f => newNotes(o[f], e[f]).forEach(n =>
        add(hh, `${n.author || 'Someone'} added a ${KIND[f]} for ${name} (${label})`, `#open=group,${enc(id)},${g},${f}`)));
    });
    eB.forEach((o, id) => { if (!eA.has(id)) add(entryHH(o) || `entry:${id}`, `${o.name || 'An entry'} was removed from ${label}`, `#tab=${tab}`); });
  });

  return out;
}

// Push text for a follower. Like tag alerts, it names only the person who made
// the change — the household and details are in the app.
function followMessage(updater, count) {
  const who = updater || 'Someone';
  return count === 1 ? `${who} updated a household you follow.` : `${who} made ${count} updates to households you follow.`;
}

module.exports = { householdChanges, followMessage, poolLabel };
