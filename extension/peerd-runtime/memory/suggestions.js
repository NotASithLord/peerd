// @ts-check
// Pending memory suggestions — the holding pen between auto-memory
// extraction and the user's approve/dismiss in Context → Memory.
//
// Deliberately NOT a memory doc: suggestions are unapproved candidates
// and must never ride the always-loaded prompt block or the
// export/import surface the way real memory does. They live under one
// kv key (chrome.storage.local via the injected egress wrapper) as a
// small capped list — approving or dismissing simply removes the entry
// (approval writes the note into the user doc through the memory
// store; this store never touches docs).
//
// IO is injected (kv) per the functional-core/imperative-shell rule;
// bun tests pass a Map-backed fake.

import { MAX_PENDING_SUGGESTIONS } from './auto-memory.js';

export const SUGGESTIONS_KEY = 'memory_suggestions.v1';

/**
 * @typedef {Object} MemorySuggestion
 * @property {string} id
 * @property {string} text          the proposed durable note
 * @property {string|null} sessionId     source session
 * @property {string|null} sessionTitle  source session title (display only)
 * @property {number} createdAt     epoch ms
 */

/** @param {unknown} s */
const collapse = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * @param {unknown} s
 * @returns {s is MemorySuggestion}
 */
const isValid = (s) => {
  if (!s || typeof s !== 'object') return false;
  const o = /** @type {Record<string, unknown>} */ (s);
  return typeof o.id === 'string' && o.id.length > 0
    && typeof o.text === 'string' && o.text.trim().length > 0;
};

/**
 * @param {Object} deps
 * @param {{ get: (key: string) => Promise<any>, set: (key: string, value: any) => Promise<void> }} deps.kv
 * @param {() => number} [deps.now]
 * @param {() => string} [deps.makeId]
 */
export const createSuggestionStore = ({ kv, now = Date.now, makeId }) => {
  if (!kv || typeof kv.get !== 'function') {
    throw new TypeError('createSuggestionStore: kv adapter is required');
  }
  const generateId = makeId
    ?? (() => `sug-${now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);

  /** @returns {Promise<MemorySuggestion[]>} */
  const read = async () => {
    const stored = await kv.get(SUGGESTIONS_KEY);
    return Array.isArray(stored?.pending) ? stored.pending.filter(isValid) : [];
  };
  /** @param {MemorySuggestion[]} pending */
  const write = (pending) => kv.set(SUGGESTIONS_KEY, { pending });

  /** All pending suggestions, oldest first. */
  const listPending = read;

  /** Pending count — the Memory tab badge. */
  const count = async () => (await read()).length;

  /**
   * Add candidate notes from one extraction. Dedupes against what's
   * already pending (collapsed text) and prunes oldest past the cap —
   * a pile of stale unreviewed suggestions is noise, not memory.
   *
   * @param {string[]} notes
   * @param {{ sessionId?: string|null, sessionTitle?: string|null }} [meta]
   * @returns {Promise<{ added: number, total: number }>}
   */
  const addMany = async (notes, meta = {}) => {
    const pending = await read();
    const have = new Set(pending.map((s) => collapse(s.text)));
    let added = 0;
    for (const text of Array.isArray(notes) ? notes : []) {
      const key = collapse(text);
      if (!key || have.has(key)) continue;
      have.add(key);
      pending.push({
        id: generateId(),
        text: String(text).trim(),
        sessionId: meta.sessionId ?? null,
        sessionTitle: meta.sessionTitle ?? null,
        createdAt: now(),
      });
      added++;
    }
    while (pending.length > MAX_PENDING_SUGGESTIONS) pending.shift();
    if (added > 0) await write(pending);
    return { added, total: pending.length };
  };

  /** @param {string} id @returns {Promise<MemorySuggestion | null>} */
  const get = async (id) => (await read()).find((s) => s.id === id) ?? null;

  /**
   * Remove a suggestion (after approve OR dismiss — resolved either
   * way; the approval write itself happens in the memory store).
   *
   * @param {string} id
   * @returns {Promise<{ ok: boolean, suggestion?: MemorySuggestion, error?: string }>}
   */
  const resolve = async (id) => {
    const pending = await read();
    const idx = pending.findIndex((s) => s.id === id);
    if (idx < 0) return { ok: false, error: 'not-found' };
    const [suggestion] = pending.splice(idx, 1);
    await write(pending);
    return { ok: true, suggestion };
  };

  /** Drop everything — reversibility's nuclear option for this surface. */
  const clear = () => write([]);

  return { listPending, count, addMany, get, resolve, clear };
};
