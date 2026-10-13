// Ministering tool — push notifications for tags.
//
// Runs on every save of the shared ward document (wardData/shared). Works out
// which (note, person) tags are new since the previous version and sends each
// tagged person's registered devices a short push through Firebase Cloud
// Messaging. Device tokens live on profiles/{uid}.fcmTokens, written by the app
// when someone turns on phone notifications. The Admin SDK used here is not
// bound by firestore.rules.
//
// The message is data-only: the app's service worker (sw.js) shows the
// notification and sets the icon badge from `unread`.

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');
const { newTags, unreadCount, messageFor } = require('./tags');

initializeApp();

const APP_URL = 'https://micahj145.github.io/LDS-Ministering-Assignment-Tool/ministering_tool.html#notifications';
const DEAD_TOKEN = new Set(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument']);

exports.notifyTagged = onDocumentWritten({ document: 'wardData/shared', region: 'us-central1', maxInstances: 2 }, async (event) => {
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
    const tokens = Array.isArray(p.fcmTokens) ? p.fcmTokens.filter(Boolean) : [];
    if (p.status !== 'approved' || !tokens.length) continue;

    const name = [p.firstName, p.lastName].filter(Boolean).join(' ');
    const unread = unreadCount(after, uid, p.notifSeenAt, name);
    const res = await getMessaging().sendEachForMulticast({
      tokens,
      data: { title: 'Ministering', body: messageFor(tags), unread: String(unread), link: APP_URL },
      webpush: { headers: { Urgency: 'high', TTL: String(3 * 24 * 3600) }, fcmOptions: { link: APP_URL } },
    });

    const dead = [];
    res.responses.forEach((r, i) => { if (!r.success && DEAD_TOKEN.has(r.error?.code)) dead.push(tokens[i]); });
    if (dead.length) await ref.update({ fcmTokens: FieldValue.arrayRemove(...dead) });
    logger.info('notifyTagged', { uid, tags: tags.length, sent: res.successCount, failed: res.failureCount, removed: dead.length });
  }
});
