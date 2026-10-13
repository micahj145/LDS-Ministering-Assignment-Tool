// Ministering tool service worker.
//
// Deliberately caches nothing and has no fetch handler, so every request goes
// straight to the network exactly as it would without it. That keeps member
// data off devices and leaves the ?v= cache-buster in charge of updates.
//
// Its one job beyond making the app installable is phone notifications: the
// Cloud Functions in functions/ send a data-only message through Firebase
// Cloud Messaging when someone is tagged (or, for admins, when someone asks
// for access), and this shows it and sets the app-icon badge. Messages carry
// only a user's name, never member data.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

try {
  importScripts(
    'https://www.gstatic.com/firebasejs/12.18.0/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/12.18.0/firebase-messaging-compat.js'
  );
  // Same client-safe config as ministering_tool.html.
  firebase.initializeApp({
    apiKey: 'AIzaSyD7j-JaXl9T11FKRKQaGnI8OZAjzkR07PE',
    authDomain: 'pb1-ward-council-planning.firebaseapp.com',
    projectId: 'pb1-ward-council-planning',
    storageBucket: 'pb1-ward-council-planning.firebasestorage.app',
    messagingSenderId: '633648985018',
    appId: '1:633648985018:web:8030ffa71391aa7da32383',
  });
  firebase.messaging().onBackgroundMessage(payload => {
    const d = payload.data || {};
    const n = parseInt(d.unread, 10);
    if (self.navigator.setAppBadge && n > 0) self.navigator.setAppBadge(n).catch(() => {});
    return self.registration.showNotification(d.title || 'Ministering', {
      body: d.body || 'You were tagged.',
      icon: 'icons/icon-192.png',
      tag: d.tag || 'ministering-tagged',   // replaces an older one of the same kind rather than stacking
      renotify: true,
      data: { link: d.link || './ministering_tool.html#notifications' },
    });
  });
} catch (e) {
  // Offline or blocked: the app still works, just without phone notifications.
}

// Tapping a notification: reuse an open window if there is one, otherwise open
// the app on the tab named in the link's #hash (notifications, or admin for an
// access request).
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const link = event.notification.data?.link || './ministering_tool.html#notifications';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find(w => w.url.includes('ministering_tool.html'));
    const tab = (link.split('#')[1] || 'notifications');
    if (win) { await win.focus(); win.postMessage({ type: 'open-tab', tab }); return; }
    await self.clients.openWindow(link);
  })());
});
