// Ministering tool — push notifications.
//
//  notifyTagged         every save of wardData/shared: tell people who were newly tagged.
//  notifyAccessRequest  a new profiles/{uid} with status 'pending' (a sign-up): tell the admins.
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

initializeApp();

const REGION = 'us-central1';
const APP = 'https://micahj145.github.io/LDS-Ministering-Assignment-Tool/ministering_tool.html';
const DEAD_TOKEN = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument']);

// Send one data message to every device on a profile, and drop tokens FCM
// says are gone (app uninstalled, data cleared).
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
    const name = [p.firstName, p.lastName].filter(Boolean).join(' ');
    const r = await sendToProfile(ref, p, {
      title: 'Ministering', body: messageFor(tags), tag: 'ministering-tagged',
      unread: String(unreadCount(after, uid, p.notifSeenAt, name)), link: `${APP}#notifications`,
    });
    logger.info('notifyTagged', { uid, tags: tags.length, ...r });
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
