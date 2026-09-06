// @ts-check

import { structuredClonePayloadBytes } from './structured-clone-size.js';

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const MAX_DEPTH = 32;
const MAX_NODES = 250_000;

const BASE64_CHUNK_BYTES = 24 * 1024;

// why: exact operation payloads may legitimately contain multi-megabyte typed
// buffers. Spreading/map-boxing every byte can transiently consume orders of
// magnitude more memory than the admitted clone. Fixed chunks keep temporary
// allocation proportional to the bounded payload while preserving exact bytes.
const bytesBase64 = (/** @type {Uint8Array} */ bytes) => {
  const pieces = [];
  for (let offset = 0; offset < bytes.byteLength; offset += BASE64_CHUNK_BYTES) {
    const end = Math.min(bytes.byteLength, offset + BASE64_CHUNK_BYTES);
    let binary = '';
    for (let index = offset; index < end; index += 1) {
      binary += String.fromCharCode(bytes[index]);
    }
    pieces.push(btoa(binary));
  }
  return pieces.join('');
};

const digestHex = (/** @type {Uint8Array} */ bytes) => {
  let text = '';
  for (const byte of bytes) text += byte.toString(16).padStart(2, '0');
  return text;
};

/** @param {unknown} input @param {{maxBytes?:number}} [options] */
export const canonicalStructuredClone = (input, options = {}) => {
  const maxBytes = Number.isSafeInteger(options.maxBytes) && Number(options.maxBytes) > 0
    ? Number(options.maxBytes) : DEFAULT_MAX_BYTES;
  const payloadBytes = structuredClonePayloadBytes(input, {
    maxDepth: MAX_DEPTH, maxNodes: MAX_NODES,
  });
  if (!Number.isFinite(payloadBytes) || payloadBytes > maxBytes) {
    throw new TypeError('authority-arguments-invalid');
  }
  const seen = new Set();
  let nodes = 0;
  /** @returns {any[]} */
  const visit = (/** @type {unknown} */ value, /** @type {number} */ depth) => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) throw new TypeError('authority-arguments-invalid');
    if (value === undefined) return ['undefined'];
    if (value === null) return ['null'];
    if (typeof value === 'boolean') return ['boolean', value];
    if (typeof value === 'string') return ['string', value];
    if (typeof value === 'bigint') return ['bigint', value.toString()];
    if (typeof value === 'number') {
      if (Number.isNaN(value)) return ['number', 'nan'];
      if (value === Infinity) return ['number', 'infinity'];
      if (value === -Infinity) return ['number', '-infinity'];
      if (Object.is(value, -0)) return ['number', '-0'];
      return ['number', value];
    }
    if (!value || typeof value !== 'object' || seen.has(value)) {
      throw new TypeError('authority-arguments-invalid');
    }
    if (value instanceof ArrayBuffer) {
      return ['array-buffer', bytesBase64(new Uint8Array(value))];
    }
    if (ArrayBuffer.isView(value)) {
      if (!(value.buffer instanceof ArrayBuffer)) throw new TypeError('authority-arguments-invalid');
      return [
        'array-view', value.constructor.name,
        value.byteOffset, value.byteLength,
        // Structured clone preserves the complete ordinary backing buffer,
        // including bytes outside the visible view. Hash that transported
        // identity so two authority payloads cannot collide while exposing
        // distinguishable hidden bytes or offsets to the exact handler.
        bytesBase64(new Uint8Array(value.buffer)),
      ];
    }
    seen.add(value);
    {
      if (Object.getOwnPropertySymbols(value).length > 0) {
        throw new TypeError('authority-arguments-invalid');
      }
      if (Array.isArray(value)) {
        if (value.length > MAX_NODES - nodes) throw new TypeError('authority-arguments-invalid');
        nodes += value.length;
      }
      const keys = Object.getOwnPropertyNames(value);
      if (keys.length > MAX_NODES - nodes + (Array.isArray(value) ? value.length : 0)) {
        throw new TypeError('authority-arguments-invalid');
      }
      keys.sort();
      const entries = [];
      for (const key of keys) {
        if (Array.isArray(value) && key === 'length') continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor)) throw new TypeError('authority-arguments-invalid');
        entries.push([key, visit(descriptor.value, depth + 1)]);
      }
      if (Array.isArray(value)) return ['array', value.length, entries];
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('authority-arguments-invalid');
      }
      return ['object', prototype === null ? 'null' : 'plain', entries];
    }
  };
  return JSON.stringify(visit(input, 0));
};

/**
 * @param {unknown} left
 * @param {unknown} right
 * @param {{maxBytes?:number}} [options]
 */
export const sameCanonicalStructuredClone = (left, right, options) => {
  try {
    return canonicalStructuredClone(left, options) === canonicalStructuredClone(right, options);
  } catch {
    // why: exact authority comparison fails closed for values outside the
    // admitted structured-clone subset or its byte bound.
    return false;
  }
};

/** @param {unknown} input @param {{maxBytes?:number}} [options] */
export const canonicalCloneDigest = async (input, options) => {
  const text = canonicalStructuredClone(input, options);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return digestHex(new Uint8Array(digest));
};
