// @ts-check
// Reference-count ownership for content-addressed bytes served by one host.

export const createContentOwnership = () => {
  /** @type {Map<string, Set<string>>} */
  const hashesByOwner = new Map();
  /** @type {Map<string, Set<string>>} */
  const ownersByHash = new Map();

  /** @param {string} ownerId @param {string} hash */
  const acquire = (ownerId, hash) => {
    if (!hashesByOwner.has(ownerId)) hashesByOwner.set(ownerId, new Set());
    const hashes = /** @type {Set<string>} */ (hashesByOwner.get(ownerId));
    if (hashes.has(hash)) return false;
    hashes.add(hash);
    if (!ownersByHash.has(hash)) ownersByHash.set(hash, new Set());
    ownersByHash.get(hash)?.add(ownerId);
    return true;
  };

  /**
   * @param {string} ownerId
   * @param {string} hash
   * @returns {{ released: boolean, lastOwner: boolean }}
   */
  const release = (ownerId, hash) => {
    const hashes = hashesByOwner.get(ownerId);
    if (!hashes?.delete(hash)) return { released: false, lastOwner: false };
    if (hashes.size === 0) hashesByOwner.delete(ownerId);
    const owners = ownersByHash.get(hash);
    owners?.delete(ownerId);
    const lastOwner = owners?.size === 0;
    if (lastOwner) ownersByHash.delete(hash);
    return { released: true, lastOwner };
  };

  /** @param {string} fromOwner @param {string} toOwner @param {string} hash */
  const transfer = (fromOwner, toOwner, hash) => {
    const held = hashesByOwner.get(fromOwner)?.has(hash) ?? false;
    if (!held) return false;
    acquire(toOwner, hash);
    release(fromOwner, hash);
    return true;
  };

  return Object.freeze({
    acquire,
    release,
    transfer,
    hashesFor: (/** @type {string} */ ownerId) => [...(hashesByOwner.get(ownerId) ?? [])],
    clear: () => { hashesByOwner.clear(); ownersByHash.clear(); },
  });
};
