// BetFriends Service Worker: Offline-Grundgerüst + Push-Benachrichtigungen
const CACHE = 'betfriends-v2';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())
));

// Netzwerk zuerst, bei Offline die letzte Version aus dem Cache (nur eigene Dateien)
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('/')))
  );
});

self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { body: e.data && e.data.text() }; }
  const title = data.title || 'BetFriends';
  const opts = { body: data.body || '', icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: data.url || '/' } };
  if (data.tag) opts.tag = data.tag;
  // Falls ein Browser eine Option nicht mag: lieber eine schlichte Nachricht als gar keine
  e.waitUntil(self.registration.showNotification(title, opts)
    .catch(() => self.registration.showNotification(title, { body: opts.body, data: opts.data })));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data && e.notification.data.url || '/';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) { if ('focus' in c) { c.navigate(url); return c.focus(); } }
    return clients.openWindow(url);
  }));
});
