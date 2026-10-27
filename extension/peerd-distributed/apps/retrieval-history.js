// @ts-check
// Local requested retrievals only: this is neither a provider lease nor a
// statement about global availability. No timers, persistence or network IO.
export const RETRIEVAL_HISTORY_LIMIT = 256;
export const RETRIEVAL_MISS_TTL_MS = 30_000;

export class NoAppProviderError extends Error {
  /** @param {string} uri */
  constructor(uri) {
    super(`no peer is serving ${uri} right now. The peer may have dropped; try again`);
    this.name = 'NoAppProviderError';
  }
}

/** @param {{now:()=>number}} options */
export const createRetrievalHistory = ({ now }) => {
  /** @type {Map<string,{ticket:object, startedAt:number, missedAt?:number}>} */
  const entries = new Map();
  const prune = () => {
    const time = now();
    for (const [address, entry] of entries) {
      const observed = entry.missedAt ?? entry.startedAt;
      if (time < observed || time - observed >= RETRIEVAL_MISS_TTL_MS) entries.delete(address);
    }
  };
  return {
    /** @param {string} address */
    begin(address) {
      prune();
      // why: a deliberate retry removes the previous miss immediately. Unique
      // tickets fence late failures even after eviction or a policy reset.
      entries.delete(address);
      while (entries.size >= RETRIEVAL_HISTORY_LIMIT) entries.delete(entries.keys().next().value ?? '');
      const ticket = {};
      entries.set(address, { ticket, startedAt: now() });
      return ticket;
    },
    /** @param {string} address @param {object} ticket */
    miss(address, ticket) {
      prune();
      const entry = entries.get(address);
      if (entry?.ticket === ticket) entry.missedAt = now();
    },
    /** @param {string} address @param {object} ticket */
    forget(address, ticket) {
      if (entries.get(address)?.ticket === ticket) entries.delete(address);
    },
    /** @param {string} address */
    read(address) {
      prune();
      const missedAt = entries.get(address)?.missedAt;
      return missedAt === undefined ? null : { outcome: 'no-provider-found', observedAt: missedAt, expiresAt: missedAt + RETRIEVAL_MISS_TTL_MS };
    },
    clear: () => entries.clear(),
  };
};
