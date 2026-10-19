// Ministering tool — push notifications.
//
//  notifyTagged         every save of wardData/shared: tell people who were newly tagged.
//  notifyFollowers      every save of wardData/shared: tell people following a household what
//                       changed for it (written to their profile's `feed`, plus a push).
//  notifyAccessRequest  a new profiles/{uid} with status 'pending' (a sign-up): tell the admins.
//  notifyMessage        a new direct message: tell the other people in the conversation.
//  notifyRestrictedNote a restricted note created or shared with more people: tell the new viewers.
//
// Device tokens live on profiles/{uid}.fcmTokens, written by the app when someone
// turns on phone notifications. The Admin SDK used here is not bound by
// firestore.rules. Messages are data-only: the app's service worker (sw.js)
// shows the notification, sets the icon badge from `unread`, and on tap opens
// `link` (#notifications or #admin).

const { onDocumentWritten, onDocumentCreated } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { newTags, unreadCount, messageFor, accessRequestMessage } = require('./tags');
const { householdChanges, followMessage } = require('./follow');
const { dmMessage, restrictedMessage, newViewers, threadsUnread, restrictedUnread } = require('./private');

initializeApp();

const REGION = 'us-central1';
const APP = 'https://micahj145.github.io/LDS-Ministering-Assignment-Tool/ministering_tool.html';
const FEED_MAX = 500;                         // newest entries kept on each follower's profile
const FOLLOW_PUSH_GAP_MS = 3 * 60 * 1000;     // at most one follow alert per person per 3 minutes
const DEAD_TOKEN = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument']);

// Send one data message to every device on a profile, and drop tokens FCM
// says are gone (app uninstalled, data cleared).
// Unread = tags (same rule as the app) plus followed-household updates since
// the person last opened Notifications.
function totalUnread(doc, uid, p) {
  const name = [p.firstName, p.lastName].filter(Boolean).join(' ');
  const seen = Date.parse(p.notifSeenAt) || 0;
  const feedNew = (Array.isArray(p.feed) ? p.feed : []).filter(f => (Date.parse(f.ts) || 0) > seen).length;
  return unreadCount(doc, uid, p.notifSeenAt, name, p.clearedTags) + feedNew;
}

// Unread direct messages and restricted notes (the Messages tab). Read with the
// Admin SDK, which firestore.rules don't bind; only counts leave this function.
async function privateUnread(db, uid, p) {
  try {
    const [t, n] = await Promise.all([
      db.collection('threads').where('participants', 'array-contains', uid).get(),
      db.collection('privateNotes').where('viewers', 'array-contains', uid).get(),
    ]);
    return threadsUnread(t.docs.map(d => ({ id: d.id, ...d.data() })), uid, p.threadSeen)
         + restrictedUnread(n.docs.map(d => d.data()), uid, p.restrictedSeenAt);
  } catch (e) {
    logger.warn('privateUnread failed', { uid, error: e.message });
    return 0;
  }
}

// The number on the app icon: Notifications tab + Messages tab.
async function badgeCount(db, ward, uid, p) {
  return totalUnread(ward || {}, uid, p) + await privateUnread(db, uid, p);
}

async function sendToProfile(ref, profile, data) {
  const tokens = Array.isArray(profile.fcmTokens) ? profile.fcmTokens.filter(Boolean) : [];
  if (!tokens.length) return { sent: 0, failed: 0, removed: 0 };
  const res = await getMessaging().sendEachForMulticast({
    tokens,
    data,
    webpush: { headers: { Urgency: 'high', TTL: String(3 * 24 * 3600) }, fcmOptions: { link: data.link } },
  });
  const dead = [];
  res.responses.forEach((r, i) => { if (!r.success && DEAD_TOKEN.has(r.error?.code)) dead.push(tokens[i]); });
  if (dead.length) await ref.update({ fcmTokens: FieldValue.arrayRemove(...dead) });
  return { sent: res.successCount, failed: res.failureCount, removed: dead.length };
}

exports.notifyTagged = onDocumentWritten({ document: 'wardData/shared', region: REGION, maxInstances: 2 }, async (event) => {
  const before = event.data?.before?.exists ? event.data.before.data() : {};
  const after = event.data?.after?.exists ? event.data.after.data() : null;
  if (!after) return;

  const fresh = newTags(before, after);
  if (!fresh.length) return;

  const byUser = new Map();
  fresh.forEach(t => { if (!byUser.has(t.uid)) byUser.set(t.uid, []); byUser.get(t.uid).push(t); });

  const db = getFirestore();
  for (const [uid, tags] of byUser) {
    const ref = db.collection('profiles').doc(uid);
    const snap = await ref.get();
    if (!snap.exists) continue;
    const p = snap.data();
    if (p.status !== 'approved') continue;
    const r = await sendToProfile(ref, p, {
      title: 'Ministering', body: messageFor(tags), tag: 'ministering-tagged',
      unread: String(await badgeCount(db, after, uid, p)), link: `${APP}#notifications`,
    });
    logger.info('notifyTagged', { uid, tags: tags.length, ...r });
  }
});

