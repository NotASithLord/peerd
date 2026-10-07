// @ts-check
// Local presentation only: signatures and admission belong to discovery.
export const EXPLORE_PAGE = 24;
export const EXPLORE_WINDOW = 96;
/** @param {string} value @param {number} seed */
const rank = (value, seed) => {
  let hash = seed >>> 0;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return hash;
};

/**
 * One publisher per round. A seed changes only on explicit Shuffle; polling
 * cannot reshuffle existing cards. DID diversity is not Sybil resistance.
 * @template {{dwapp_id?:string,publisher?:string,name?:string,slug?:string,description?:string,includes_wasm?:boolean|null}} T
 * @param {T[]} apps @param {{query?:string, wasm?:string, seed?:number}} [options]
 */
export const exploreOrder = (apps, { query = '', wasm = 'all', seed = 0 } = {}) => {
  const search = query.trim().toLowerCase();
  /** @type {Map<string,T[]>} */ const groups = new Map();
  const seen = new Set();
  for (const app of apps) {
    if (!app.dwapp_id || seen.has(app.dwapp_id)) continue;
    seen.add(app.dwapp_id);
    if (wasm === 'yes' && app.includes_wasm !== true) continue;
    if (wasm === 'no' && app.includes_wasm !== false) continue;
    if (wasm === 'unknown' && typeof app.includes_wasm === 'boolean') continue;
    if (search && !`${app.name ?? ''} ${app.slug ?? ''} ${app.publisher ?? ''} ${app.description ?? ''}`.toLowerCase().includes(search)) continue;
    const publisher = app.publisher || 'unspecified';
    const group = groups.get(publisher) ?? [];
    group.push(app); groups.set(publisher, group);
  }
  /** @param {string} a @param {string} b */
  const compare = (a, b) => rank(a, seed) - rank(b, seed) || a.localeCompare(b);
  let publishers = [...groups.keys()].sort(compare);
  for (const group of groups.values()) group.sort((a, b) => compare(a.dwapp_id ?? '', b.dwapp_id ?? ''));
  /** @type {T[]} */ const ordered = [];
  for (let round = 0; publishers.length; round++) {
    /** @type {string[]} */ const next = [];
    for (const publisher of publishers) {
      const app = groups.get(publisher)?.[round];
      if (app) ordered.push(app);
      if ((groups.get(publisher)?.length ?? 0) > round + 1) next.push(publisher);
    }
    publishers = next;
  }
  return ordered;
};
