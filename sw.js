// Offline-cache voor de webversie (iPhone/Safari). Verhoog VERSION bij elke release.
const VERSION = 'rewind-pos-6.3.0';
const FILES = ['./', 'index.html', 'app.js', 'style.css', 'capacitor.js', 'rewind-logo.png', 'manifest.webmanifest', 'icons/icon192.png', 'icons/icon512.png', 'icons/apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  // Eerst het netwerk (nieuwe versie), bij geen verbinding uit de cache.
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('index.html'))));
});
