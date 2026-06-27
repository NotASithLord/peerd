// @ts-check
// Redact tool-result content before it lands in persistent message
// history (and therefore before it re-ships to the model on every
// subsequent turn).
//
// Two transforms, both targeting the rate-limit cliff observed in
// the 2026-06-05 field test:
//
//   1. data:image base64 URLs → metadata sentinel.
//      A single 1280px PNG is ~25-30k tokens of base64. The
//      `capture` tool returns this as part of its JSON content; the
//      block gets persisted and the bytes ride along on every
//      subsequent turn. The model can't read raw base64 anyway —
//      multimodal vision uses structured `image` blocks, not text.
//      Stripping is free, and it's the single biggest line item on
//      the rate-limit budget.
//
//   2. Anything over MAX_CHARS chars → head + ellipsis + tail.
//      Affects verbose `read_page` on big SPAs, `vm_boot` stdout
//      bursts, `fetch_url` bodies that pull a long page. The
//      head keeps the bit the model needs for context; the tail
//      preserves the very-end (often a status line or summary).
//
// The LIVE UI event stream is upstream of this redactor. The user
// still sees full results in the current turn — the side panel
// receives the unredacted `tool-result` event before persistence
// happens. Only the persisted block (and thus the re-send on the
// next turn) is redacted.
//
// Known V1 trade-off: scrolling back to a stripped screenshot in
// history will show the sentinel, not the image. A follow-up could
// stash bytes in a separate IDB cache keyed by tool_use_id so the
// UI can look them up; for V1 we accept "see it once when it
// happens, see the metadata afterwards" as the right cost.

const DATA_URL_RE = /data:(image\/[a-z+.-]+);base64,[A-Za-z0-9+/=]+/g;

// Default truncation threshold. Picked to bound the worst-case
// per-message cost at ~2k tokens (4 chars/token rule of thumb). Tools
// that legitimately return more than 8000 chars should already be
// paginating; this is a backstop.
const DEFAULT_MAX_CHARS = 8000;

/**
 * Apply both redactions to a tool_result content string.
 *
 * Pure. Returns the same string when nothing matches.
 *
 * @param {string} content
 * @param {Object} [opts]
 * @param {number} [opts.maxChars]   override truncation threshold
 * @returns {string}
 */
export const redactToolResult = (content, opts = {}) => {
  if (typeof content !== 'string' || content.length === 0) return content;
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;

  // 1. data:image base64 URLs → metadata sentinel.
  //    The sentinel preserves enough info for the model to reason
  //    about the image (format + byte size) without ever holding the
  //    bytes. The "visible in UI live stream" note tells anyone
  //    reading the transcript later where the image went.
  let out = content.replace(DATA_URL_RE, (match, format) => {
    // base64 → bytes: every 4 chars decode to 3 bytes (modulo padding).
    const approxBytes = Math.floor((match.length * 3) / 4);
    return `<image:${format};${approxBytes}B stripped — visible in UI live stream>`;
  });

  // 2. Truncate if still oversized. Head ≈ 3/4, tail ≈ 1/4 — heads
  //    usually carry more context than tails for browser-tool results
  //    (the agent has already declared what it was looking for at the
  //    top of read_page output, the tail often just trails off with
  //    boilerplate).
  if (out.length > maxChars) {
    const headLen = Math.floor(maxChars * 0.75);
    const tailLen = Math.floor(maxChars * 0.25);
    const head = out.slice(0, headLen);
    const tail = out.slice(out.length - tailLen);
    const elided = out.length - headLen - tailLen;
    out = `${head}\n\n<… ${elided} chars elided …>\n\n${tail}`;
  }
  return out;
};
