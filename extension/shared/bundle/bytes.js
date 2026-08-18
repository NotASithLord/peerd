// @ts-check
// shared/bundle/bytes.js — byte <-> string helpers.
//
// why: every wire format here speaks in Uint8Array (hashes, signatures,
// chunk payloads) but JSON framing and did:key speak in strings. These
// are the conversions, kept pure and dependency-free so the codec is
// identical in Bun (tests) and the browser (runtime). btoa/atob exist in
// both runtimes; we feed them binary strings (one char per byte).
//
// why here and not the dweb module's codec dir: store packages prune the
// dweb module entirely, but artifact export (.peerd files, DESIGN-10)
// rides these same primitives and must work in store packages. The dweb
// module imports FROM here — the legal direction.

/** @param {string} s */
export const utf8 = (s) => new TextEncoder().encode(s);
/** @param {Uint8Array} b */
export const fromUtf8 = (b) => new TextDecoder().decode(b);

/** @param {Uint8Array} b */
export const toHex = (b) =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** @param {string} h */
export const fromHex = (h) => {
  if (h.length % 2 !== 0) throw new Error('fromHex: odd-length string');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

/** @param {Uint8Array} b */
export const toBase64 = (b) => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
};

/** @param {string} s */
export const fromBase64 = (s) => {
  base64ByteLength(s);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

/**
 * Validate canonical base64 and return its exact decoded byte length without
 * allocating the decoded buffer.
 * @param {string} s
 */
export const base64ByteLength = (s) => {
  if (typeof s !== 'string') throw new Error('base64 must be a string');
  const length = s.length;
  if ((length & 3) !== 0) throw new Error('invalid base64');

  let padding = 0;
  if (length && s.charCodeAt(length - 1) === 61) padding += 1; // =
  if (length > 1 && s.charCodeAt(length - 2) === 61) padding += 1;
  const dataLength = length - padding;

  // why a character loop instead of one canonicality regex: V8's regexp
  // engine can overflow its stack on the 8–12 MB source files real dwapps
  // carry. This pass is constant-stack and does not allocate another string.
  let lastValue = 0;
  for (let index = 0; index < dataLength; index++) {
    const code = s.charCodeAt(index);
    let value = -1;
    if (code >= 65 && code <= 90) value = code - 65; // A-Z
    else if (code >= 97 && code <= 122) value = code - 71; // a-z
    else if (code >= 48 && code <= 57) value = code + 4; // 0-9
    else if (code === 43) value = 62; // +
    else if (code === 47) value = 63; // /
    if (value < 0) throw new Error('invalid base64');
    lastValue = value;
  }
  for (let index = dataLength; index < length; index++) {
    if (s.charCodeAt(index) !== 61) throw new Error('invalid base64');
  }
  // Canonical encodings zero the unused bits in the final data sextet. atob()
  // accepts aliases such as AB== and AAB=; refusing them preserves one string
  // representation per byte sequence for hashes and signed bundle metadata.
  if ((padding === 2 && (lastValue & 0x0f) !== 0)
      || (padding === 1 && (lastValue & 0x03) !== 0)) {
    throw new Error('invalid base64');
  }
  return (s.length / 4) * 3 - padding;
};

/** @param {...Uint8Array} arrs */
export const concat = (...arrs) => {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
};

/**
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 */
export const bytesEqual = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
