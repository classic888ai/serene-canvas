/* Serene Canvas service worker — precache app shell, offline-first.
   CACHE_VERSION is rewritten by pipeline/build.py on production builds. */
const CACHE_VERSION = 'sp-ba76803c9c';
const PRECACHE = [
  './',
  'index.html',
  'app.b85df8f2.js',
  'levels.97e7b5bb.js',
  'manifest.webmanifest',
  'sounds/pop_1.mp3',
  'sounds/pop_2.mp3',
  'sounds/pop_3.mp3',
  'sounds/pop_4.mp3',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/tools/bomb.png',
  'icons/tools/brush.png',
  'icons/tools/bucket.png',
  'icons/tools/wand.png',
  'icons/tools/eraser.png',
  'icons/tools/coin.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_VERSION).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;

  // documents: network-first so index.html updates land immediately
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(e.request, copy));
          return res;
        })
        .catch(() => caches.match(e.request).then((hit) => hit || caches.match('./')))
    );
    return;
  }

  // assets: cache-first (hashed filenames make these immutable in prod)
  e.respondWith(
    caches.match(e.request).then(
      (hit) =>
        hit ||
        fetch(e.request).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(e.request, copy));
          }
          return res;
        })
    )
  );
});
