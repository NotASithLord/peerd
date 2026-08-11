// @ts-check
// DESIGN-19 — the capture DIGESTER: raw network capture → a redacted endpoint
// inventory the actor turns into a site client. PURE (values in, values out); the
// two TAPS (CDP Network on preview, the chrome.scripting fetch/XHR wrap on every
// channel) both normalize to the CaptureEvent shape below and feed THIS.
//
// REDACTION IS FIRST-CLASS. A raw recording carries live Cookie / Authorization /
// Set-Cookie / CSRF headers and token-shaped query/body values. Those are stripped
// at the tap boundary AND here (defense in depth) — credentials never enter model
// context, the digest, or the store. The client never needs one: the egress
// boundary supplies the session same-origin. This is the inbound twin of
// fetch_url's SESSION_HEADERS strip.
//
// Response bodies contribute a SHAPE SKETCH (keys + types), never verbatim
// payloads. A digest is structure, not data.

// Headers that would carry a credential — dropped from every captured request AND
// response before anything is summarized. Case-insensitive.
const CREDENTIAL_HEADERS = new Set([
  'cookie', 'set-cookie', 'authorization', 'proxy-authorization',
  'x-csrf-token', 'x-xsrf-token', 'x-api-key', 'api-key',
]);

// Query/body param NAMES whose VALUES are redacted to a sentinel (a token/secret
// riding a param, not a header). The name is kept (it's part of the API shape);
// only the value is dropped.
const SECRET_PARAM_RE = /(token|secret|password|passwd|api[-_]?key|auth|session|csrf|xsrf|bearer|access[-_]?token|refresh[-_]?token|sig|signature|\bs?sid\b)/i;

// A value that LOOKS like a credential regardless of its param name — a long
// high-entropy-ish opaque string. Redacted defensively.
const SECRETISH_VALUE_RE = /^[A-Za-z0-9_\-.]{24,}$/;

const REDACTED = '<redacted>';

/**
 * One normalized capture event, emitted by both taps. Only caller-approved
 * exact origins should reach here; cross-origin analytics noise is filtered by
 * the caller before digesting (originFilter below helps).
 *
 * @typedef {Object} CaptureEvent
 * @property {string} method    HTTP method (upper-cased by the digester)
 * @property {string} url       absolute request URL
 * @property {number} [status]  response status
 * @property {string} [contentType]  response content-type
 * @property {Record<string, string>} [reqHeaders]   request headers (pre-redaction ok; re-redacted here)
 * @property {unknown} [reqBody]  request body (object or string; shape-sketched, never stored verbatim)
 * @property {unknown} [resSample]  a SMALL response sample (object or string) for shape sketching
 */

/**
 * Strip credential headers from a header map (case-insensitive). Pure — returns a
 * new object; a non-object yields {}.
 * @param {Record<string, unknown> | undefined} headers
 * @returns {Record<string, string>}
 */
export const redactHeaders = (headers) => {
  /** @type {Record<string, string>} */
  const out = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    if (CREDENTIAL_HEADERS.has(k.toLowerCase())) continue;
    if (typeof v === 'string') out[k] = v;
  }
  return out;
};

/**
 * Redact a single param value by name+value heuristics. Pure.
 * @param {string} name @param {string} value @returns {string}
 */
export const redactParamValue = (name, value) => {
  if (SECRET_PARAM_RE.test(name)) return REDACTED;
  if (typeof value === 'string' && SECRETISH_VALUE_RE.test(value)) return REDACTED;
  return value;
};

/**
 * Reduce a URL to a PATH TEMPLATE: numeric / uuid / long-opaque path segments
 * become `:id`, so `/v1/charges/ch_1a2b3c` and `/v1/charges/ch_9z8y` collapse to
 * one endpoint `/v1/charges/:id`. Query keys are kept (the API's shape) with
 * secret-ish values redacted. Pure — no network, no throw (a bad URL → the raw
 * string).
 * @param {string} url @returns {{ path: string, query: Record<string, string> }}
 */
export const templatizeUrl = (url) => {
  let u;
  try { u = new URL(url); } catch { return { path: typeof url === 'string' ? url.slice(0, 200) : '', query: {} }; }
  const segs = u.pathname.split('/').map((s) => {
    if (!s) return s;
    if (/^\d+$/.test(s)) return ':id';                                   // numeric id
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return ':id'; // uuid
    if (/[0-9]/.test(s) && /^[A-Za-z0-9_\-]{12,}$/.test(s)) return ':id'; // opaque token-ish id
    return s;
  });
  /** @type {Record<string, string>} */
  const query = {};
  for (const [k, v] of u.searchParams.entries()) query[k] = redactParamValue(k, v);
  return { path: segs.join('/') || '/', query };
};

/**
 * Sketch the SHAPE of a JSON-ish value: keys + value types, sampled and depth-
 * capped, secret-ish leaf values redacted. Never returns verbatim payloads. Pure.
 * @param {unknown} v @param {number} [depth]
 * @returns {unknown}
 */
export const shapeSketch = (v, depth = 0) => {
  if (v == null) return v === null ? 'null' : 'undefined';
  const t = typeof v;
  if (t === 'string') return 'string';
  if (t === 'number' || t === 'boolean') return t;
  if (t !== 'object') return t;
  if (depth > 3) return '…';
  if (Array.isArray(v)) return v.length ? [shapeSketch(v[0], depth + 1), `…×${v.length}`] : [];
  /** @type {Record<string, unknown>} */
  const out = {};
  let n = 0;
  for (const [k, val] of Object.entries(/** @type {object} */ (v))) {
    if (n++ >= 24) { out['…'] = 1; break; }
    out[k] = SECRET_PARAM_RE.test(k) ? REDACTED : shapeSketch(val, depth + 1);
  }
  return out;
};

