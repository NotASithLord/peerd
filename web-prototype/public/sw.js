// sw.js — safe app-shell cache for peerd-lite.
//
// Bypasses everything that must NOT be intercepted: non-GET, non-http(s)
// schemes (blob:/ws:/wss:/data:), cross-origin (the wss peer at
// bootstrap.peerd.ai, Google Fonts), and range requests. OPFS is not HTTP, so
// the SW never sees it. Same-origin GETs use cache-first (shell + vendored
// modules) and network-first for navigations. This keeps the sealed-worker
// notebook, dynamic ES imports, the live dweb peer, and OPFS untouched.
const CACHE = 'peerd-lite-v10';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/web/gemma.js',
  '/web/gemma-worker.js',
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

const putCache = (req, res) => {
  if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
  return res;
};
// network-first: always try the network (so code edits land immediately), fall
// back to cache offline. why: cache-first on app code masked new builds per-browser
// (a stale SW kept serving the old single-model app in one browser after a deploy).
const networkFirst = (req) => fetch(req).then((res) => putCache(req, res)).catch(() => caches.match(req));
// cache-first: for the heavy, effectively-immutable vendored assets (transformers,
// ORT wasm, notebook-tab, peerd-engine, p2p, shared/bundle) — don't re-download MBs.
const cacheFirst = (req) => caches.match(req).then((hit) => hit || fetch(req).then((res) => putCache(req, res)));

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
    e.respondWith(fetch(req).then((res) => putCache(req, res)).catch(() => caches.match('/index.html').then((r) => r || caches.match('/'))));
    return;
  }

  // app code (the page's own HTML/JS) is network-first so updates are never masked
  // by a stale cache; everything else same-origin (vendored MBs) is cache-first.
  const isAppCode = url.pathname === '/' || url.pathname === '/index.html'
    || url.pathname === '/manifest.json' || url.pathname.startsWith('/web/');
  e.respondWith(isAppCode ? networkFirst(req) : cacheFirst(req));
});
