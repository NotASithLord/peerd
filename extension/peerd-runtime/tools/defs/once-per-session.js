// @ts-check
// oncePerSession — the shared "disclose a bulky note once per session" guard.
//
// why a module-scope registry keyed by (sessionId, key): several tool RESULTS
// carry a one-time note (the JS-pitfalls correctness note, the notebook/app
// runtime notes, the dwapp bridge guide) that is pure repetition after the
// first time in a session — it re-ships every turn once it's in history. This
// factors the `pitfallsDisclosed` Set pattern so those call sites don't each
// hand-roll it: pay the tokens on the FIRST disclosure, emit a short pointer
// after. Bounded by distinct sessions in one SW lifetime (tiny); a cold SW
// start re-arms the set, so a note whose disclosure was lost to a restart is
// simply re-disclosed — fail-open toward SHOWING the note, never hiding it.

// why NUL: the registry key is `${sessionId}${SEP}${key}`; a sessionId or
// key could in principle carry any printable char, and NUL is the one byte
// neither contains, so no two distinct pairs collide. Written as the \u0000
// ESCAPE, never a raw NUL byte — a literal NUL makes git classify the whole
// file binary (undiffable, unreviewable) and shows as an invisible space in
// editors.
const SEP = '\u0000';

/** @type {Set<string>} */
const disclosed = new Set();

const priorToolResultIndex = (
  /** @type {unknown} */ messages,
  /** @type {string|undefined} */ toolName,
  /** @type {string|undefined} */ marker,
  /** @type {boolean} */ requireFullBody = false,
) => {
  if (!Array.isArray(messages) || !toolName || !marker) return -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    const results = Array.isArray(message?.toolResults) ? message.toolResults
      : Array.isArray(message?.content)
        ? message.content.filter((/** @type {any} */ block) => block?.type === 'tool_result') : [];
    for (const result of results) {
      if (result?.meta?.toolName !== toolName || typeof result?.content !== 'string'
          || !result.content.includes(marker)
          || requireFullBody && result.content.includes('already-loaded="this session"')) {
        continue;
      }
      return index;
    }
  }
  return -1;
};

/**
 * Record a (sessionId, key) disclosure. Returns true the FIRST time this pair
 * is seen in the current SW lifetime — the caller should emit the full note —
 * and false after, when a one-line pointer suffices. A falsy sessionId always
 * returns true: an unkeyed call can't be deduped, so it errs toward disclosing.
 * @param {string | null | undefined} sessionId
 * @param {string} key
 * @param {unknown} [messages]
 * @param {string} [toolName]
 * @param {string} [marker]
 * @returns {boolean}
 */
export const oncePerSession = (sessionId, key, messages, toolName, marker) => {
  if (!sessionId) return true;
  if (priorToolResultIndex(messages, toolName, marker) >= 0) return false;
  const id = `${sessionId}${SEP}${key}`;
  if (disclosed.has(id)) return false;
  disclosed.add(id);
  return true;
};

/** @type {Map<string, number>} */
const bodyLoads = new Map();

/**
 * Trim-aware once-per-session for a large injected BODY that CAN scroll out of
 * the sent context (e.g. a skill's SKILL.md). Returns true if the full body
 * should be (re)injected: the first load this session, OR a reload whose prior
 * body has been trimmed past — the rolling-summary watermark (`trimCovered`,
 * the count of leading messages folded away from the sent slice) has advanced
 * beyond the position the prior body was injected at. Otherwise false (dedup to
 * a pointer). Records this load's position only when it (re)injects, so a
 * deduped call never advances the anchor away from the body that's still live.
 *
 * why a message-count anchor: the prior body sits at index `messageCount` (the
 * count just before its own result is appended); it has left the sent slice
 * exactly once `trimCovered` has passed that index. Keying on the SENT-slice
 * watermark (not wall-clock recency) makes recovery precise — a body that's
 * still in context is deduped; one that scrolled out is re-paged.
 * @param {string | null | undefined} sessionId
 * @param {string} key                distinguishes bodies (e.g. a skill name)
 * @param {number} messageCount       session message count at this load (its position)
 * @param {number} trimCovered        leading messages folded out of the sent slice
 * @param {unknown} [messages]
 * @param {string} [toolName]
 * @param {string} [marker]
 * @returns {boolean}
 */
export const shouldInjectBody = (
  sessionId, key, messageCount, trimCovered, messages, toolName, marker,
) => {
  if (!sessionId) return true;
  const transcriptAt = priorToolResultIndex(messages, toolName, marker, true);
  if (transcriptAt >= 0) return trimCovered > transcriptAt;
  const id = `${sessionId}${SEP}${key}`;
  const priorAt = bodyLoads.get(id);
  // Still within the sent slice (watermark hasn't reached the prior load) → dedup.
  if (priorAt !== undefined && trimCovered <= priorAt) return false;
  bodyLoads.set(id, messageCount);
  return true;
};

/** Test-only: clear both registries so cases don't leak across each other. */
export const _resetOncePerSession = () => { disclosed.clear(); bodyLoads.clear(); };
