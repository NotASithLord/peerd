// @ts-check
// shared/bundle/transport.js - deterministic compressed bundle transport.
//
// The mutable App workspace is always the decoded file tree. Compression is a
// distribution detail applied to the canonical v1 file container immediately
// before chunking, then removed and verified before any byte reaches OPFS/Git.
// Keeping that boundary explicit means browser Git hashes the same source bytes
// whether an App was created locally, cloned, or installed from a peer.

import { packBundle, unpackBundle } from './bundle.js';
import { concat } from './bytes.js';
import { sha256hex } from './chunk.js';
import { Deflate, Inflate } from '../../vendor/pako/index.js';

export const BUNDLE_TRANSPORT_VERSION = 2;
export const BUNDLE_TRANSPORT_ENCODING = 'gzip';
export const BUNDLE_TRANSPORT_CODEC = 'pako@1.0.11:gzip:l6:w15:m8:s0:i262144:mtime0:os255';
export const MAX_BUNDLE_CONTAINER_BYTES = 70_000_000;
export const MAX_BUNDLE_DECODED_BYTES = 50_000_000;
export const MAX_BUNDLE_FILE_BYTES = 50_000_000;
export const MAX_BUNDLE_FILES = 256;
export const MAX_BUNDLE_PATH_CHARS = 512;
const SHA256_HEX = /^[a-f0-9]{64}$/;

/** @typedef {'text' | 'binary'} AppFileKind */
/**
 * @typedef {{
 *   path: string,
 *   size: number,
 *   hash: string,
 *   kind?: AppFileKind,
 * }} BundleFileCommitment
 * @typedef {{
 *   version: 2,
 *   encoding: 'gzip',
 *   codec: 'pako@1.0.11:gzip:l6:w15:m8:s0:i262144:mtime0:os255',
 *   compressedSize: number,
 *   uncompressedSize: number,
 *   compressedHash: string,
 *   uncompressedHash: string,
 *   files: BundleFileCommitment[],
 * }} BundleTransportDescriptor
 */

/**
 * Admit a signed v2 descriptor before any compressed bytes are fetched or
 * decompressed. The decoded file sum and container ceiling are independent:
 * canonical JSON/base64 has bounded framing overhead above the raw workspace.
 *
 * @param {unknown} candidate
 * @param {{ compressedSize?: number, maxCompressedBytes?: number }} [limits]
 * @returns {BundleTransportDescriptor}
 */
export const assertBundleTransportDescriptor = (candidate, limits = {}) => {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('bundle transport descriptor missing');
  }
  const descriptor = /** @type {any} */ (candidate);
  if (descriptor.version !== BUNDLE_TRANSPORT_VERSION
      || descriptor.encoding !== BUNDLE_TRANSPORT_ENCODING
      || descriptor.codec !== BUNDLE_TRANSPORT_CODEC) {
    throw new Error('bundle transport version, encoding, or codec unsupported');
  }
  const maxCompressedBytes = limits.maxCompressedBytes ?? 50_000_000;
  if (!Number.isSafeInteger(descriptor.compressedSize) || descriptor.compressedSize <= 0
      || descriptor.compressedSize > maxCompressedBytes
      || (limits.compressedSize !== undefined && descriptor.compressedSize !== limits.compressedSize)) {
    throw new Error('bundle compressed size invalid');
  }
  if (!Number.isSafeInteger(descriptor.uncompressedSize) || descriptor.uncompressedSize <= 0
      || descriptor.uncompressedSize > MAX_BUNDLE_CONTAINER_BYTES) {
    throw new Error('bundle uncompressed size invalid');
  }
  if (!SHA256_HEX.test(descriptor.compressedHash)
      || !SHA256_HEX.test(descriptor.uncompressedHash)) {
    throw new Error('bundle transport hash invalid');
  }
  if (!Array.isArray(descriptor.files) || descriptor.files.length > MAX_BUNDLE_FILES) {
    throw new Error('bundle file commitments invalid');
  }
  const paths = new Set();
  let decodedBytes = 0;
  let previousPath = '';
  for (const file of descriptor.files) {
    if (!file || typeof file !== 'object' || typeof file.path !== 'string') {
      throw new Error('bundle file commitment path invalid');
    }
    const path = /** @type {string} */ (file.path);
    if (!path || path.length > MAX_BUNDLE_PATH_CHARS
        || path.startsWith('/') || path.split('/').some((part) => !part || part === '.' || part === '..')
        || paths.has(path)) {
      throw new Error('bundle file commitment path invalid');
    }
    if (previousPath && path <= previousPath) {
      throw new Error('bundle file commitments must be in lexical path order');
    }
    paths.add(path);
    previousPath = path;
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_BUNDLE_FILE_BYTES) {
      throw new Error(`bundle file commitment size invalid: ${path}`);
    }
    decodedBytes += file.size;
    if (!Number.isSafeInteger(decodedBytes) || decodedBytes > MAX_BUNDLE_DECODED_BYTES) {
      throw new Error('bundle file commitments exceed decoded byte limit');
    }
    if (!SHA256_HEX.test(file.hash)) throw new Error(`bundle file commitment hash invalid: ${path}`);
    if (file.kind !== undefined && file.kind !== 'text' && file.kind !== 'binary') {
      throw new Error(`bundle file commitment kind invalid: ${path}`);
    }
  }
  return /** @type {BundleTransportDescriptor} */ (candidate);
};

