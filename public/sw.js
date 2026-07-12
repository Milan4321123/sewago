const CACHE = 'sewago-static-v2';
const ASSETS = [
  '/',
  '/driver',
  '/partner',
  '/admin',
  '/download',
  '/index.html',
  '/driver.html',
  '/partner.html',
  '/admin.html',
  '/download.html',
  '/styles.css',
  '/app.js',
  '/driver.js',
  '/partner.js',
  '/admin.js',
  '/download.js',
  '/pwa.js',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png'
];

// Icons and the manifest never change without a rename — serve those cache-first.
// Everything else (HTML/JS/CSS) is network-first so a deploy reaches returning
// users immediately; the cache is only the offline fallback.
const CACHE_FIRST = /\.(png|svg|webmanifest)$/;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api')) {
    return;
  }

  if (CACHE_FIRST.test(url.pathname)) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetchAndCache(event.request))
    );
    return;
  }

  event.respondWith(
    fetchAndCache(event.request).catch(() =>
      caches.match(event.request).then((cached) => cached || caches.match('/'))
    )
  );
});

function fetchAndCache(request) {
  return fetch(request).then((response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy));
    }
    return response;
  });
}
