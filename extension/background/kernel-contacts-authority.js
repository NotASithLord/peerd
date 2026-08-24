// @ts-check

const name = (/** @type {unknown} */ value) => typeof value === 'string'
  ? value.trim().replace(/\s+/g, ' ').slice(0, 64) || null : null;
const tags = (/** @type {unknown} */ value) => {
  if (!Array.isArray(value)) return [];
  const output = [];
  const seen = new Set();
  for (const candidate of value) {
    const tag = typeof candidate === 'string' ? candidate.trim().slice(0, 32) : '';
    if (tag && !seen.has(tag)) { seen.add(tag); output.push(tag); }
    if (output.length >= 12) break;
  }
  return output;
};

/** @param {{idb:any,now?:()=>number}} deps */
export const createKernelContactsAuthority = ({ idb, now = Date.now }) => Object.freeze({
  list: () => idb.getAll('contacts'),
  upsert: async (/** @type {string} */ did, /** @type {any} */ patch = {}) => {
    if (typeof did !== 'string' || !did.startsWith('did:key:')
        || did.length <= 12 || did.length > 256) throw new Error('contact-did-invalid');
    const prior = await idb.get('contacts', did);
    const timestamp = now();
    const next = prior ? { ...prior } : {
      did, name: null, notes: '', tags: [], favorite: false,
      createdAt: timestamp, updatedAt: timestamp,
    };
    if (!prior || Object.hasOwn(patch, 'name')) next.name = name(patch.name);
    if (!prior || Object.hasOwn(patch, 'notes')) {
      next.notes = typeof patch.notes === 'string' ? patch.notes.slice(0, 1_000) : '';
    }
    if (!prior || Object.hasOwn(patch, 'tags')) next.tags = tags(patch.tags);
    if (!prior || Object.hasOwn(patch, 'favorite')) next.favorite = !!patch.favorite;
    next.did = prior?.did ?? did;
    next.createdAt = prior?.createdAt ?? timestamp;
    next.updatedAt = timestamp;
    await idb.put('contacts', next);
    return next;
  },
  remove: async (/** @type {string} */ did) => {
    const prior = await idb.get('contacts', did);
    if (prior) await idb.del('contacts', did);
    return !!prior;
  },
});
