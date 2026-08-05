// @ts-check
// dpop/nonce — the RFC 9449 §8 server-nonce half of a DPoP proof: the pure
// decisions (is this a real nonce? does this response demand a fresh one? is
// this request even safe to send twice?) plus a bounded per-origin cache.
//
// THE SHAPE, in one exchange. A server that wants freshness rejects the first
// proof and hands back its own challenge:
//
//   →  Authorization: DPoP <token>   DPoP: <proof without nonce>
//   ←  401  WWW-Authenticate: DPoP error="use_dpop_nonce"   DPoP-Nonce: <n>
//   →  Authorization: DPoP <token>   DPoP: <proof carrying nonce=<n>>
//   ←  200
//
// Without this file the first arrow is where peerd stopped: `buildProofInput`
// could already emit the claim (dpop/proof.js), but nothing read the challenge,
// remembered it, or re-sent. Every nonce-requiring server was a permanent 401 —
// the compatibility gap named in THREAT-MODEL.md INV-15's residuals.
//
// why the whole file is pure: the retry is a security-relevant control flow —
// exactly once, same origin, same key, fresh proof — and the failure modes that
// matter (an infinite 401 loop, a nonce echoed to the wrong server, a POST body
// silently sent twice) are decisions, not IO. They belong in functions a test
// can drive directly, leaving fetch/web-fetch.js holding only the sequencing.

/** The response header carrying the server's challenge (RFC 9449 §8). */
export const DPOP_NONCE_HEADER = 'DPoP-Nonce';

/**
 * Longest nonce accepted. The RFC sets no limit; this one exists because the
 * value is echoed back inside a signed JWT we mint, so an absurd nonce is a
 * request-inflation lever for a hostile-but-owned server, not a useful input.
 */
export const MAX_NONCE_LENGTH = 512;

/**
 * Validate a candidate nonce. Returns the value UNCHANGED on success — never a
 * trimmed, normalized, or re-encoded one — because the server compares it
 * byte-for-byte against what it issued (dpop/proof.js says the same about the
 * claim). Header parsing already strips surrounding OWS before we see it.
 *
 * why a character class at all, when this comes from the origin we hold a
 * credential for: the value crosses from an HTTP header into a JSON payload we
 * SIGN. Restricting it to visible ASCII (0x21–0x7E — no spaces, no controls, no
 * newlines) means a malformed or hostile header can never smuggle structure into
 * the proof or produce a claim the server cannot possibly have issued. A real
 * nonce is an opaque token and always fits.
 *
 * @param {unknown} raw
 * @returns {string | null} the nonce verbatim, or null if it is not usable
 */
export const parseDpopNonce = (raw) => {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > MAX_NONCE_LENGTH) return null;
  for (const ch of raw) {
    const c = ch.codePointAt(0) ?? 0;
    if (c < 0x21 || c > 0x7e) return null;
  }
  return raw;
};

/**
 * Read the challenge off a response, tolerating a response-ish object.
 * why defensive: this runs on whatever the injected `webFetch` returned, and a
 * boundary that throws on a header-less stub would turn a compatibility feature
 * into an outage. No headers ⇒ no nonce ⇒ no retry.
 * @param {unknown} response
 * @returns {string | null}
 */
export const readDpopNonce = (response) => {
  try {
    const get = /** @type {any} */ (response)?.headers?.get;
    if (typeof get !== 'function') return null;
    return parseDpopNonce(get.call(/** @type {any} */ (response).headers, DPOP_NONCE_HEADER));
  } catch { return null; }
};

/**
 * Is this request safe to send a SECOND time?
 *
 * This is the guard that keeps a compatibility retry from becoming a duplicate
 * write. A one-shot stream body cannot be replayed at all — the second send
 * would carry an empty or already-consumed body, so the retry would not be the
 * same request the proof attests to. A `Request` object is the same trap: its
 * body is a stream it owns, and `fetch` may have consumed it.
 *
 * why not simply refuse to retry anything with a body: the nonce dance is most
 * common on token and write endpoints, which are POSTs. A string / JSON /
 * URLSearchParams / Blob / ArrayBuffer body re-serializes identically, so those
 * retry safely and are the overwhelmingly common case.
 *
 * NOTE this says nothing about idempotency at the application layer. The retried
 * request is only ever sent after the server REJECTED the first one with 401/400
 * and a nonce challenge, which is a "this did not happen" answer.
 *
 * @param {unknown} resource
 * @param {{ body?: unknown }} [init]
 * @returns {boolean}
 */
