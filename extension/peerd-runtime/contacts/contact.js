// @ts-check
// Contacts — record shape + pure helpers.
//
// A contact is a USER-OWNED overlay on a peer's did:key identity: the
// network only ever gives us an opaque `did:key:z6Mk…`, and this is where the
// user pins a human name (and later notes/tags) to it. The did is the stable
// key; everything else is editable. Activity history is NOT stored here — it's
// derived at read time from durable sources (the App catalog + the audit log),
// so a contact record stays a tiny, hand-editable overlay (see aggregate.js).
//
// Pure module: shape + validation + the peerd:// did parser. IO lives in
// store.js (the functional-core / imperative-shell rule).

export const MAX_CONTACT_NAME = 64;
export const MAX_CONTACT_NOTES = 1000;
export const MAX_CONTACT_TAGS = 12;
export const MAX_TAG_LEN = 32;

/**
 * @typedef {{
 *   did: string,
 *   name: string | null,
 *   notes: string,
 *   tags: string[],
 *   favorite: boolean,
 *   createdAt: number,
 *   updatedAt: number,
 * }} ContactRecord
 */

/**
 * The editable fields a caller may set on a contact overlay. All optional —
 * untrusted input, normalized below.
 *
 * @typedef {{ name?: string | null, notes?: string, tags?: string[], favorite?: boolean }} ContactPatch
 */

// A did:key is the only thing we trust as an identity key. Cheap structural
// check — not full multibase validation (the network already verified the key
// on every signed frame; this just rejects obvious junk before we persist it).
/** @param {unknown} did @returns {boolean} */
export const isPeerDid = (did) => typeof did === 'string' && did.startsWith('did:key:') && did.length > 12 && did.length <= 256;

// Pull the publisher did out of a peerd:// content uri (`peerd://<did>/<hash>`).
// why a local parser (not the dweb module's uri.js): nothing outside the dweb
// module may import it (the dweb boundary — and the store build prunes that
// module entirely, so even naming its path here would trip the artifact
// verifier). A did:key has no '/', so the first path segment after the scheme IS
// the did. Returns null on anything malformed so callers can fall back to an
// explicit `publisher` field.
/** @param {unknown} uri @returns {string | null} */
export const peerDidFromUri = (uri) => {
  if (typeof uri !== 'string' || !uri.startsWith('peerd://')) return null;
  const did = uri.slice('peerd://'.length).split('/')[0];
  return isPeerDid(did) ? did : null;
};

/** @param {unknown} name @returns {string | null} */
export const normalizeContactName = (name) => {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim().replace(/\s+/g, ' ').slice(0, MAX_CONTACT_NAME);
  return trimmed.length ? trimmed : null;
};

/** @param {unknown} tags @returns {string[]} */
const normalizeTags = (tags) => {
  if (!Array.isArray(tags)) return [];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const t of tags) {
    if (typeof t !== 'string') continue;
    const tag = t.trim().slice(0, MAX_TAG_LEN);
    if (tag && !seen.has(tag)) { seen.add(tag); out.push(tag); }
    if (out.length >= MAX_CONTACT_TAGS) break;
  }
  return out;
};

/**
 * A fresh contact overlay for a did. `patch` carries the initial user fields.
 * @param {string} did
 * @param {ContactPatch} [patch]
 * @param {number} [now]
 * @returns {ContactRecord}
 */
export const newContactRecord = (did, patch = {}, now = Date.now()) => ({
  did,
  name: normalizeContactName(patch.name),
  notes: typeof patch.notes === 'string' ? patch.notes.slice(0, MAX_CONTACT_NOTES) : '',
  tags: normalizeTags(patch.tags),
  favorite: !!patch.favorite,
  createdAt: now,
  updatedAt: now,
});

/**
 * Apply a user patch to an existing contact, allowlisting the editable fields
 * (did/createdAt are identity — never moved). Returns a NEW record.
 * @param {ContactRecord} existing
 * @param {ContactPatch} [patch]
 * @param {number} [now]
 * @returns {ContactRecord}
 */
export const applyContactPatch = (existing, patch = {}, now = Date.now()) => {
  const next = { ...existing };
  if ('name' in patch) next.name = normalizeContactName(patch.name);
  if ('notes' in patch) next.notes = typeof patch.notes === 'string' ? patch.notes.slice(0, MAX_CONTACT_NOTES) : '';
  if ('tags' in patch) next.tags = normalizeTags(patch.tags);
  if ('favorite' in patch) next.favorite = !!patch.favorite;
  next.did = existing.did;
  next.createdAt = existing.createdAt;
  next.updatedAt = now;
  return next;
};
