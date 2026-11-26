// @ts-check
// Bounded, TTL-expiring FIFO ring buffer for early abort signals arriving
// before a worker or job finishes registering. Shared by actor-runner and
// job-runner so startup-race cancellation stays uniform and memory-bounded.

const DEFAULT_MAX = 64;
const DEFAULT_TTL_MS = 60_000;

/**
 * @param {{ max?: number, ttlMs?: number, now?: () => number }} [options]
 */
export const createEarlyAbortBuffer = ({
  max = DEFAULT_MAX,
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now,
} = {}) => {
  /** @type {Map<string, { owner?: string, expiresAt: number }>} */
  const entries = new Map();

  const prune = (ts = now()) => {
    for (const [id, entry] of entries) {
      if (entry.expiresAt > ts) break;
      entries.delete(id);
    }
    while (entries.size > max) {
      const oldest = entries.keys().next().value;
      if (typeof oldest !== 'string') break;
      entries.delete(oldest);
    }
  };

  /** @param {string} id @param {string} [owner] */
  const remember = (id, owner) => {
    const ts = now();
    prune(ts);
    // Refresh a duplicate at the back of the FIFO so its expiry stays ordered.
    entries.delete(id);
    entries.set(id, { ...(owner ? { owner } : {}), expiresAt: ts + ttlMs });
    prune(ts);
  };

  /** @param {string} id @param {string} [owner] */
  const consume = (id, owner) => {
    prune();
    const entry = entries.get(id);
    if (!entry || (entry.owner && entry.owner !== owner)) return false;
    entries.delete(id);
    return true;
  };

  return Object.freeze({ remember, consume, prune, clear: () => entries.clear() });
};
