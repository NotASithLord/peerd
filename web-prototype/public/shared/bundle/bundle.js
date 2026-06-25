// shared/bundle/bundle.js — file-map <-> payload bytes.
//
// why: an artifact is multi-file (index.html + style.css + script.js +
// …), but the content layer addresses and chunks a single byte payload.
// The bundle is that payload: a deterministic (canonical) JSON
// serialization of { entry, files }, with file bytes base64-encoded.
// Deterministic so that identical inputs produce an identical content
// hash. Lives in shared/ (not the dweb module) because .peerd
// artifact exports pack the same payload and must work in store packages,
// which prune the dweb module.

import { canonicalize } from './canonical.js';
import { utf8, fromUtf8, toBase64, fromBase64 } from './bytes.js';

// files: Record<path, Uint8Array> -> payload bytes
//
// why entry is optional: apps have an entry file (index.html); Notebook
// trees and vm recipes don't. canonicalize refuses `undefined`, so the
// key is omitted entirely when absent rather than serialized as a hole.
export const packBundle = ({ entry, files }) => {
  const encoded = {};
  for (const [path, bytes] of Object.entries(files)) {
    encoded[path] = toBase64(bytes);
  }
  return utf8(canonicalize({ v: 1, ...(entry != null ? { entry } : {}), files: encoded }));
};

/**
 * payload bytes -> { entry, files }
 * @returns {{ entry: string | undefined, files: Record<string, Uint8Array> }}
 */
export const unpackBundle = (payload) => {
  const obj = JSON.parse(fromUtf8(payload));
  const files = {};
  for (const [path, b64] of Object.entries(obj.files)) {
    files[path] = fromBase64(b64);
  }
  return { entry: obj.entry, files };
};

/**
 * payload bytes -> { entry, files } with text contents, for composeApp,
 * which expects text content.
 * @returns {{ entry: string | undefined, files: Record<string, string> }}
 */
export const unpackBundleText = (payload) => {
  const { entry, files } = unpackBundle(payload);
  const text = {};
  for (const [path, bytes] of Object.entries(files)) text[path] = fromUtf8(bytes);
  return { entry, files: text };
};
