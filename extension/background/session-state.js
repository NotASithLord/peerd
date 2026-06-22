// @ts-check
// background/session-state.js — the SW's per-lifetime "current active session"
// cache, behind a tiny store so the session-mutating routes can take it via
// deps instead of closing over a reassigned `let activeSession`.
//
// why a store (step 2 of the SW decomposition): activeSession was a module-level
// let written by the turn driver and by session/{setModel,switch,reset,archive}
// + permission/set. Because those routes reassigned it, they had to stay inline.
// A two-method holder lets them call .set()/.clear() through deps and move out.
//
// It is ONLY a cache (pushState rebuilds the snapshot from the session store);
// the SW keeps it coherent so a same-turn read sees the latest write. Imports
// nothing → Bun-importable.

/**
 * @typedef {{ sessionId?: string } & Record<string, any>} SessionRecord
 */
export const makeSessionState = () => {
  /** @type {SessionRecord | null} */
  let current = null;
  return {
    /** The cached active-session record, or null. */
    current: () => current,
    /**
     * Replace the cache (a fresh/updated record).
     * @param {SessionRecord | null} record
     */
    set: (record) => { current = record; },
    /** Drop the cache (new chat / archive of the active session). */
    clear: () => { current = null; },
  };
};
