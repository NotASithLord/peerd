// @ts-check
// http-cache — pure caching policy for the VM's HTTP bridge.
//
// Every byte the VM fetches funnels through one host-side chokepoint
// (vm-tab.js handleHttpMarker → sw/web-fetch). That makes a cache trivial to
// add and enormously useful: a dev re-cloning the same repo or re-installing
// the same wheels/tarballs hits warm bytes instead of re-streaming them, and
// re-runs work even when offline. The store is an IDB object store keyed by a
// content-addressed key; THIS module is the pure policy (what's cacheable, how
// to key it, how to revalidate) so it can be tested without IDB.
//
// Scope on purpose: only safe, idempotent GETs are cached. Anything with a
// request body, any write method, and any response the server marks
// no-store/private is bypassed — correctness over hit-rate.

/** @typedef {{ method: string, url: string, headers?: Record<string,string>, body?: string|null }} CacheableRequest */
/** @typedef {{ status: number, headers: Record<string,string> }} CacheableResponseMeta */

// Only cache successful, range-less GETs of bounded size. (Range requests are
// CheerpX's disk-streaming concern, not ours, and never reach this bridge.)
export const MAX_CACHE_ENTRY_BYTES = 32 * 1024 * 1024;

/**
 * Is this request eligible to be served from / stored in the cache at all?
 * @param {CacheableRequest} req
 * @returns {boolean}
 */
export const isRequestCacheable = (req) => {
  if (String(req?.method ?? 'GET').toUpperCase() !== 'GET') return false;
  if (req?.body != null) return false;
  const h = lowerKeys(req?.headers ?? {});
  // A caller asking for a sub-range or already doing its own validation opts out.
  if ('range' in h || 'if-none-match' in h || 'if-modified-since' in h) return false;
  // Never cache authenticated bytes (would serve a private response to a later
  // anonymous/different caller). Covers every auth header we inject: Bearer/Basic
  // (authorization), cookies, GitLab's PRIVATE-TOKEN, and proxy auth.
  if ((h.authorization || h.cookie || h['private-token'] || h['proxy-authorization']) != null) return false;
  return true;
};

/**
 * Should we STORE this response? Honors no-store / private and the size cap.
 * @param {CacheableResponseMeta} meta
 * @param {number} byteLength
 * @returns {boolean}
 */
export const isResponseStorable = (meta, byteLength) => {
  if (!meta || meta.status !== 200) return false;
  if (byteLength > MAX_CACHE_ENTRY_BYTES) return false;
  const cc = String(lowerKeys(meta.headers ?? {})['cache-control'] ?? '').toLowerCase();
  if (cc.includes('no-store') || cc.includes('private')) return false;
  return true;
};

/**
 * Content-addressed cache key. Just the absolute URL (normalized) — GET is the
 * only cached method and we've already excluded authed/ranged variants, so the
 * URL fully identifies the bytes. Fragment is dropped; it never reaches the server.
 * @param {string} url
 * @returns {string}
 */
export const cacheKey = (url) => {
  try {
    const u = new URL(url);
    u.hash = '';
    return u.toString();
  } catch {
    return String(url);
  }
};

/**
 * The validators (ETag / Last-Modified) to replay as conditional-request
 * headers when we have a stored entry, so a revalidation can come back 304 and
 * we reuse the cached body. Returns {} when the entry carries no validator.
 * @param {CacheableResponseMeta} storedMeta
 * @returns {Record<string,string>}
 */
export const revalidationHeaders = (storedMeta) => {
  const h = lowerKeys(storedMeta?.headers ?? {});
  /** @type {Record<string,string>} */
  const out = {};
  if (h.etag) out['If-None-Match'] = h.etag;
  if (h['last-modified']) out['If-Modified-Since'] = h['last-modified'];
  return out;
};

// Clamp a server-supplied max-age so a hostile/buggy header can't mark a cached
// entry effectively immortal (Number('9'.repeat(400)) → Infinity). One year is
// well beyond any sane cache lifetime for this disposable GET-only store.
const MAX_FRESH_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Does a stored entry still count as fresh WITHOUT a network round-trip?
 * Conservative: only honors an explicit max-age. No heuristic freshness — when
 * in doubt we revalidate (cheap, since revalidation is a conditional GET that
 * usually 304s). `nowMs`/`storedAtMs` injected for testability.
 * @param {CacheableResponseMeta} storedMeta
 * @param {number} storedAtMs
 * @param {number} nowMs
 * @returns {boolean}
 */
export const isFresh = (storedMeta, storedAtMs, nowMs) => {
  const cc = String(lowerKeys(storedMeta?.headers ?? {})['cache-control'] ?? '');
  const m = /max-age=(\d+)/i.exec(cc);
  if (!m) return false;
  const maxAgeMs = Math.min(Number(m[1]) * 1000, MAX_FRESH_MS);
  return nowMs - storedAtMs < maxAgeMs;
};

/**
 * Lower-case all keys of a header object (header names are case-insensitive).
 * @param {Record<string, any>} obj
 * @returns {Record<string, any>}
 */
const lowerKeys = (obj) =>
  Object.fromEntries(Object.entries(obj).map(([k, v]) => [String(k).toLowerCase(), v]));
