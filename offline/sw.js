/* Minimal service worker: enables PWA install + Web Share Target.
   No caching — the app is local-first via IndexedDB; always fetch fresh. */
self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.clients.claim(); });
self.addEventListener('fetch', (e) => { /* passthrough: no cache */ });
