// @ts-check
// background/mint-once.js — single-flight dedup for lazy actor minting.
//
// Minting an actor session is async (sessions.create + registry writes). Two
// message_actor calls that race to the SAME instance before either finishes
// would each mint a session — a duplicate actor. mintOnce collapses concurrent
// mints of one key onto a SINGLE in-flight promise; the entry clears when it
// settles, so a later mint (after the first completed) starts fresh.
//
// Keys never collide across kinds: engine ids carry a prefix and web keys are
// `web:<tabId>`. Extracted from the SW as a pure unit — a Map and a promise, no
// IO — so the single-flight invariant is Bun-testable without a live session store.

export const makeMintOnce = () => {
  /** @type {Map<string, Promise<string>>} */
  const inFlight = new Map();
  /** @param {string} key @param {() => Promise<string>} fn @returns {Promise<string>} */
  const mintOnce = (key, fn) => {
    const existing = inFlight.get(key);
    if (existing) return existing;
    const p = (async () => { try { return await fn(); } finally { inFlight.delete(key); } })();
    inFlight.set(key, p);
    return p;
  };
  return { mintOnce, _inFlightCount: () => inFlight.size };
};
