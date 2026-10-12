// Ministering tool service worker — deliberately a pass-through.
//
// It caches nothing and has no fetch handler, so every request goes straight
// to the network exactly as it would without it. That keeps member data off
// devices and leaves the ?v= cache-buster in charge of updates. It exists
// because installed web apps need a service worker, and it is where push
// notifications would be handled if they are added later.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
