// @ts-check
// peerd-distributed/apps/meta.js — the DWAPP_META record (the "app card").
//
// The METADATA plane's payload (PROPAGATION.md). A small, publisher-signed card
// that says "this app exists, here's its latest version" — and NEVER the bytes.
// It is deliberately the SAME shape as a signed DHT item (dht/records.js): keyed
// by (publisher, salt=slug), carrying a no-downgrade `seq`, Ed25519-signed. why:
// the card floods on the metadata plane today AND drops into the DHT verbatim on
// the scaling step (PROPAGATION.md "scaling boundary") — one record, two homes,
// zero reshaping.
//
// Identity vs. version: `dwapp_id = H(publisher ‖ slug)` is the STABLE app id
// (so an update keeps it); `head.version_id` is the per-version bundle hash. The
// record is a signed AMENDMENT — a new version bumps `seq` and points `head` at
// new bytes; storers never accept a lower `seq` (anti-rollback, inherited from
// records.js).

import { signItem, verifyItem, itemKey, MAX_SALT_LEN } from '../dht/records.js';
import { utf8, concat, toHex } from '/shared/bundle/bytes.js';
import { canonicalize } from '/shared/bundle/canonical.js';

// Caps — what keeps the card cheap enough to relay liberally (PROPAGATION.md).
export const MAX_NAME = 64;
export const MAX_DESC = 512;
export const MAX_SLUG = MAX_SALT_LEN;     // 64 — the salt ceiling in records.js
export const MAX_META_BYTES = 4096;        // whole-card canonical ceiling

export class MetaRejectedError extends Error {
  /** @param {string} reason */
  constructor(reason) {
    super(`dwapp meta rejected: ${reason}`);
    this.name = 'MetaRejectedError';
  }
}

/** @param {BufferSource} bytes */
const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

// Stable, decentralized app identity. why H(publisher‖slug): stable across
// versions (the bundle hash is the VERSION id, not the app id), namespaced under
// the publisher so two authors can both ship "tictactoe" without collision, and
// DERIVED not registered — no global slug authority to capture (the ZeroID
// failure GLOBAL-NETWORK.md Q4 warns against).
/** @param {string} publisherDid @param {string} slug */
export const dwappId = async (publisherDid, slug) =>
  toHex(await sha256(concat(utf8(String(publisherDid)), utf8('\u0000'), utf8(String(slug)))));

// The dwapp_id an item CLAIMS, derived from its own (publisher, salt) — the
// verifiable handle a Library keys by. Never trust an id sent alongside.
/** @param {{ publisher: string, salt?: string }} item */
export const metaDwappId = (item) => dwappId(item.publisher, item.salt ?? '');

/** @param {unknown} head */
const headWellFormed = (head) => {
  if (!head || typeof head !== 'object') return false;
  const h = /** @type {Record<string, unknown>} */ (head);
  return typeof h.version_id === 'string' && h.version_id.length > 0 && h.version_id.length <= 128
    && typeof h.content_addr === 'string' && h.content_addr.startsWith('peerd://')
    && typeof h.size === 'number' && Number.isInteger(h.size) && h.size >= 0
    && (h.previous_version_id == null || (typeof h.previous_version_id === 'string' && h.previous_version_id.length <= 128))
    && (h.git_commit_oid == null || (typeof h.git_commit_oid === 'string' && h.git_commit_oid.length <= 128))
    && (h.changelog == null || (typeof h.changelog === 'string' && h.changelog.length <= 1200));
};

/**
 * Build a signed DWAPP_META amendment. `seq` must climb monotonically across an
 * app's versions; a fresh app starts at any non-negative integer (Date.now() is
 * fine and gives natural ordering).
 *
 * @param {{
 *   slug: string,
 *   name: string,
 *   description?: string,
 *   seq: number,
 *   head: { version_id: string, content_addr: string, size: number,
 *           previous_version_id?: string, git_commit_oid?: string, changelog?: string },
 *   icon?: string | null,
 * }} fields
 * @param {{ did: string, sign: (b: Uint8Array) => Promise<Uint8Array> }} identity
 */
export const buildMeta = async ({ slug, name, description = '', seq, head, icon = null }, identity) => {
  const s = String(slug ?? '');
  if (!s || s.length > MAX_SLUG) throw new MetaRejectedError(`slug length (1..${MAX_SLUG})`);
  if (typeof name !== 'string' || !name || name.length > MAX_NAME) throw new MetaRejectedError(`name length (1..${MAX_NAME})`);
  if (typeof description !== 'string' || description.length > MAX_DESC) throw new MetaRejectedError(`description length (0..${MAX_DESC})`);
  if (!Number.isInteger(seq) || seq < 0) throw new MetaRejectedError('seq must be a non-negative integer');
  if (!headWellFormed(head)) throw new MetaRejectedError('head must be { version_id, content_addr(peerd://), size }');
  if (icon != null && (typeof icon !== 'string' || !icon.startsWith('peerd://'))) {
    throw new MetaRejectedError('icon must be a peerd:// reference (never inline bytes)');
  }
  const value = {
    name,
    description,
    head: {
      version_id: head.version_id, content_addr: head.content_addr, size: head.size,
      ...(head.previous_version_id ? { previous_version_id: head.previous_version_id } : {}),
      ...(head.git_commit_oid ? { git_commit_oid: head.git_commit_oid } : {}),
      ...(head.changelog ? { changelog: head.changelog } : {}),
    },
    ...(icon ? { icon } : {}),
  };
  const item = await signItem({ value, seq, salt: s }, identity);
  if (!metaWellFormed(item)) throw new MetaRejectedError('built card exceeds the size ceiling');
  return item;
};

/**
 * The validated DWAPP_META shape (an app card).
 * @typedef {{
 *   publisher: string, salt: string, seq: number, sig: string,
 *   value: { name: string, description: string, head: { version_id: string, content_addr: string, size: number, previous_version_id?: string, git_commit_oid?: string, changelog?: string }, icon?: string },
 * }} MetaItem
 */

/**
 * Cheap structural + size validation (no crypto) — the relay pre-filter.
 * @param {unknown} item
 * @returns {item is MetaItem}
 */
export const metaWellFormed = (item) => {
  if (!item || typeof item !== 'object') return false;
  const it = /** @type {Record<string, any>} */ (item);
  if (typeof it.publisher !== 'string' || !it.publisher) return false;
  if (typeof it.salt !== 'string' || !it.salt || it.salt.length > MAX_SLUG) return false;
  if (typeof it.seq !== 'number' || !Number.isInteger(it.seq) || it.seq < 0) return false;
  if (typeof it.sig !== 'string' || !it.sig) return false;
  const v = it.value;
  if (!v || typeof v !== 'object') return false;
  if (typeof v.name !== 'string' || !v.name || v.name.length > MAX_NAME) return false;
  if (typeof v.description !== 'string' || v.description.length > MAX_DESC) return false;
  if (!headWellFormed(v.head)) return false;
  if (v.icon != null && (typeof v.icon !== 'string' || !v.icon.startsWith('peerd://'))) return false;
  // The whole-card ceiling: the cheap brake on a flooded plane.
  if (utf8(canonicalize(item)).length > MAX_META_BYTES) return false;
  return true;
};

/**
 * Full validation: well-formed AND the publisher signature verifies.
 * @param {unknown} item
 */
export const verifyMeta = async (item) => {
  if (!metaWellFormed(item)) return false;
  return verifyItem(item);   // checks sig over (salt, seq, value) against publisher
};

// Re-export so callers can derive the DHT key for the scaling-step mirror
// without reaching into records.js themselves.
export { itemKey as metaDhtKey };