/**
 * Should this event be kept, given the exact origin(s) we're deriving for?
 * Third-party/analytics noise is dropped. A caller that deliberately derives
 * several separately-attributed clients may pass several origins; site_capture
 * uses this to keep an owned tab and its observed API sibling in distinct groups.
 * @param {CaptureEvent} ev @param {{ origins: string[] }} opts
 * @returns {boolean}
 */
export const inScope = (ev, { origins }) => {
  let host;
  try { host = new URL(ev.url).origin; } catch { return false; }
  return origins.includes(host);
};

/**
 * Digest a batch of capture events into a draft dossier: a deduped, redacted
 * endpoint inventory + an inferred auth posture. The OUTPUT feeds validateDossier
 * (core.js) and then the actor, which writes the client module from it. Pure.
 *
 * Auth posture is INFERRED, never a value: an Authorization: Bearer header →
 * 'bearer'; a Cookie present on requests → 'session'; neither → 'none'; nothing
 * observed → 'unknown'.
 *
 * @param {CaptureEvent[]} events
 * @param {{ origins: string[], deriver?: 'capture-cdp'|'capture-tap' }} opts
 * @returns {{ endpoints: import('./core.js').SiteEndpoint[], auth: 'session'|'bearer'|'none'|'unknown', deriver: 'capture-cdp'|'capture-tap', sampled: number, dropped: number, originDigests: Array<{ origin: string, endpoints: import('./core.js').SiteEndpoint[], auth: 'session'|'bearer'|'none'|'unknown', sampled: number }> }}
 */
export const digestCapture = (events, { origins, deriver = 'capture-tap' }) => {
  const list = Array.isArray(events) ? events : [];
  /** @typedef {{ byKey: Map<string, import('./core.js').SiteEndpoint & { statuses: Set<number> }>, sawBearer: boolean, sawCookie: boolean, observed: boolean }} DigestBucket */
  /** @returns {DigestBucket} */
  const makeBucket = () => ({ byKey: new Map(), sawBearer: false, sawCookie: false, observed: false });
  const aggregate = makeBucket();
  /** @type {Map<string, DigestBucket>} */
  const byOrigin = new Map();
  let dropped = 0;

  for (const ev of list) {
    if (!ev || typeof ev.url !== 'string' || typeof ev.method !== 'string') { dropped++; continue; }
    if (!inScope(ev, { origins })) { dropped++; continue; }
    let eventOrigin = '';
    try { eventOrigin = new URL(ev.url).origin; } catch { dropped++; continue; }
    const method = ev.method.toUpperCase();
    const { path, query } = templatizeUrl(ev.url);
    const originBucket = byOrigin.get(eventOrigin) ?? makeBucket();
    byOrigin.set(eventOrigin, originBucket);
    for (const bucket of [aggregate, originBucket]) {
      bucket.observed = true;
      // Auth posture from pre-redaction header NAMES. Values never survive.
      for (const [k, v] of Object.entries(ev.reqHeaders ?? {})) {
        const kl = k.toLowerCase();
        if (kl === 'authorization' && /bearer/i.test(String(v))) bucket.sawBearer = true;
        if (kl === 'cookie') bucket.sawCookie = true;
      }
      const key = `${method} ${path}`;
      const entry = bucket.byKey.get(key) ?? { method, path, statuses: new Set() };
      if (typeof ev.status === 'number') entry.statuses.add(ev.status);
      const qKeys = Object.keys(query);
      const bits = [];
      if (qKeys.length) bits.push(`query: ${qKeys.slice(0, 8).join(', ')}`);
      if (ev.resSample !== undefined) {
        try { bits.push(`→ ${JSON.stringify(shapeSketch(ev.resSample)).slice(0, 120)}`); } catch { /* skip */ }
      }
      if (bits.length && !entry.note) entry.note = bits.join('; ').slice(0, 200);
      bucket.byKey.set(key, entry);
    }
    if (aggregate.byKey.size >= 200) break;   // hard bound before the MAX_ENDPOINTS cap in core
  }

  /** @param {DigestBucket} bucket */
  const endpointsFor = (bucket) => [...bucket.byKey.values()]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.method < b.method ? -1 : 1))
    .map(({ method, path, note }) => /** @type {import('./core.js').SiteEndpoint} */ ({ method, path, ...(note ? { note } : {}) }));
  /** @param {DigestBucket} bucket @returns {'session'|'bearer'|'none'|'unknown'} */
  const authFor = (bucket) => bucket.sawBearer
    ? 'bearer'
    : bucket.sawCookie
      ? 'session'
      : bucket.observed ? 'none' : 'unknown';

  const endpoints = endpointsFor(aggregate);
  const auth = authFor(aggregate);
  const originDigests = [...byOrigin.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([origin, bucket]) => ({
      origin, endpoints: endpointsFor(bucket), auth: authFor(bucket), sampled: bucket.byKey.size,
    }));
  return { endpoints, auth, deriver, sampled: aggregate.byKey.size, dropped, originDigests };
};
