// sw.js — app-shell service worker for the peerd web demo.
//
// The cache name and precache list are STAMPED AT PACKAGE TIME by
// packaging/package-web.ts (the __PEERD_WEB_*__ tokens below): every build
// gets its own shell cache, so a deploy atomically invalidates ALL staged
// module files. why: the staged tree (/peerd-*/**, /shared/**) is rebuilt
// fresh from extension source each deploy — a hand-bumped cache name (the old
// prototype pattern) left returning visitors running STALE staged source,
// silently defeating the target's inherits-upstream premise. With a per-build
// name, cache-first on staged files is CORRECT (they are immutable per build).
//
// /vendor/ lives in its own long-lived cache: it is multi-MB, changes rarely,
// and re-downloading the model runtime on every deploy would punish visitors.
//
// Served UNBUILT (straight from web/public/), the tokens are left literal: the
// precache try/catch falls back to [] and the cache name is just odd — the SW
// degrades to a network-first-with-cache-fallback proxy, fine for dev.
//
// Bypasses stay as before: non-GET, non-http(s) (blob:/ws:/wss:/data:),
// cross-origin (the wss peer, Google Fonts, HF weights), range requests. OPFS
// is not HTTP, so the sealed-worker notebook is never intercepted.
const BUILD = '__PEERD_WEB_BUILD__';
let PRECACHE = [];
try { PRECACHE = JSON.parse('__PEERD_WEB_PRECACHE__'); } catch { /* unbuilt tree */ }

const CACHE_SHELL = `peerd-web-${BUILD}`;
const CACHE_VENDOR = 'peerd-web-vendor-v1';

self.addEventListener('install', (e) => {
  // allSettled: a single 404 must not wedge installation of the new build.
  e.waitUntil(
    caches.open(CACHE_SHELL)
      .then((c) => Promise.allSettled(PRECACHE.map((u) => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_SHELL && k !== CACHE_VENDOR).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

const putCache = (cacheName, req, res) => {
  if (res.ok && res.type === 'basic') {
    const copy = res.clone();
    caches.open(cacheName).then((c) => c.put(req, copy));
  }
  return res;
};

const cacheFirst = (cacheName, req) =>
  caches.match(req).then((hit) => hit || fetch(req).then((res) => putCache(cacheName, req, res)));

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // bypass: non-GET, non-http(s) (blob:/ws:/wss:/data:), cross-origin, ranges.
  if (req.method !== 'GET') return;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (url.origin !== self.location.origin) return;
  if (req.headers.has('range')) return;

  // navigations: network-first so a new deploy's HTML lands immediately;
  // cached shell only as the offline fallback.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => putCache(CACHE_SHELL, req, res))
        .catch(() => caches.match('/index.html').then((r) => r || caches.match('/')))
    );
    return;
  }

  // build.json is the freshness probe — never serve it stale.
  if (url.pathname === '/build.json') {
    e.respondWith(fetch(req).catch(() => caches.match(req)));
    return;
  }

  // vendor: long-lived cache (rarely changes, tens of MB).
  if (url.pathname.startsWith('/vendor/')) {
    e.respondWith(cacheFirst(CACHE_VENDOR, req));
    return;
  }

  // everything else same-origin (shell + staged modules): cache-first against
  // THIS build's cache — immutable per deploy, invalidated by the next one.
  e.respondWith(cacheFirst(CACHE_SHELL, req));
});
