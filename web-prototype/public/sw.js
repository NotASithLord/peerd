// sw.js — safe app-shell cache for peerd-lite.
//
// Bypasses everything that must NOT be intercepted: non-GET, non-http(s)
// schemes (blob:/ws:/wss:/data:), cross-origin (the wss peer at
// bootstrap.peerd.ai, Google Fonts), and range requests. OPFS is not HTTP, so
// the SW never sees it. Same-origin GETs use cache-first (shell + vendored
// modules) and network-first for navigations. This keeps the sealed-worker
// notebook, dynamic ES imports, the live dweb peer, and OPFS untouched.
const CACHE = 'peerd-lite-v6';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/web/notebook-host.js',
  '/notebook-tab/worker-source.js',
  '/notebook-tab/realm-seal.js',
  '/notebook-tab/notebook-neutralizers.js',
  '/notebook-tab/notebook-std.js',
  '/notebook-tab/output-render.js',
  '/peerd-engine/index.js',
  '/peerd-engine/module-resolver.js',
  '/peerd-engine/opfs.js',
];

self.addEventListener('install', (e) => {
  // why allSettled: the peer modules etc. aren't precached; if any shell URL
  // 404s we still install rather than wedging the SW.
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // bypass: non-GET, non-http(s) (blob:/ws:/wss:/data:), cross-origin, ranges.
  if (req.method !== 'GET') return;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (url.origin !== self.location.origin) return;
  if (req.headers.has('range')) return;

  // navigations: network-first, fall back to cached shell offline.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('/index.html').then((r) => r || caches.match('/'))));
    return;
  }

  // shell + vendored modules: cache-first, populate on miss.
  e.respondWith(
    caches.match(req).then((hit) =>
      hit ||
      fetch(req).then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
    )
  );
});
