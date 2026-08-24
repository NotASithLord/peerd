// @ts-check
// Small, dependency-free helpers used across contexts.
//
// Each helper here should be a pure function with no side effects, suitable
// for use in the SW, side panel, offscreen, and content scripts alike.

/**
 * Concatenate two Uint8Arrays into a new buffer. Used for assembling
 * iv || ciphertext blobs in the crypto layer.
 *
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {Uint8Array}
 */
export const concat = (a, b) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
};

export { bytesToBase64, base64ToBytes, uuidv7 } from './cold-util.js';

/**
 * Escape a value for safe inclusion as an XML/HTML attribute. Used by
 * `wrapUntrusted` (§4.3) to prevent web-page text from breaking out of
 * the attribute it's embedded in.
 *
 * We escape the five XML predefined entities plus the high-bit chars
 * that could trip on some parsers. Backticks are also escaped because
 * the model may interpret them as code-block boundaries.
 *
 * @param {string} s
 * @returns {string}
 */
export const escapeAttr = (s) => String(s)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')
  .replace(/`/g, '&#96;');

/**
 * Display-only removal of the untrusted-content fence WRAPPER tags, keeping the
 * inner body. The mirror of wrapUntrusted (peerd-runtime/tools/prompt-wrap.js):
 * the MODEL receives the fenced text (its "treat as data" boundary), but the
 * human should never see the literal <untrusted_*> delimiters in a rendered
 * tool-result card. PURE + render-only — returns a new string, never mutates
 * stored content, and is NEVER fed back to the model (the persisted tool_result
 * keeps its fence so the model stays injection-aware every turn). Non-string in
 * → '' out.
 *
 * Removes the untrusted_web_content wrapper tag (open + close), tolerant of
 * internal whitespace + case, plus the single padding newline the wrapper
 * inserts on each side. Leaves the BODY untouched — including any defanged
 * `&lt;…` variants (neutralizeFence output, which must stay visible as evidence
 * an injection was attempted) and any other angle brackets the user wants to
 * read. Open and close are stripped INDEPENDENTLY so a truncated body (one
 * delimiter severed by redact) still renders cleanly.
 *
 * @param {unknown} text
 * @returns {string}
 */
export const stripUntrustedFences = (text) => {
  if (typeof text !== 'string') return '';
  const TAGS = 'untrusted_web_content';
  // why [^>]* not .*: attribute VALUES are escapeAttr'd by the producer (`>` →
  // `&gt;`), so a real wrapper open tag has exactly one unescaped `>` — its own.
  // This is correct AND avoids catastrophic backtracking. The `\n?` absorbs the
  // single newline the wrapper pads with, no more (legit blank lines survive).
  const OPEN = new RegExp(`<\\s*(?:${TAGS})\\b[^>]*>\\n?`, 'gi');
  const CLOSE = new RegExp(`\\n?<\\s*/\\s*(?:${TAGS})\\s*>`, 'gi');
  return text.replace(OPEN, '').replace(CLOSE, '');
};

/**
 * Deep-freeze a value. Useful for compile-time-immutable config tables
 * like the egress allowlist. Mutates the input (per Object.freeze
 * semantics) but returns it for chaining.
 *
 * Skips ArrayBuffer / typed arrays — they can't be frozen but their
 * contents are protected by storing them in a frozen parent.
 *
 * @template T
 * @param {T} x
 * @returns {T}
 */
export const deepFreeze = (x) => {
  if (x === null || typeof x !== 'object' || ArrayBuffer.isView(x)) return x;
  for (const v of Object.values(x)) deepFreeze(v);
  return Object.freeze(x);
};

/**
 * Sleep for `ms` milliseconds. Used sparingly — most async waits should
 * be event-driven. Mostly here for backoff loops in the SW keepalive.
 *
 * @param {number} ms
 */
export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Clamp `n` into the inclusive range `[lo, hi]`. Used to bound
 * caller-supplied timeouts to sane floors/ceilings.
 *
 * @param {number} n
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
export const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

/**
 * SHA-256 of a UTF-8 string, hex-encoded. Used by the snapshot store to
 * content-address file blobs so identical bodies dedup to one row.
 *
 * Uses Web Crypto's subtle.digest, which is present in the SW, workers,
 * and Bun's test runtime alike — no polyfill needed. Async because
 * subtle.digest returns a promise.
 *
 * @param {string} text
 * @returns {Promise<string>} 64-char lowercase hex
 */
export const sha256Hex = async (text) => {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < view.length; i++) hex += view[i].toString(16).padStart(2, '0');
  return hex;
};
