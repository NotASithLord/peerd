// @ts-check
// Fixed-route retrieval reads existing immutable content and provider records.
// It carries no arbitrary RPC, signaling, writes, or edge-replacement authority.
import { decodeDidKey } from '../identity/did.js';
import { MAX_ROUTING_PATH_NODES } from './routing-path-holds.js';
import { CHUNK_SIZE } from '../content/chunk.js';
import { MAX_MANIFEST_BYTES } from '../content/manifest.js';
import { base64ByteLength, fromBase64 } from '/shared/bundle/bytes.js';

export const RETRIEVAL_CONCURRENCY = 2;
export const RETRIEVAL_PART_BYTES = 1024;
export const RETRIEVAL_FRAME_BYTES = 4096;
const HASH = /^[0-9a-f]{64}$/;
const LIMITS = Object.freeze({ providers: 16_384, manifest: MAX_MANIFEST_BYTES, chunk: CHUNK_SIZE });
/** @typedef {'providers'|'manifest'|'chunk'} RetrievalKind */
/** @param {any} value @param {string[]} keys */
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
/** @param {unknown} value */
const validDid = value => {
  if (typeof value !== 'string' || value.length > 128) return false;
  try { decodeDidKey(value); return true; } catch { return false; }
};
export class RetrievalProtocolError extends Error {
  constructor() { super('invalid bounded retrieval message'); this.name = 'RetrievalProtocolError'; }
}
/** @param {unknown} kind */
export const retrievalReplyLimit = kind => typeof kind === 'string' && Object.hasOwn(LIMITS, kind)
  ? LIMITS[/** @type {RetrievalKind} */ (kind)] : 0;

/** Signature, freshness and carrier custody must be checked by the protocol owner.
 * This validator grants only the three closed read operations, on a fixed path.
 * @param {any} body @param {string} room @param {string} origin */
export const validRetrievalCall = (body, room, origin) => !!(exact(body, ['room', 'path', 'request'])
  && body.room === room && Array.isArray(body.path) && body.path.length >= 2
  && body.path.length <= MAX_ROUTING_PATH_NODES && body.path.every(validDid)
  && new Set(body.path).size === body.path.length && body.path[0] === origin
  && exact(body.request, ['kind', 'hash']) && retrievalReplyLimit(body.request.kind) > 0
  && typeof body.request.hash === 'string' && HASH.test(body.request.hash));

/** Validate before allocating or decoding attacker-controlled reply bytes.
 * A zero-length response denotes absence, not a verified content object.
 * @param {any} part @param {RetrievalKind} kind */
export const validRetrievalPart = (part, kind) => {
  const limit = retrievalReplyLimit(kind);
  if (!limit || !exact(part, ['offset', 'total', 'data']) || !Number.isSafeInteger(part.total)
    || part.total < 0 || part.total > limit || !Number.isSafeInteger(part.offset)
    || part.offset < 0 || part.offset % RETRIEVAL_PART_BYTES !== 0 || part.offset > part.total
    || (part.total > 0 && part.offset === part.total) || typeof part.data !== 'string'
    || part.data.length > Math.ceil(RETRIEVAL_PART_BYTES / 3) * 4) return false;
  try { return base64ByteLength(part.data) === Math.min(RETRIEVAL_PART_BYTES, part.total - part.offset); }
  catch { return false; }
};

/** Origin-only bounded assembly; forwarders must not allocate this buffer.
 * Hash/manifest verification remains mandatory after transport completion.
 * @param {RetrievalKind} kind */
export const createRetrievalReply = kind => {
  if (!retrievalReplyLimit(kind)) throw new RetrievalProtocolError();
  /** @type {Uint8Array|null} */ let bytes = null;
  let offset = 0, total = -1, closed = false;
  const close = () => { closed = true; bytes = null; };
  return Object.freeze({
    /** @param {any} part @returns {Uint8Array|null} */
    accept(part) {
      // why: repeats, gaps or changing totals cannot prolong a transfer or
      // replace previously accepted bytes. Any violation retires this owner.
      if (closed || !validRetrievalPart(part, kind) || part.offset !== offset || (total >= 0 && total !== part.total)) {
        close(); throw new RetrievalProtocolError();
      }
      if (!bytes) { total = part.total; bytes = new Uint8Array(total); }
      const decoded = fromBase64(part.data);
      bytes.set(decoded, offset); offset += decoded.length;
      if (offset !== total) return null;
      const result = bytes; close(); return result;
    },
    close,
  });
};
