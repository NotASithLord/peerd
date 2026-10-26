// @ts-check
// Local presentation only: signatures and admission belong to discovery.
export const EXPLORE_WINDOW = 96;
/** @param {string} value @param {number} seed */
const rank = (value, seed) => {
  let hash = seed >>> 0;
  for (const char of value) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return hash;
};

// why words, not the whole query: the search asks "What do you want to do?",
// so people type a task ("split a bill"). An app matches when its text holds
// any word of 3 or more letters. A query of only shorter words matches as typed.
// why the filler list: a sentence's small words ("the", "with") are in
// almost every app's text, so they would match every app.
const FILLER = new Set(['the', 'and', 'for', 'with', 'you', 'your', 'that', 'this', 'want', 'what', 'did', 'app', 'apps',
  'can', 'how', 'who', 'are', 'from', 'some', 'need']);
/** @param {string} query @returns {string[]} */
export const searchWords = (query) => {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const long = words.filter(word => [...word].length >= 3 && !FILLER.has(word));
  return long.length ? long : words.length ? [words.join(' ')] : [];
};
/** @param {string} text @param {string[]} words */
export const matchesWords = (text, words) => {
  const haystack = text.toLowerCase();
  return !words.length || words.some(word => haystack.includes(word));
};

// why not the full did in the text: every one holds "did:key:z6Mk", so any
// query with "key" would match every app. The maker matches by the short key
// "Made by" shows, or by the whole did as the query.
/**
 * How many words of the query an app matches.
 * @param {{publisher?:string,name?:string,slug?:string,description?:string}} app
 * @param {string[]} words @param {string} whole the trimmed query, lower case
 * @param {ReadonlyMap<string,string>|undefined} names
 */
const matchCount = (app, words, whole, names) => {
  const publisher = (app.publisher ?? '').toLowerCase();
  if (publisher && whole === publisher) return words.length;
  const text = `${app.name ?? ''} ${app.slug ?? ''} ${names?.get(app.publisher ?? '') ?? ''} ${app.description ?? ''}`.toLowerCase();
  const key = publisher.slice(-8);
  return words.filter(word => text.includes(word) || (!!key && word === key)).length;
};

/**
 * One publisher per round. The seed is fixed for a visit; polling cannot
 * reshuffle existing cards. DID diversity is not Sybil resistance. With a
 * query, an app that matches more of its words comes first.
 * `names`: saved contact names by full did, so a search finds the maker
 * name a tile shows.
 * @template {{dwapp_id?:string,publisher?:string,name?:string,slug?:string,description?:string}} T
 * @param {T[]} apps @param {{query?:string, seed?:number, names?:ReadonlyMap<string,string>}} [options]
 */
export const exploreOrder = (apps, { query = '', seed = 0, names } = {}) => {
  const words = searchWords(query);
  const whole = query.trim().toLowerCase();
  /** @type {Map<string,T[]>} */ const groups = new Map();
  /** @type {Map<string,number>} */ const hits = new Map();
  const seen = new Set();
  for (const app of apps) {
    if (!app.dwapp_id || seen.has(app.dwapp_id)) continue;
    seen.add(app.dwapp_id);
    const count = matchCount(app, words, whole, names);
    if (words.length && !count) continue;
    hits.set(app.dwapp_id, count);
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
  // why a stable sort: ties keep the seeded order.
  return ordered.sort((a, b) => (hits.get(b.dwapp_id ?? '') ?? 0) - (hits.get(a.dwapp_id ?? '') ?? 0));
};

export const SURPRISE_HISTORY_LIMIT = 512;
/** @param {{dwapp_id?:string,version_id?:string,uri?:string}} app */
export const suggestionKey = (app) => JSON.stringify([app.dwapp_id, app.version_id ?? app.uri ?? null]);
/** @param {{retrieval?:{outcome:string,observedAt:number,expiresAt:number}|null}} app @param {number} now */
export const recentRetrievalMiss = (app, now) => {
  const evidence = app.retrieval;
  return evidence?.outcome === 'no-provider-found' && Number.isFinite(evidence.observedAt)
    && Number.isFinite(evidence.expiresAt) && evidence.observedAt <= now && now < evidence.expiresAt;
};
/** Candidates are already locally filtered and publisher-balanced. No network
 * availability is inferred. The caller owns the history: Discover clears
 * `seen` after a full pass.
 * @template {{dwapp_id?:string,version_id?:string,uri?:string,publisher?:string,runtimeCompatibility?:{status:string},retrieval?:{outcome:string,observedAt:number,expiresAt:number}|null}} T
 * @param {T[]} apps @param {Set<string>} seen @param {string|null} lastPublisher
 * @param {number} [now]
 * @returns {T|null}
 */
export const nextSuggestion = (apps, seen, lastPublisher, now = Date.now()) => {
  if (seen.size >= SURPRISE_HISTORY_LIMIT) return null;
  const eligible = apps.filter(app => app.dwapp_id && app.runtimeCompatibility?.status !== 'unsupported'
    && !recentRetrievalMiss(app, now) && !seen.has(suggestionKey(app)));
  return eligible.find(app => (app.publisher ?? null) !== lastPublisher) ?? eligible[0] ?? null;
};
