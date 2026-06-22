// @ts-check
// shared/bundle/chunk.js — 256KB chunking + SHA-256.
//
// why: content is fetched chunk-by-chunk from any holder and each chunk
// is verified independently against the SHA-256 the manifest commits to
// (PROTOCOL §4.2). Tampering is detectable at chunk granularity. Pure
// functions; crypto.subtle.digest is ambient (same as the vault uses
// crypto.subtle directly). Lives in shared/ (not the dweb module)
// because .peerd artifact exports use the same chunking and must work
// in store packages, which prune the dweb module.

import { toHex } from './bytes.js';

export const CHUNK_SIZE = 262144; // 256 KiB (PROTOCOL §4.2)

// Split a byte payload into <=CHUNK_SIZE views. Returns subarrays (zero
// copy) over the original buffer. Empty payload -> empty chunk list.
/**
 * @param {Uint8Array} bytes
 * @param {number} [size]
 */
export const chunkBytes = (bytes, size = CHUNK_SIZE) => {
  const out = [];
  for (let off = 0; off < bytes.length; off += size) {
    out.push(bytes.subarray(off, Math.min(off + size, bytes.length)));
  }
  return out;
};

// why the cast: callers pass `Uint8Array` (generic `ArrayBufferLike`
// backing), which the strict lib won't narrow to digest's `BufferSource`
// (`ArrayBuffer`-backed) param — a known typed-array generics gap. The
// bytes are a valid digest input at runtime.
/** @param {Uint8Array} bytes */
export const sha256hex = async (bytes) =>
  toHex(new Uint8Array(
    await crypto.subtle.digest('SHA-256', /** @type {BufferSource} */ (bytes)),
  ));