const CODEC_OUTPUT_CHUNK_BYTES = 16 * 1024;
const CODEC_INPUT_CHUNK_BYTES = 256 * 1024;
const CANONICAL_GZIP_HEADER = [0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255];

/** @param {{ err?: number, msg?: string }} codec @param {string} operation */
const codecFailure = (codec, operation) =>
  `${operation} failed${codec.msg ? `: ${codec.msg}` : codec.err ? `: codec error ${codec.err}` : ''}`;

/** @param {Uint8Array} bytes */
export const compressBundleBytes = async (bytes) => {
  if (!(bytes instanceof Uint8Array)) throw new Error('bundle input must be bytes');
  /** @type {Uint8Array[]} */
  const chunks = [];
  let total = 0;
  const deflator = new Deflate({
    gzip: true,
    level: 6,
    windowBits: 15,
    memLevel: 8,
    strategy: 0,
    chunkSize: CODEC_OUTPUT_CHUNK_BYTES,
    header: { time: 0, os: 255 },
  });
  deflator.onData = (/** @type {Uint8Array} */ chunk) => {
    if (!(chunk instanceof Uint8Array)) throw new Error('bundle codec emitted non-byte output');
    total += chunk.byteLength;
    if (!Number.isSafeInteger(total) || total > MAX_BUNDLE_CONTAINER_BYTES) {
      throw new Error(`bundle output exceeds ${MAX_BUNDLE_CONTAINER_BYTES} bytes`);
    }
    chunks.push(new Uint8Array(chunk));
  };
  let ok = false;
  try {
    // why fixed chunks without intermediate flushes: the boundary is signed
    // into the codec identity and therefore host-independent. Yielding between
    // chunks keeps a Charon-sized share from starving the offscreen mesh loop.
    if (bytes.byteLength === 0) ok = deflator.push(bytes, true);
    for (let offset = 0; offset < bytes.byteLength; offset += CODEC_INPUT_CHUNK_BYTES) {
      const end = Math.min(offset + CODEC_INPUT_CHUNK_BYTES, bytes.byteLength);
      const final = end === bytes.byteLength;
      ok = deflator.push(bytes.subarray(offset, end), final);
      if (!ok || deflator.err) break;
      if (!final) await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } catch (error) {
    throw new Error(`bundle compression failed: ${/** @type {{message?:string}} */ (error)?.message ?? String(error)}`);
  }
  if (!ok || deflator.err) throw new Error(codecFailure(deflator, 'bundle compression'));
  const compressed = concat(...chunks);
  if (compressed.byteLength < 18
      || CANONICAL_GZIP_HEADER.some((value, index) => compressed[index] !== value)) {
    throw new Error('gzip compressor emitted a non-canonical header');
  }
  return compressed;
};

/**
 * @param {Uint8Array} bytes
 * @param {{ expectedBytes: number, maxBytes?: number }} limits
 */
export const decompressBundleBytes = async (bytes, {
  expectedBytes,
  maxBytes = MAX_BUNDLE_CONTAINER_BYTES,
}) => {
  if (!(bytes instanceof Uint8Array)) throw new Error('bundle payload must be bytes');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0
      || !Number.isSafeInteger(expectedBytes) || expectedBytes < 0 || expectedBytes > maxBytes) {
    throw new Error('bundle uncompressed size exceeds the output limit');
  }
  const decoded = new Uint8Array(expectedBytes);
  let total = 0;
  // why expected+1 for small claims: a lying 32-byte descriptor causes at
  // most a 33-byte output buffer before refusal. Large valid bundles amortize
  // calls with a fixed small chunk, so bombs never allocate their full output.
  const chunkSize = Math.max(1, Math.min(CODEC_OUTPUT_CHUNK_BYTES, expectedBytes + 1));
  const inflator = new Inflate({ windowBits: 31, chunkSize });
  inflator.onData = (/** @type {Uint8Array} */ chunk) => {
    if (!(chunk instanceof Uint8Array)) throw new Error('bundle codec emitted non-byte output');
    const nextTotal = total + chunk.byteLength;
    if (!Number.isSafeInteger(nextTotal) || nextTotal > expectedBytes || nextTotal > maxBytes) {
      throw new Error(`bundle output exceeds ${Math.min(expectedBytes, maxBytes)} bytes`);
    }
    decoded.set(chunk, total);
    total = nextTotal;
  };
  let ok = false;
  try {
    if (bytes.byteLength === 0) ok = inflator.push(bytes, true);
    for (let offset = 0; offset < bytes.byteLength; offset += CODEC_INPUT_CHUNK_BYTES) {
      const end = Math.min(offset + CODEC_INPUT_CHUNK_BYTES, bytes.byteLength);
      const final = end === bytes.byteLength;
      ok = inflator.push(bytes.subarray(offset, end), final);
      if (!ok || inflator.err) break;
      if (!final) await new Promise((resolve) => setTimeout(resolve, 0));
    }
  } catch (error) {
    throw new Error(`bundle decompression failed: ${/** @type {{message?:string}} */ (error)?.message ?? String(error)}`);
  }
  if (!ok || inflator.err) throw new Error(codecFailure(inflator, 'bundle decompression'));
  if (total !== expectedBytes) {
    throw new Error(`bundle uncompressed size mismatch: ${total} != ${expectedBytes}`);
  }
  return decoded;
};

