// @ts-check
// why: request floods must acquire a shared slot BEFORE store lookup/base64
// encoding. Holding it through send completion bounds retained response bytes.
export class ContentServiceBusyError extends Error {
  constructor() { super('content service overloaded'); this.name = 'ContentServiceBusyError'; }
}
/** @param {{ total?: number, perLink?: number }} [limits] */
export const createContentServiceBudget = ({ total = 128, perLink = 32 } = {}) => {
  let active = 0;
  /** @type {Map<object, number>} */
  const counts = new Map();
  return {
    stats: () => ({ active, links: counts.size }),
    /** @param {object} owner @param {() => Promise<void>} work */
    async run(owner, work) {
      const count = counts.get(owner) ?? 0;
      if (active >= total || count >= perLink) throw new ContentServiceBusyError();
      active++; counts.set(owner, count + 1);
      try { await work(); }
      finally {
        active--;
        const remaining = (counts.get(owner) ?? 1) - 1;
        if (remaining) counts.set(owner, remaining); else counts.delete(owner);
      }
    },
  };
};
export const contentServiceBudget = createContentServiceBudget();
