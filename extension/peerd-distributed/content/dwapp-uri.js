// @ts-check
// Immutable share addresses. This is a pure codec, not a resolver or protocol
// handler registration. The manifest hash names the bytes; an optional publisher
// is a required signer constraint for a future loader, NOT proof by itself.
//
// dwapp://content/[<Ed25519 multibase>/]<manifest SHA-256>[/<path>]
// web+dwapp:// carries the identical payload for a future browser handoff.
// The fixed authority roundtrips through browser URL parsing. Keys stay in the
// case-sensitive path; ports, credentials, query and fragment are forbidden.
// Existing peerd:// stays separate.

import { decodeDidKey, encodeDidKey } from '../identity/did.js';

const SCHEME = 'dwapp://content/';
const HANDOFF_SCHEME = 'web+dwapp://content/';
const HASH_RE = /^[0-9a-f]{64}$/;
export const MAX_DWAPP_URI_LENGTH = 4096;
export const MAX_DWAPP_PATH_BYTES = 1024;
const MAX_SEGMENTS = 64;
const MAX_SEGMENT_BYTES = 255;
const encoder = new TextEncoder();

export class DwappUriError extends Error {
  /** @param {string} message */
  constructor(message) { super(message); this.name = 'DwappUriError'; }
}

/** @typedef {{ did?: string, hash: string, path?: string }} DwappAddress */

/** @param {unknown} did */
function publisher(did) {
  if (did === undefined) return undefined;
  try {
    if (typeof did !== 'string' || encodeDidKey(decodeDidKey(did)) !== did) throw new Error();
  } catch { throw new DwappUriError('Invalid canonical Ed25519 publisher'); }
  return did;
}

// Paths are decoded relative names at the API boundary. Reject, rather than
// resolve, traversal or Unicode aliases: normalizing them could name a different
// file in a signed bundle. Decode ONCE on input; a literal percent in the
// returned path is file data, never another escape to interpret.
/** @param {unknown} path @returns {string | undefined} */
function checkedPath(path) {
  if (path === undefined) return undefined;
  if (typeof path !== 'string' || !path || path.length > MAX_DWAPP_PATH_BYTES
      || encoder.encode(path).length > MAX_DWAPP_PATH_BYTES
      || path !== path.normalize('NFC') || /[\\?#\p{Cc}\p{Cf}\p{Cs}]/u.test(path)) {
    throw new DwappUriError('Invalid immutable path');
  }
  const segments = path.split('/');
  if (segments.length > MAX_SEGMENTS || segments.some(segment => !segment || segment === '.' || segment === '..'
      || encoder.encode(segment).length > MAX_SEGMENT_BYTES)) {
    throw new DwappUriError('Invalid immutable path segments');
  }
  return path;
}

/** @param {string} segment */
const encodeSegment = segment => encodeURIComponent(segment).replace(/[!'()*]/g,
  char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);

/** @param {DwappAddress} parts */
export function formatDwappUri({ did, hash, path }) {
  if (typeof hash !== 'string' || !HASH_RE.test(hash)) throw new DwappUriError('Manifest hash must be 64 lowercase hex characters');
  const signer = publisher(did);
  const relative = checkedPath(path);
  const result = `${SCHEME}${signer ? `${signer.slice('did:key:'.length)}/` : ''}${hash}${relative === undefined ? '' : `/${relative.split('/').map(encodeSegment).join('/')}`}`;
  if (result.length > MAX_DWAPP_URI_LENGTH) throw new DwappUriError('Immutable URI too long');
  return result;
}

/** @param {string} input @returns {DwappAddress} */
export function parseDwappUri(input) {
  if (typeof input !== 'string' || input.length > MAX_DWAPP_URI_LENGTH || !input.startsWith(SCHEME)
      || /[^\x21-\x7e]|[?#\\]/.test(input)) throw new DwappUriError('Invalid dwapp URI');
  let rest = input.slice(SCHEME.length);
  let did;
  if (rest.startsWith('z')) {
    const slash = rest.indexOf('/');
    if (slash < 0) throw new DwappUriError('Publisher requires a manifest hash');
    did = publisher(`did:key:${rest.slice(0, slash)}`);
    rest = rest.slice(slash + 1);
  }
  const slash = rest.indexOf('/');
  const hash = slash < 0 ? rest : rest.slice(0, slash);
  if (!HASH_RE.test(hash)) throw new DwappUriError('Invalid manifest hash');
  let path;
  if (slash >= 0) {
    const encoded = rest.slice(slash + 1).split('/');
    if (encoded.length > MAX_SEGMENTS) throw new DwappUriError('Too many path segments');
    const decoded = encoded.map(segment => {
      let value;
      try { value = decodeURIComponent(segment); } catch { throw new DwappUriError('Invalid path encoding'); }
      if (value.includes('/')) throw new DwappUriError('Encoded path separator');
      return value;
    });
    path = checkedPath(decoded.join('/'));
  }
  return { did, hash, path };
}

/** @param {string} input */
export const canonicalizeDwappUri = input => formatDwappUri(parseDwappUri(input));

/** @param {string} input */
export const toWebDwappUri = input => HANDOFF_SCHEME + canonicalizeDwappUri(input).slice(SCHEME.length);

/** @param {string} input */
export function fromWebDwappUri(input) {
  if (typeof input !== 'string' || input.length > MAX_DWAPP_URI_LENGTH + 4 || !input.startsWith(HANDOFF_SCHEME)) {
    throw new DwappUriError('Invalid web+dwapp handoff URI');
  }
  return canonicalizeDwappUri(SCHEME + input.slice(HANDOFF_SCHEME.length));
}
