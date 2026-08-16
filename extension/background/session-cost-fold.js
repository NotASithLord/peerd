// @ts-check

/**
 * Serialize per-session usage folds so concurrent model sub-calls cannot read
 * the same tally and overwrite one another. Persistence failures remain
 * best-effort and never fail the model call that already incurred the usage.
 *
 * @param {{
 *   sessions: { get: (id: string) => Promise<any>, setCost: (id: string, cost: any) => Promise<any> },
 *   addUsage: (current: any, usage: any, cost: number) => any,
 *   normalizeTally: (value: any) => any,
 * }} deps
 */
export const makeSessionCostFolder = ({ sessions, addUsage, normalizeTally }) => {
  /** @type {Map<string, Promise<void>>} */
  const tails = new Map();

  return (/** @type {string} */ sessionId, /** @type {any} */ usage, /** @type {number} */ cost) => {
    const tail = (tails.get(sessionId) ?? Promise.resolve())
      .then(async () => {
        const fresh = await sessions.get(sessionId);
        await sessions.setCost(sessionId, addUsage(normalizeTally(fresh?.cost), usage, cost));
      })
      .catch(() => { /* a persist hiccup must not fail the call */ });
    tails.set(sessionId, tail);
    tail.then(() => { if (tails.get(sessionId) === tail) tails.delete(sessionId); });
    return tail;
  };
};