exports.notifyFollowers = onDocumentWritten({ document: 'wardData/shared', region: REGION, maxInstances: 2 }, async (event) => {
  const before = event.data?.before?.exists ? event.data.before.data() : null;
  const after = event.data?.after?.exists ? event.data.after.data() : null;
  if (!before || !after) return;                 // first write or a delete: nothing to compare

  const changes = householdChanges(before, after);
  if (!changes.length) return;
  const hhIds = [...new Set(changes.map(c => c.hhId))];
  const updaterUid = after.updatedByUid || null;
  const updater = after.updatedBy || 'Someone';
  const now = new Date();

  // array-contains-any takes at most 30 values per query.
  const db = getFirestore();
  const followers = new Map();
  for (let i = 0; i < hhIds.length; i += 30) {
    const snap = await db.collection('profiles').where('followHouseholds', 'array-contains-any', hhIds.slice(i, i + 30)).get();
    snap.docs.forEach(d => followers.set(d.id, d));
  }

  for (const [uid, doc] of followers) {
    const p = doc.data();
    if (p.status !== 'approved' || uid === updaterUid) continue;    // your own edits don't notify you
    const mine = new Set(p.followHouseholds || []);
    const events = changes.filter(c => mine.has(c.hhId))
      .map(c => ({ ...c, by: updater, ts: now.toISOString() }));
    if (!events.length) continue;

    // Re-read the profile inside a transaction so a "Clear" the person just
    // made in the app isn't overwritten by the copy read for the query above.
    const { fresh, feed, pushNow } = await db.runTransaction(async (tx) => {
      const cur = (await tx.get(doc.ref)).data() || {};
      const feed = events.concat(Array.isArray(cur.feed) ? cur.feed : []).slice(0, FEED_MAX);
      const pushNow = now - (Date.parse(cur.lastFollowPushAt) || 0) >= FOLLOW_PUSH_GAP_MS;
      tx.update(doc.ref, pushNow ? { feed, lastFollowPushAt: now.toISOString() } : { feed });
      return { fresh: cur, feed, pushNow };
    });
    if (!pushNow) { logger.info('notifyFollowers (feed only, throttled)', { uid, events: events.length }); continue; }

    const r = await sendToProfile(doc.ref, { ...fresh, feed }, {
      title: 'Ministering', body: followMessage(updater, events.length), tag: 'ministering-follow',
      unread: String(await badgeCount(db, after, uid, { ...fresh, feed })), link: `${APP}#notifications`,
    });
    logger.info('notifyFollowers', { uid, events: events.length, ...r });
  }
});

exports.notifyAccessRequest = onDocumentCreated({ document: 'profiles/{uid}', region: REGION, maxInstances: 2 }, async (event) => {
  const p = event.data?.data();
  if (!p || p.status !== 'pending') return;      // the bootstrap admin signs up already approved

  const db = getFirestore();
  const admins = await db.collection('profiles').where('isAdmin', '==', true).get();
  for (const doc of admins.docs) {
    const a = doc.data();
    if (a.status !== 'approved' || doc.id === event.params.uid) continue;
    const r = await sendToProfile(doc.ref, a, {
      title: 'Ministering', body: accessRequestMessage(p), tag: 'ministering-access', link: `${APP}#admin`,
    });
    logger.info('notifyAccessRequest', { admin: doc.id, requester: event.params.uid, ...r });
  }
});

// Shared by both private triggers: push to each profile, with the icon badge.
async function notifyUids(db, uids, data, label) {
  if (!uids.length) return;
  const ward = (await db.doc('wardData/shared').get()).data() || {};
  for (const uid of uids) {
    const ref = db.collection('profiles').doc(uid);
    const snap = await ref.get();
    if (!snap.exists) continue;
    const p = snap.data();
    if (p.status !== 'approved') continue;
    const r = await sendToProfile(ref, p, { ...data, unread: String(await badgeCount(db, ward, uid, p)) });
    logger.info(label, { uid, ...r });
  }
}

exports.notifyMessage = onDocumentCreated({ document: 'threads/{threadId}/messages/{msgId}', region: REGION, maxInstances: 2 }, async (event) => {
  const m = event.data?.data();
  if (!m) return;
  const db = getFirestore();
  const t = await db.collection('threads').doc(event.params.threadId).get();
  if (!t.exists) return;
  const to = (t.data().participants || []).filter(uid => uid && uid !== m.authorId);
  await notifyUids(db, to, {
    title: 'Ministering', body: dmMessage(m.authorName), tag: 'ministering-dm', link: `${APP}#tab=messages`,
  }, 'notifyMessage');
});

exports.notifyRestrictedNote = onDocumentWritten({ document: 'privateNotes/{noteId}', region: REGION, maxInstances: 2 }, async (event) => {
  const before = event.data?.before?.exists ? event.data.before.data() : null;
  const after = event.data?.after?.exists ? event.data.after.data() : null;
  if (!after) return;
  const db = getFirestore();
  await notifyUids(db, newViewers(before, after), {
    title: 'Ministering', body: restrictedMessage(after.authorName), tag: 'ministering-restricted', link: `${APP}#tab=messages`,
  }, 'notifyRestrictedNote');
});
