// @ts-check
// shared/bundle/bundle.js - bounded file-map <-> payload bytes.
//
// A bundle is canonical JSON containing base64 file bytes. Decoding is a
// two-pass operation: admit the complete shape and aggregate sizes first, then
// allocate byte arrays. This prevents a small valid payload from amplifying
// into an unbounded number of allocations before a caller can enforce limits.

import { canonicalize } from './canonical.js';
import {
  base64ByteLength,
  utf8,
  fromUtf8,
  toBase64,
  fromBase64,
} from './bytes.js';

const DEFAULT_MAX_PACKED_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_DECODED_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FILES = 1024;
const DEFAULT_MAX_PATH_CHARS = 1024;
export const MAX_NETWORK_BUNDLE_BYTES = 50_000_000;

/** @typedef {'text' | 'binary'} AppFileKind */

/**
 * @param {{ entry?: string, files: Record<string, Uint8Array>,
 *   fileKinds?: Record<string, AppFileKind> }} bundle
 */
export const packBundle = ({ entry, files, fileKinds }) => {
  /** @type {Record<string, string>} */
  const encoded = Object.create(null);
  for (const [path, bytes] of Object.entries(files)) encoded[path] = toBase64(bytes);
  /** @type {Record<string, AppFileKind>} */
  const kinds = Object.create(null);
  if (fileKinds && typeof fileKinds === 'object') {
    for (const [path, kind] of Object.entries(fileKinds)) {
      if (!Object.hasOwn(files, path)) throw new Error(`file kind has no file: ${path}`);
      if (kind !== 'text' && kind !== 'binary') throw new Error(`invalid file kind: ${path}`);
      kinds[path] = kind;
    }
  }
  return utf8(canonicalize({
    v: 1,
    ...(entry != null ? { entry } : {}),
    files: encoded,
    ...(Object.keys(kinds).length ? { fileKinds: kinds } : {}),
  }));
};

/**
 * @param {Uint8Array} payload
 * @param {{ maxPackedBytes?: number, maxDecodedBytes?: number,
 *   maxFiles?: number, maxPathChars?: number }} [limits]
 * @returns {{ entry: string | undefined, files: Record<string, Uint8Array>,
 *   fileKinds: Record<string, AppFileKind> }}
 */
export const unpackBundle = (payload, limits = {}) => {
  const maxPackedBytes = limits.maxPackedBytes ?? DEFAULT_MAX_PACKED_BYTES;
  const maxDecodedBytes = limits.maxDecodedBytes ?? DEFAULT_MAX_DECODED_BYTES;
  const maxFiles = limits.maxFiles ?? DEFAULT_MAX_FILES;
  const maxPathChars = limits.maxPathChars ?? DEFAULT_MAX_PATH_CHARS;
  if (!(payload instanceof Uint8Array)) throw new Error('bundle payload must be bytes');
  if (payload.byteLength > maxPackedBytes) throw new Error(`bundle payload exceeds ${maxPackedBytes} bytes`);

  const obj = JSON.parse(fromUtf8(payload));
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error('bundle must be an object');
  if (obj.v !== 1) throw new Error(`unsupported bundle version: ${String(obj.v)}`);
  if (!obj.files || typeof obj.files !== 'object' || Array.isArray(obj.files)) {
    throw new Error('bundle files must be an object');
  }
  if (obj.entry !== undefined && typeof obj.entry !== 'string') throw new Error('bundle entry must be a string');
  if (obj.fileKinds !== undefined
      && (!obj.fileKinds || typeof obj.fileKinds !== 'object' || Array.isArray(obj.fileKinds))) {
    throw new Error('bundle fileKinds must be an object');
  }

  /** @type {string[]} */
  const paths = [];
  let decodedBytes = 0;
  for (const path in obj.files) {
    if (!Object.hasOwn(obj.files, path)) continue;
    if (!path || path.length > maxPathChars) throw new Error(`invalid bundle path: ${path}`);
    paths.push(path);
    if (paths.length > maxFiles) throw new Error(`bundle has more than ${maxFiles} files`);
    const encoded = obj.files[path];
    if (typeof encoded !== 'string') throw new Error(`bundle file is not base64: ${path}`);
    decodedBytes += base64ByteLength(encoded);
    if (!Number.isSafeInteger(decodedBytes) || decodedBytes > maxDecodedBytes) {
      throw new Error(`bundle files exceed ${maxDecodedBytes} decoded bytes`);
    }
  }
  if (obj.entry !== undefined && !Object.hasOwn(obj.files, obj.entry)) {
    throw new Error(`bundle entry file missing: ${obj.entry}`);
  }

  /** @type {Record<string, AppFileKind>} */
  const fileKinds = Object.create(null);
  if (obj.fileKinds) {
    let kindCount = 0;
    for (const path in obj.fileKinds) {
      if (!Object.hasOwn(obj.fileKinds, path)) continue;
      kindCount += 1;
      if (kindCount > maxFiles) throw new Error(`bundle has more than ${maxFiles} file kinds`);
      if (!Object.hasOwn(obj.files, path)) throw new Error(`file kind has no file: ${path}`);
      const kind = obj.fileKinds[path];
      if (kind !== 'text' && kind !== 'binary') throw new Error(`invalid file kind: ${path}`);
      fileKinds[path] = kind;
    }
  }

  /** @type {Record<string, Uint8Array>} */
  const files = Object.create(null);
  for (const path of paths) files[path] = fromBase64(obj.files[path]);
  return { entry: obj.entry, files, fileKinds };
};

/**
 * @param {Uint8Array} payload
 * @param {{ maxPackedBytes?: number, maxDecodedBytes?: number,
 *   maxFiles?: number, maxPathChars?: number }} [limits]
 */
export const unpackBundleText = (payload, limits) => {
  const { entry, files, fileKinds } = unpackBundle(payload, limits);
  /** @type {Record<string, string>} */
  const text = Object.create(null);
  for (const [path, bytes] of Object.entries(files)) text[path] = fromUtf8(bytes);
  return { entry, files: text, fileKinds };
};
