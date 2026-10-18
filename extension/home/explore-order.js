// @ts-check
// Local presentation only: signatures and admission belong to discovery.
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
 * `names`: saved contact names by full did, so a search finds the maker
 * name a tile shows.
 * @template {{dwapp_id?:string,publisher?:string,name?:string,slug?:string,description?:string}} T
 * @param {T[]} apps @param {{query?:string, seed?:number, names?:ReadonlyMap<string,string>}} [options]
 */
export const exploreOrder = (apps, { query = '', seed = 0, names } = {}) => {
  const search = query.trim().toLowerCase();
  /** @type {Map<string,T[]>} */ const groups = new Map();
  const seen = new Set();
  for (const app of apps) {
    if (!app.dwapp_id || seen.has(app.dwapp_id)) continue;
    seen.add(app.dwapp_id);
    const text = `${app.name ?? ''} ${app.slug ?? ''} ${app.publisher ?? ''} ${names?.get(app.publisher ?? '') ?? ''} ${app.description ?? ''}`;
    if (search && !text.toLowerCase().includes(search)) continue;
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

export const SURPRISE_HISTORY_LIMIT = 512;
/** @param {{dwapp_id?:string,version_id?:string,uri?:string}} app */
export const suggestionKey = (app) => JSON.stringify([app.dwapp_id, app.version_id ?? app.uri ?? null]);
/** Candidates are already locally filtered and publisher-balanced. No network
 * availability is inferred. The caller owns the history: Discover clears
 * `seen` after a full pass.
 * @template {{dwapp_id?:string,version_id?:string,uri?:string,publisher?:string,runtimeCompatibility?:{status:string}}} T
 * @param {T[]} apps @param {Set<string>} seen @param {string|null} lastPublisher
 * @returns {T|null}
 */
export const nextSuggestion = (apps, seen, lastPublisher) => {
  if (seen.size >= SURPRISE_HISTORY_LIMIT) return null;
  const eligible = apps.filter(app => app.dwapp_id && app.runtimeCompatibility?.status !== 'unsupported'
    && !seen.has(suggestionKey(app)));
  return eligible.find(app => (app.publisher ?? null) !== lastPublisher) ?? eligible[0] ?? null;
};
