// Offline support: the app shell is cached; map data/API calls always go to the network.
const VERSION = 'milemates-v1';
const SHELL = [
  './', 'index.html', 'css/styles.css', 'js/app.js', 'js/api.js', 'js/planner.js', 'js/util.js',
  'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // APIs & tiles: network only
  // network-first so updates show up, cache as fallback when offline
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html')))
  );
});
