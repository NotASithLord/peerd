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

export const utf8 = (s) => new TextEncoder().encode(s);
export const fromUtf8 = (b) => new TextDecoder().decode(b);

export const toHex = (b) =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

export const fromHex = (h) => {
  if (h.length % 2 !== 0) throw new Error('fromHex: odd-length string');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
};

export const toBase64 = (b) => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
};

export const fromBase64 = (s) => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

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

export const bytesEqual = (a, b) => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};
