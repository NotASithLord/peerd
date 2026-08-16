// @ts-check
/// <reference lib="webworker" />
// sw.js: app-shell service worker for the peerd web demo.
//
// The cache name and precache list are STAMPED AT PACKAGE TIME by
// packaging/package-web.ts (the __PEERD_WEB_*__ tokens below): every build
// gets its own shell cache, so a deploy atomically invalidates ALL staged
// module files. why: the staged tree (/peerd-*/**, /shared/**) is rebuilt
// fresh from extension source each deploy. A hand-bumped cache name (the old
// prototype pattern) left returning visitors running STALE staged source,
// silently defeating the target's inherits-upstream premise.
//
// BUILD ATOMICITY: navigations AND modules are both served cache-first from
// THIS build's cache, so one page load never mixes two builds (network-first
// HTML over cache-first modules would serve a new page against old modules in
// the deploy window). Freshness comes from the SW update cycle instead: a new
// deploy byte-changes sw.js → the new SW installs, precaches its own build,
// claims, and the page reloads ONCE on controllerchange (index.html).
//
// /vendor/ lives in its own long-lived cache: it is multi-MB, changes rarely,
// and re-downloading the model runtime on every deploy would punish visitors.
//
// Served UNBUILT (straight from this template directory), the tokens are left literal and
// the fetch handler intercepts NOTHING: pure pass-through, so a dev serve is
// always network-fresh (an un-stamped cache-first SW would freeze dev on
// first-visit bytes forever).
//
// Bypasses stay as before: non-GET, non-http(s) (blob:/ws:/wss:/data:),
// cross-origin (the wss peer, Google Fonts, HF weights), range requests. OPFS
// is not HTTP, so the sealed-worker notebook is never intercepted.
// why the cast: tsconfig's lib is DOM (this is one service worker in a
// window-typed tree), so the global `self` resolves to Window. The reference
// directive above brings the worker types in for this file; this names which
// one `self` actually is at runtime.
const worker = /** @type {ServiceWorkerGlobalScope} */ (/** @type {unknown} */ (self));

const BUILD = '__PEERD_WEB_BUILD__';
const UNBUILT = BUILD.startsWith('__');
/** @type {string[]} */
let PRECACHE = [];
try { PRECACHE = JSON.parse('__PEERD_WEB_PRECACHE__'); } catch { /* unbuilt tree */ }

const CACHE_SHELL = `peerd-web-${BUILD}`;
const CACHE_VENDOR = 'peerd-web-vendor-v1';

worker.addEventListener('install', (e) => {
  // allSettled: a single 404 must not wedge installation of the new build.
  e.waitUntil(
    caches.open(CACHE_SHELL)
      .then((c) => Promise.allSettled(PRECACHE.map((u) => c.add(u))))
      .then(() => worker.skipWaiting())
  );
});

worker.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_SHELL && k !== CACHE_VENDOR).map((k) => caches.delete(k))
      ))
      .then(() => worker.clients.claim())
  );
});

// why !redirected: a redirected response (e.g. /index.html → /) stored in the
// cache is rejected by respondWith for navigation requests; cache only the
// canonical 200s.
/** @param {string} cacheName @param {RequestInfo} req @param {Response} res */
const putCache = (cacheName, req, res) => {
  if (res.ok && !res.redirected && res.type === 'basic') {
    const copy = res.clone();
    caches.open(cacheName).then((c) => c.put(req, copy));
  }
  return res;
};

// scoped to the NAMED cache (not CacheStorage-wide caches.match): during an
// update window an old SW must never answer from a newer build's cache or
// vice versa. The cache name IS the build boundary.
/** @param {string} cacheName @param {Request} req */
const cacheFirst = (cacheName, req) =>
  caches.open(cacheName)
    .then((c) => c.match(req))
    .then((hit) => hit || fetch(req).then((res) => putCache(cacheName, req, res)));

worker.addEventListener('fetch', (e) => {
  // unbuilt dev tree: never intercept; plain network for everything.
  if (UNBUILT) return;

  const req = e.request;
  const url = new URL(req.url);

  // bypass: non-GET, non-http(s) (blob:/ws:/wss:/data:), cross-origin, ranges.
  if (req.method !== 'GET') return;
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
  if (url.origin !== worker.location.origin) return;
  if (req.headers.has('range')) return;

  // navigations: THIS build's precached document ('/', the canonical copy;
  // '/index.html' is a redirect on static hosts and is never cached), network
  // as first-visit/miss fallback. Freshness = the update cycle, not racing
  // the network per load.
  if (req.mode === 'navigate') {
    e.respondWith(
      caches.open(CACHE_SHELL)
        .then((c) => c.match('/'))
        .then((hit) => hit || fetch(req).then((res) => putCache(CACHE_SHELL, req, res)))
    );
    return;
  }

  // build.json is the freshness probe; never serve it stale.
  // why the ?? Response.error(): a cache MISS here resolves undefined, and
  // respondWith(undefined) throws inside the fetch handler rather than failing
  // the request. Offline with nothing cached should surface as the network
  // error it already was without this worker in the path.
  if (url.pathname === '/build.json') {
    e.respondWith(fetch(req).catch(() => caches.open(CACHE_SHELL)
      .then((c) => c.match(req))
      .then((hit) => hit ?? Response.error())));
    return;
  }

  // vendor: long-lived cache (rarely changes, tens of MB).
  if (url.pathname.startsWith('/vendor/')) {
    e.respondWith(cacheFirst(CACHE_VENDOR, req));
    return;
  }

  // everything else same-origin (shell + staged modules): cache-first against
  // THIS build's cache, immutable per deploy and invalidated by the next one.
  e.respondWith(cacheFirst(CACHE_SHELL, req));
});