/**
 * Build the v2 bytes and descriptor signed into the outer content manifest.
 * File order is lexical and the canonical inner container sorts object keys;
 * identical decoded workspaces therefore produce identical compressed bytes.
 *
 * @param {{ entry?: string, files: Record<string, Uint8Array>,
 *   fileKinds?: Record<string, AppFileKind> }} bundle
 */
export const packTransportBundle = async ({ entry, files, fileKinds }) => {
  const paths = Object.keys(files).sort();
  if (paths.length > MAX_BUNDLE_FILES) throw new Error(`bundle has more than ${MAX_BUNDLE_FILES} files`);
  /** @type {BundleFileCommitment[]} */
  const commitments = [];
  let decodedBytes = 0;
  for (const path of paths) {
    if (!path || path.length > MAX_BUNDLE_PATH_CHARS) throw new Error(`invalid bundle path: ${path}`);
    const bytes = files[path];
    if (!(bytes instanceof Uint8Array)) throw new Error(`bundle file must be bytes: ${path}`);
    if (bytes.byteLength > MAX_BUNDLE_FILE_BYTES) {
      throw new Error(`bundle file exceeds ${MAX_BUNDLE_FILE_BYTES} bytes: ${path}`);
    }
    decodedBytes += bytes.byteLength;
    if (!Number.isSafeInteger(decodedBytes) || decodedBytes > MAX_BUNDLE_DECODED_BYTES) {
      throw new Error(`bundle files exceed ${MAX_BUNDLE_DECODED_BYTES} decoded bytes`);
    }
    const kind = fileKinds?.[path];
    commitments.push({
      path,
      size: bytes.byteLength,
      hash: await sha256hex(bytes),
      ...(kind === 'text' || kind === 'binary' ? { kind } : {}),
    });
  }
  const uncompressed = packBundle({ entry, files, fileKinds });
  if (uncompressed.byteLength > MAX_BUNDLE_CONTAINER_BYTES) {
    throw new Error(`bundle container exceeds ${MAX_BUNDLE_CONTAINER_BYTES} bytes`);
  }
  const payload = await compressBundleBytes(uncompressed);
  /** @type {BundleTransportDescriptor} */
  const descriptor = {
    version: BUNDLE_TRANSPORT_VERSION,
    encoding: BUNDLE_TRANSPORT_ENCODING,
    codec: BUNDLE_TRANSPORT_CODEC,
    compressedSize: payload.byteLength,
    uncompressedSize: uncompressed.byteLength,
    compressedHash: await sha256hex(payload),
    uncompressedHash: await sha256hex(uncompressed),
    files: commitments,
  };
  return { payload, descriptor };
};