export const replayableRequest = (resource, init = {}) => {
  const body = init?.body;
  const isStream = (/** @type {unknown} */ b) => typeof ReadableStream !== 'undefined' && b instanceof ReadableStream;
  if (body !== undefined && body !== null) return !isStream(body);
  // No override body — a Request carries (and may already have spent) its own.
  if (typeof Request !== 'undefined' && resource instanceof Request) {
    return resource.body == null && resource.bodyUsed !== true;
  }
  return true;
};

/**
 * Statuses that can carry a nonce challenge: 401 from a resource server
 * (RFC 9449 §7.1) and 400 from an authorization-server token endpoint (§8.2).
 */
const NONCE_CHALLENGE_STATUSES = new Set([400, 401]);

/**
 * The retry decision, whole. True only when EVERY condition holds:
 *
 *  - we actually minted a proof on the first attempt (nothing to re-sign otherwise);
 *  - the server answered with a nonce-challenge status;
 *  - it handed back a well-formed nonce;
 *  - that nonce DIFFERS from the one we already sent — the loop-breaker. Retrying
 *    with the value the server just rejected cannot succeed, and a server that
 *    repeats its challenge would otherwise ping-pong forever;
 *  - the request can be sent twice without changing what it says.
 *
 * ONE shot is the contract: the caller never feeds a retried response back in.
 * why one and not "until it stops asking": each attempt spends a real request
 * against the user's credential, and a server that rejects a correctly-nonced
 * proof is failing for some other reason. Two is a fix; N is a retry storm.
 *
 * @param {{ status?: unknown }} response
 * @param {{ minted?: boolean, sentNonce?: string | null, freshNonce?: string | null,
 *           replayable?: boolean }} attempt
 * @returns {boolean}
 */
export const shouldRetryWithNonce = (response, { minted, sentNonce, freshNonce, replayable } = {}) => {
  if (!minted || !replayable) return false;
  if (!freshNonce) return false;
  if (freshNonce === sentNonce) return false;
  const status = /** @type {any} */ (response)?.status;
  return typeof status === 'number' && NONCE_CHALLENGE_STATUSES.has(status);
};

/**
 * A bounded, in-memory, per-origin store of the newest nonce each server issued.
 *
 * why in memory only, never persisted: a nonce is short-lived freshness state a
 * server can rotate on any response. Persisting it would add a stored artifact
 * to the credential surface and buy nothing but a stale value after a
 * service-worker restart — which costs exactly one extra round trip to refresh.
 *
 * why keyed by origin and bounded: the key is the canonical owned https origin
 * the boundary already resolved, so a nonce issued by one server is structurally
 * incapable of being echoed to another. The cap keeps the map from growing with
 * origins the process will never see again; eviction is oldest-first, which Map
 * gives us for free through insertion order.
 *
 * @param {{ max?: number }} [opts]
 */
export const makeNonceCache = ({ max = 32 } = {}) => {
  /** @type {Map<string, string>} */
  const byOrigin = new Map();
  return {
    /** @param {string} origin @returns {string | null} */
    get: (origin) => (typeof origin === 'string' ? byOrigin.get(origin) ?? null : null),
    /** @param {string} origin @param {unknown} nonce */
    set: (origin, nonce) => {
      const value = parseDpopNonce(nonce);
      if (!value || typeof origin !== 'string' || !origin) return;
      // Re-insert so a refreshed origin counts as most-recently-used, not oldest.
      byOrigin.delete(origin);
      byOrigin.set(origin, value);
      while (byOrigin.size > max) {
        const oldest = byOrigin.keys().next();
        if (oldest.done) break;
        byOrigin.delete(oldest.value);
      }
    },
    /** @param {string} origin */
    clear: (origin) => { byOrigin.delete(origin); },
    get size() { return byOrigin.size; },
  };
};
