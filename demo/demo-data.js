// Demo only: an invented ward for demo.html. Every person, address, phone
// number, email and note below is made up. Addresses are on fictional streets
// in "Sampleton" with ZIP 00000; phone numbers use the 555-01xx range set
// aside for fiction; emails are @example.com. Nothing here came from LCR.
//
// window.DEMO_SEED() returns { 'collection/docId': data } for the fake
// Firebase in demo/fake-firebase.js. Dates are relative to today.
(function () {
  'use strict';
  window.DEMO_DEFAULT_UID = 'dEq';

  window.DEMO_SEED = function () {
    const DAY = 864e5;
    const ago = d => new Date(Date.now() - d * DAY).toISOString();
    const hrs = h => new Date(Date.now() - h * 3600e3).toISOString();
    const md = d => { const x = new Date(Date.now() + d * DAY); return String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
    const now = new Date(), q = Math.floor(now.getMonth() / 3);
    const QKEY = now.getFullYear() + 'Q' + (q + 1);
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const qMonths = [0, 1, 2].map(i => MONTHS[q * 3 + i]).filter((_, i) => q * 3 + i <= now.getMonth());

    // ── Leaders who use the tool (the "View as" list) ──
    const USERS = [
      { uid: 'dEq', email: 'sam.carter@example.com', firstName: 'Sam', lastName: 'Carter', role: 'eq', title: 'Elders quorum president' },
      { uid: 'dEq2', email: 'leo.park@example.com', firstName: 'Leo', lastName: 'Park', role: 'eq', title: 'Elders quorum counselor' },
      { uid: 'dRs', email: 'rita.ames@example.com', firstName: 'Rita', lastName: 'Ames', role: 'rs', title: 'Relief Society president' },
      { uid: 'dRs2', email: 'nora.fisk@example.com', firstName: 'Nora', lastName: 'Fisk', role: 'rs', title: 'Relief Society counselor' },
      { uid: 'dBish', email: 'ben.holt@example.com', firstName: 'Ben', lastName: 'Holt', role: 'bishopric', title: 'Bishop' },
      { uid: 'dCouncil', email: 'cora.lane@example.com', firstName: 'Cora', lastName: 'Lane', role: 'council', title: 'Primary president' },
      { uid: 'dAdmin', email: 'alex.admin@example.com', firstName: 'Alex', lastName: 'Admin', role: 'council', admin: true, title: 'Tool administrator' },
    ];
    const U = Object.fromEntries(USERS.map(u => [u.uid, u]));
    const tag = uid => ({ uid, name: U[uid].firstName + ' ' + U[uid].lastName });
    const by = uid => ({ author: U[uid].firstName + ' ' + U[uid].lastName, authorId: uid });
    let nid = 0;
    const note = (uid, text, hoursAgo, tags) => ({ id: 'dn' + (++nid), ...by(uid), text, date: hrs(hoursAgo), ...(tags ? { tags: tags.map(tag) } : {}) });

    // ── Households and members ──
    // [id, surname, people: [first, gender, age, extra?], street, extra?]
    const BASE = [39.05, -95.70];
    const HH = [
      ['h1', 'Applewood', [['Aaron', 'M', 41], ['Beth', 'F', 39], ['Cody', 'M', 15], ['Dana', 'F', 12]], '101 Maple Example Ln', { inPool: true }],
      ['h2', 'Birchfield', [['Evan', 'M', 35], ['Faye', 'F', 33]], '214 Oak Sample St', { inPool: true }],
      ['h3', 'Cedarly', [['Gwen', 'F', 78]], '9 Pine Demo Ct', { inPool: true }],
      ['h4', 'Dunmore', [['Hal', 'M', 52], ['Iris', 'F', 50], ['Jack', 'M', 19]], '330 Elm Fiction Ave', { inPool: true }],
      ['h5', 'Elmsworth', [['Kai', 'M', 27]], '45 Willow Placeholder Rd Apt 2', { inPool: true }],
      ['h6', 'Fernhill', [['Liam', 'M', 63], ['Mae', 'F', 61]], '78 Aspen Mock Dr', { inPool: true }],
      ['h7', 'Grover', [['Nell', 'F', 34], ['Owen', 'M', 8]], '12 Spruce Example Way', { inPool: true }],
      ['h8', 'Hartley', [['Paul', 'M', 45], ['Quinn', 'F', 44], ['Rose', 'F', 17]], '560 Birch Sample Blvd', { inPool: true }],
      ['h9', 'Ivers', [['Sean', 'M', 23]], '7 Hazel Demo Ln Apt 11', { inPool: 'maybe' }],
      ['h10', 'Jansen', [['Tess', 'F', 71]], '88 Poplar Fiction St', { inPool: true }],
      ['h11', 'Kestrel', [['Uri', 'M', 38], ['Vera', 'F', 36]], '402 Cypress Mock Ct', { inPool: true, partMember: true }],
      ['h12', 'Lowell', [['Wade', 'M', 58], ['Xena', 'F', 55]], '19 Juniper Placeholder Ave', { inPool: true }],
      ['h13', 'Marsh', [['Yara', 'F', 29]], '250 Laurel Example Rd', { inPool: true }],
      ['h14', 'Norwood', [['Zane', 'M', 47], ['Ada', 'F', 46]], '61 Holly Sample Dr', { inPool: true }],
      ['h15', 'Oakes', [['Bram', 'M', 31], ['Cleo', 'F', 30]], '133 Alder Demo Way', { inPool: true }],
      ['h16', 'Pruitt', [['Dot', 'F', 84]], '5 Sycamore Fiction Ln', { inPool: true }],
      ['h17', 'Quill', [['Eli', 'M', 26], ['Fern', 'F', 25]], '700 Magnolia Mock Blvd', {}],
      ['h18', 'Rowan', [['Gus', 'M', 22]], '42 Redwood Placeholder St Apt 3', {}],
    ];
    const members = [], households = [];
    let mid = 0, ph = 100;
    HH.forEach(([id, sur, people, street, extra], i) => {
      const angle = i * 0.9, r = 0.01 + (i % 5) * 0.006;
      const lat = +(BASE[0] + r * Math.sin(angle)).toFixed(5), lng = +(BASE[1] + r * Math.cos(angle)).toFixed(5);
      const names = [];
      people.forEach(([first, g, age]) => {
        const m = { id: 'm' + (++mid), name: sur + ', ' + first, gender: g, age, householdId: id,
          phone: age >= 16 ? '555-01' + String(ph++ % 100).padStart(2, '0') : '',
          email: age >= 18 ? (first + '.' + sur).toLowerCase() + '@example.com' : '' };
        members.push(m); names.push(m.name);
      });
      const adults = people.filter(p => p[2] >= 18).map(p => p[0]);
      households.push({ id, name: sur + ', ' + adults.join(' & '), members: names, address: street + ', Sampleton XX 00000',
        phone: '555-01' + String(ph++ % 100).padStart(2, '0'), lat, lng, ...extra });
    });
    const M = n => members.find(m => m.name === n);
    const set = (n, extra) => Object.assign(M(n), extra);

    // Pools and markers
    ['Applewood, Aaron', 'Birchfield, Evan', 'Dunmore, Hal', 'Dunmore, Jack', 'Elmsworth, Kai', 'Fernhill, Liam', 'Hartley, Paul',
      'Kestrel, Uri', 'Lowell, Wade', 'Norwood, Zane', 'Oakes, Bram'].forEach(n => set(n, { inPool: true }));
    set('Ivers, Sean', { inPool: 'maybe' }); set('Quill, Eli', { inPool: 'maybe' });
    ['Applewood, Beth', 'Birchfield, Faye', 'Dunmore, Iris', 'Fernhill, Mae', 'Hartley, Quinn', 'Lowell, Xena', 'Norwood, Ada', 'Oakes, Cleo', 'Marsh, Yara']
      .forEach(n => set(n, { rsPool: true }));
    ['Cedarly, Gwen', 'Grover, Nell', 'Jansen, Tess', 'Pruitt, Dot', 'Kestrel, Vera', 'Marsh, Yara', 'Quill, Fern', 'Applewood, Beth', 'Birchfield, Faye', 'Dunmore, Iris']
      .forEach(n => set(n, { rsRecipient: true }));
    set('Quill, Fern', { rsRecipient: 'maybe' });
    set('Elmsworth, Kai', { ident: { ysa: true, noCalling: true } });
    set('Ivers, Sean', { ident: { ysa: true } });
    set('Rowan, Gus', { ident: { ysa: true, noCalling: true } });
    set('Marsh, Yara', { ident: { noCalling: true, bday: md(4) } });
    set('Hartley, Paul', { ident: { bday: md(9) } });
    set('Kestrel, Vera', { ident: { partMember: true } });

    // ── Ministering: brothers ──
    const id = n => M(n).id;
    const C = (cid, names, hh, district, leader, position, extra = {}) => {
      const c = { id: cid, households: hh, position, district, districtLeader: leader, ...extra };
      names.forEach((n, i) => { const k = i === 0 ? 'm1' : i === 1 ? 'm2' : 'm3'; c[k + 'Id'] = id(n); c[k + 'Name'] = n; });
      if (!c.m2Id) { c.m2Id = null; c.m2Name = ''; }
      return c;
    };
    const iv = (names, months) => ({ [QKEY]: { months: Object.fromEntries(months.filter(mo => qMonths.includes(mo)).map(mo => [mo, names])), done: false, src: 'manual', by: 'Sam Carter', at: ago(10) } });
    const firstMo = qMonths[0];
    const current = [
      C('c1', ['Applewood, Aaron', 'Elmsworth, Kai'], ['h3', 'h10'], 'District 1', 'Hartley, Paul', 0, { interviews: iv(['Applewood, Aaron', 'Elmsworth, Kai'], [firstMo]) }),
      C('c2', ['Birchfield, Evan', 'Dunmore, Jack'], ['h16', 'h13'], 'District 1', 'Hartley, Paul', 1),
      C('c3', ['Dunmore, Hal', 'Kestrel, Uri'], ['h7', 'h9'], 'District 1', 'Hartley, Paul', 2, { interviews: iv(['Dunmore, Hal'], [firstMo]) }),
      C('c4', ['Fernhill, Liam', 'Oakes, Bram'], ['h17', 'h18'], 'District 2', 'Lowell, Wade', 3),
      C('c5', ['Norwood, Zane', 'Lowell, Wade'], ['h11', 'h5'], 'District 2', 'Lowell, Wade', 4, { interviews: iv(['Norwood, Zane', 'Lowell, Wade'], [firstMo]) }),
    ];
    current[0].notes = [note('dEq', 'Plan a visit with Sister Cedarly before the end of the month.', 30)];
    // Draft: c2 changed (one household swapped), c4 removed, one new, the rest the same.
    const copy = c => ({ ...JSON.parse(JSON.stringify(c)), id: 'p' + c.id.slice(1), fromId: c.id, notes: [] });
    const proposed = [copy(current[0]), copy(current[1]), copy(current[2]), copy(current[4])].map(c => { delete c.interviews; return c; });
    proposed[1].households = ['h16', 'h4'];
    proposed.push(C('pn1', ['Fernhill, Liam', 'Ivers, Sean'], ['h17', 'h18', 'h13'], 'District 2', 'Lowell, Wade', 5));
    proposed.forEach((c, i) => { c.position = i; });
    proposed[4].notes = [note('dEq2', 'Brother Ivers said he is glad to help. Confirm with Brother Fernhill.', 8, ['dEq'])];

    // ── Ministering: sisters (to individual sisters) ──
    const R = (cid, names, assignees, district, leader, position, extra = {}) => ({ ...C(cid, names, [], district, leader, position, extra), assignees: assignees.map(id) });
    const currentRS = [
      R('r1', ['Applewood, Beth', 'Hartley, Quinn'], ['Cedarly, Gwen', 'Jansen, Tess'], 'District A', 'Lowell, Xena', 0, { interviews: iv(['Applewood, Beth', 'Hartley, Quinn'], [firstMo]) }),
      R('r2', ['Birchfield, Faye', 'Oakes, Cleo'], ['Grover, Nell', 'Pruitt, Dot'], 'District A', 'Lowell, Xena', 1),
      R('r3', ['Dunmore, Iris', 'Norwood, Ada'], ['Kestrel, Vera', 'Quill, Fern'], 'District B', 'Fernhill, Mae', 2),
      R('r4', ['Fernhill, Mae', 'Marsh, Yara'], ['Applewood, Beth', 'Birchfield, Faye'], 'District B', 'Fernhill, Mae', 3, { interviews: iv(['Fernhill, Mae'], [firstMo]) }),
    ];
    const proposedRS = currentRS.map(copy).map(c => { delete c.interviews; return c; });
    proposedRS[2].assignees = [id('Kestrel, Vera'), id('Marsh, Yara')];
    proposedRS.push(R('rn1', ['Lowell, Xena', 'Quill, Fern'], ['Dunmore, Iris'], 'District B', 'Fernhill, Mae', 4));
    proposedRS.forEach((c, i) => { c.position = i; });

    // ── Threads on people and households (tasks and follow-ups only) ──
    const mem = n => M(n), hh = hid => households.find(h => h.id === hid);
    mem('Elmsworth, Kai').notes = [note('dEq', 'Invite Kai to help with the service project on Saturday.', 50)];
    mem('Elmsworth, Kai').goals = [note('dEq', 'Help Kai find a calling that fits his schedule.', 200)];
    hh('h3').nextSteps = [note('dRs', 'Set up the visiting schedule for this month.', 6, ['dRs2'])];
    hh('h17').notes = [note('dBish', 'New to the ward. Welcome them at church on Sunday.', 72, ['dEq', 'dRs'])];
    hh('h17').nextSteps = [note('dEq2', 'Drop off a ward directory sign-up card.', 20, ['dEq'])];
    hh('h11').goals = [note('dEq', 'Invite the Kestrels to the ward picnic.', 120)];

    // ── Covenant Path Progress and Move Ins ──
    const groups = {
      new: [{ id: 'g1', memberId: id('Quill, Eli'), name: 'Quill, Eli', lcr: { detail: 'Member for 2 months', asOf: ago(3) }, goals: [note('dCouncil', 'Introduce Eli to the elders quorum presidency.', 90, ['dEq'])], notes: [], hiddenLinks: [] }],
      returning: [{ id: 'g2', memberId: id('Rowan, Gus'), name: 'Rowan, Gus', lcr: { detail: 'Returning member', asOf: ago(3) }, goals: [], notes: [note('dEq2', 'Gus would like to come to the next activity.', 40)], hiddenLinks: [] }],
      mission: [{ id: 'g3', name: 'Morgan Example', lcr: { detail: 'First Taught - ' + new Date(Date.now() - 20 * DAY).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }), asOf: ago(3) }, goals: [], notes: [], hiddenLinks: [] }],
      movein: [
        { id: 'e1', householdId: 'h17', name: 'Quill, Eli & Fern', people: [
          { memberId: id('Quill, Eli'), name: 'Quill, Eli', position: 'Primary Household Contact', age: 26, moveInDate: ago(25).slice(0, 10) },
          { memberId: id('Quill, Fern'), name: 'Quill, Fern', position: 'Spouse', age: 25, moveInDate: ago(25).slice(0, 10) }],
          moveInDate: ago(25).slice(0, 10), status: 'contacted', statusBy: 'Sam Carter', statusDate: ago(10), notes: [], nextSteps: [], goals: [], hiddenLinks: [], addedBy: 'Sam Carter', addedDate: ago(24), source: 'demo' },
        { id: 'e2', householdId: 'h18', name: 'Rowan, Gus', people: [{ memberId: id('Rowan, Gus'), name: 'Rowan, Gus', position: 'Primary Household Contact', age: 22, moveInDate: ago(12).slice(0, 10) }],
          moveInDate: ago(12).slice(0, 10), status: 'new', notes: [], nextSteps: [], goals: [], hiddenLinks: [], addedBy: 'Sam Carter', addedDate: ago(11), source: 'demo' },
      ],
      moveout: [{ id: 'o1', name: 'Sterling, Max', householdName: 'Sterling, Max', moveDate: ago(30).slice(0, 10), newUnit: 'Another Example Ward', removedBy: 'Ben Holt', removedDate: ago(20) }],
    };

    const identMeta = {
      noCalling: { at: ago(5), by: 'Rita Ames', count: 3, unmatched: [] },
      ysa: { at: ago(5), by: 'Rita Ames', count: 3, unmatched: [] },
      partMember: { at: ago(5), by: 'Rita Ames', count: 1, households: 1, unmatched: [] },
      bday: { at: ago(5), by: 'Rita Ames', count: members.length, unmatched: [] },
    };
    const importMeta = Object.fromEntries(['members-csv', 'households-csv'].map(k => [k, { at: ago(6), by: 'Ben Holt', count: k === 'members-csv' ? members.length : households.length }])
      .concat([['ministering-eq', { at: ago(6), by: 'Sam Carter', count: current.length }], ['ministering-rs', { at: ago(6), by: 'Rita Ames', count: currentRS.length }]]));

    const ward = {
      members, households, current, proposed, currentRS, proposedRS, groups,
      users: USERS.map(u => tag(u.uid)), identMeta, importMeta,
      draftDistricts: null, draftDistrictsRS: null,
      activityLog: [{ ts: ago(1), user: 'Sam Carter' }, { ts: ago(2), user: 'Rita Ames' }],
      updatedBy: 'Demo', updatedByUid: null,
    };

    const out = { 'wardData/shared': ward };
    USERS.forEach((u, i) => {
      out['profiles/' + u.uid] = { email: u.email, firstName: u.firstName, lastName: u.lastName, status: 'approved', isAdmin: !!u.admin,
        createdAt: ago(60 - i), emailVerified: true, notifSeenAt: ago(2), followHouseholds: u.uid === 'dEq' ? ['h17'] : [],
        feed: u.uid === 'dEq' ? [{ hhId: 'h17', text: 'Ben Holt added a note to Quill, Eli & Fern.', link: '#open=household,h17', at: hrs(72) }] : [] };
      out['allowedUsers/' + u.email] = { email: u.email, uid: u.uid, role: u.role, admin: !!u.admin, updatedAt: ago(30), updatedBy: 'alex.admin@example.com' };
    });
    out['adminData/callings'] = { users: Object.fromEntries(USERS.map(u => [u.email, { name: u.lastName + ', ' + u.firstName, callings: [u.title], expected: u.role, accessOk: true }])) };
    out['threads/t1'] = { participants: ['dEq', 'dBish'], names: { dEq: 'Sam Carter', dBish: 'Ben Holt' }, createdBy: 'dBish', createdAt: hrs(30), lastAt: hrs(28), lastBy: 'dEq', lastByName: 'Sam Carter' };
    out['threads/t1/messages/x1'] = { authorId: 'dBish', authorName: 'Ben Holt', text: 'Can we go over the draft assignments on Sunday?', createdAt: hrs(30) };
    out['threads/t1/messages/x2'] = { authorId: 'dEq', authorName: 'Sam Carter', text: 'Yes, after ward council works for me.', createdAt: hrs(28) };
    return out;
  };
})();