/**
 * Decode v1 payloads unchanged and v2 payloads only after both compressed and
 * uncompressed commitments pass. Per-file commitments are verified before the
 * caller receives the canonical decoded file map.
 *
 * @param {{ manifest: any, payload: Uint8Array,
 *   limits?: { maxPackedBytes?: number, maxDecodedBytes?: number,
 *     maxFileBytes?: number, maxFiles?: number, maxPathChars?: number } }} opts
 */
export const unpackTransportBundle = async ({ manifest, payload, limits = {} }) => {
  if (manifest?.v !== BUNDLE_TRANSPORT_VERSION) {
    return unpackBundle(payload, limits);
  }
  if (!manifest.bundle) throw new Error('bundle transport descriptor missing');
  const descriptor = assertBundleTransportDescriptor(manifest.bundle, {
    compressedSize: manifest.size,
    maxCompressedBytes: limits.maxPackedBytes ?? 50_000_000,
  });
  if (payload.byteLength !== descriptor.compressedSize) throw new Error('bundle compressed size mismatch');
  if (await sha256hex(payload) !== descriptor.compressedHash) throw new Error('bundle compressed hash mismatch');
  const uncompressed = await decompressBundleBytes(payload, {
    expectedBytes: descriptor.uncompressedSize,
    maxBytes: limits.maxPackedBytes ?? MAX_BUNDLE_CONTAINER_BYTES,
  });
  if (await sha256hex(uncompressed) !== descriptor.uncompressedHash) {
    throw new Error('bundle uncompressed hash mismatch');
  }
  const unpacked = unpackBundle(uncompressed, {
    maxPackedBytes: limits.maxPackedBytes ?? MAX_BUNDLE_CONTAINER_BYTES,
    maxDecodedBytes: limits.maxDecodedBytes ?? MAX_BUNDLE_DECODED_BYTES,
    maxFileBytes: limits.maxFileBytes ?? MAX_BUNDLE_FILE_BYTES,
    maxFiles: limits.maxFiles ?? MAX_BUNDLE_FILES,
    maxPathChars: limits.maxPathChars ?? MAX_BUNDLE_PATH_CHARS,
  });
  const paths = Object.keys(unpacked.files).sort();
  if (paths.length !== descriptor.files.length) throw new Error('bundle file commitment count mismatch');
  for (let index = 0; index < paths.length; index++) {
    const path = paths[index];
    const committed = descriptor.files[index];
    const bytes = unpacked.files[path];
    if (committed.path !== path) throw new Error(`bundle file commitment path mismatch: ${path}`);
    if (committed.size !== bytes.byteLength) throw new Error(`bundle file size mismatch: ${path}`);
    if (await sha256hex(bytes) !== committed.hash) throw new Error(`bundle file hash mismatch: ${path}`);
    if (committed.kind !== undefined && unpacked.fileKinds[path] !== committed.kind) {
      throw new Error(`bundle file kind mismatch: ${path}`);
    }
  }
  return unpacked;
};
