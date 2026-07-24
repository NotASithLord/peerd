// @ts-check
// Deterministic schema validation for an untrusted actor's reply (#241).
//
// why this exists: the web actor runs in its own keyless heap and INGESTS
// untrusted page content, then its reply crosses back to the orchestrator.
// Today that reply is a FREE-FORM assistant string wrapped in wrapUntrusted
// tags — a MEMORY boundary (the heap split) plus a PROMPT boundary (the fence).
// But a prompt fence is a SOFT boundary: a strong enough indirect injection
// that hijacks the web actor could have it emit a natural-language payload
// crafted to "double-escape" — text that looks like it CLOSED the untrusted
// fence and began trusted orchestrator content.
//
// This module makes the boundary STRUCTURAL. The actor's reply must be a strict
// JSON envelope; deterministic code (no model) validates it before the
// orchestrator sees anything. Prose, extra keys, or malformed output fail
// validation and are DROPPED — replaced by a fixed, content-free notice that
// never echoes the rejected bytes. The orchestrator only ever receives typed,
// validated fields, re-rendered by US (renderValidatedReply) and re-fenced by
// the caller — so the actor never controls the literal bytes adjacent to the
// fence markers. The actor cannot speak to the orchestrator outside the schema.
//
// Pure — no IO, no model. The SW-side seam (actor/actor-messaging.js `settle`)
// calls validateActorReply on the raw actor text and, on success, renders only
// the validated value through the existing wrapUntrusted path.

/** @typedef {'complete' | 'partial' | 'failed'} ReplyStatus */
/**
 * @typedef {Object} ValidatedReply
 * @property {ReplyStatus} status    did the actor finish the goal, partly, or fail?
 * @property {string} summary        the human-facing substance — data, confined to a field
 * @property {string} [actionTaken]  what mutation the actor performed, if any (short)
 * @property {unknown} [data]        optional structured extraction (a plain JSON value)
 */

const STATUSES = new Set(['complete', 'partial', 'failed']);
const ALLOWED_KEYS = new Set(['status', 'summary', 'actionTaken', 'data']);
// Bounds: a hijacked actor must not be able to blow the orchestrator's context
// with a huge blob, and the envelope's own shape is small. These are caps, not
// the reply budget (the caller still clamps to RESULT_CHARS upstream).
const MAX_SUMMARY = 8 * 1024;
const MAX_ACTION = 512;
const MAX_DATA_CHARS = 16 * 1024;
const MAX_DATA_DEPTH = 8;

// A JSON value with NO surprises: object / array / string / finite-number /
// boolean / null only, bounded depth, and no prototype-pollution vector. Runs
// deterministically over the parsed `data` field so a crafted `__proto__` or a
// non-plain object can never ride through as "structured extraction".
/** @param {unknown} v @param {number} depth @returns {boolean} */
const isPlainJsonValue = (v, depth = 0) => {
  if (depth > MAX_DATA_DEPTH) return false;
  if (v === null) return true;
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return true;
  if (t === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.every((x) => isPlainJsonValue(x, depth + 1));
  if (t === 'object') {
    // reject anything whose prototype isn't the plain Object (or null) — a
    // Date/Map/class instance is not safe "data" and JSON.parse never makes one
    // anyway, so this is belt-and-suspenders against a hand-built value.
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.keys(/** @type {object} */ (v)).every(
      (k) => k !== '__proto__' && isPlainJsonValue(/** @type {any} */ (v)[k], depth + 1),
    );
  }
  return false; // function, symbol, undefined, bigint — never valid JSON data
};

/**
 * Validate an untrusted actor reply against the strict envelope schema.
 *
 * STRICT by construction: the WHOLE reply must be a single JSON object. Any
 * surrounding prose makes JSON.parse throw and the reply is rejected — that is
 * the structural boundary (there is no free-text channel to the orchestrator).
 *
 * @param {string} raw the actor's final text — expected to be a pure JSON object
 * @returns {{ ok: true, value: ValidatedReply } | { ok: false, reason: string }}
 */
export const validateActorReply = (raw) => {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: 'empty reply' };
  let parsed;
  try {
    parsed = JSON.parse(raw.trim());
  } catch {
    return { ok: false, reason: 'reply is not a single JSON object' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'reply is not a JSON object' };
  }
  // Strict key set — an UNKNOWN key is a violation, not silently ignored, so a
  // hijacked actor can't smuggle a field a future orchestrator might read.
  for (const k of Object.keys(parsed)) {
    // why the reason is content-FREE (not `unexpected key: ${k}`): the key is
    // attacker-controlled bytes, and the caller audits this reason — which the
    // main agent can read back UN-fenced via inspect(audit_log). Interpolating
    // the key would reopen the very prose channel this module closes (it would
    // be the one reject reason that echoes rejected bytes). Keep every reason a
    // fixed, content-free string so the audit trail can never launder page text.
    if (!ALLOWED_KEYS.has(k)) return { ok: false, reason: 'unexpected key present' };
  }
  if (!STATUSES.has(parsed.status)) {
    return { ok: false, reason: 'status must be one of complete|partial|failed' };
  }
  if (typeof parsed.summary !== 'string') return { ok: false, reason: 'summary must be a string' };
  if (parsed.summary.length > MAX_SUMMARY) return { ok: false, reason: 'summary too long' };
  if ('actionTaken' in parsed) {
    if (typeof parsed.actionTaken !== 'string' || parsed.actionTaken.length > MAX_ACTION) {
      return { ok: false, reason: 'actionTaken must be a short string' };
    }
  }
  if ('data' in parsed) {
    if (!isPlainJsonValue(parsed.data)) return { ok: false, reason: 'data must be a plain JSON value' };
    let serialized;
    try { serialized = JSON.stringify(parsed.data); } catch { return { ok: false, reason: 'data not serializable' }; }
    if (serialized !== undefined && serialized.length > MAX_DATA_CHARS) return { ok: false, reason: 'data too large' };
  }
  // Rebuild the value from KNOWN fields only (never spread `parsed`) so nothing
  // outside the schema — even a same-named getter on a crafted object — rides
  // through. JSON.parse can't produce such a thing, but the reconstruction is
  // the invariant we want to be true by inspection.
  /** @type {ValidatedReply} */
  const value = { status: parsed.status, summary: parsed.summary };
  if ('actionTaken' in parsed) value.actionTaken = parsed.actionTaken;
  if ('data' in parsed) value.data = parsed.data;
  return { ok: true, value };
};

/**
 * Render a validated reply into the plain text the orchestrator reads. Built
 * from validated fields ONLY — the raw actor bytes never appear here. The
 * caller still wraps this in wrapUntrusted (the content is untrusted-provenance),
 * but it is now typed data laid out by US, not a free-form channel the actor
 * controls: a fence-break sequence inside `summary` sits INSIDE the region we
 * fence, and wrapUntrusted defangs nested fence tags.
 *
 * @param {ValidatedReply} value
 * @returns {string}
 */
export const renderValidatedReply = (value) => {
  const parts = [value.summary.trim()];
  if (value.actionTaken) parts.push(`\n[action taken] ${value.actionTaken}`);
  if (value.data !== undefined) parts.push(`\n[data]\n${JSON.stringify(value.data, null, 2)}`);
  return parts.join('\n');
};

// The fixed notice used when validation FAILS. Content-free by design: echoing
// the rejected bytes would reintroduce the very prose channel we are closing.
export const REPLY_VALIDATION_FAILED =
  'the actor returned a reply that did not match the required structured format, so it was dropped. Re-send the goal if you still need the answer.';
