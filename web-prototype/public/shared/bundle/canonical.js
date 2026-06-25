// shared/bundle/canonical.js — deterministic JSON for hashing + signing.
//
// why: a content hash (or signature) is only reproducible if both
// parties serialize the object to the SAME bytes. JS object key order is
// not guaranteed across producers, so we canonicalize: recursively sort
// object keys, no insignificant whitespace, UTF-8. This is the JCS
// (RFC 8785) subset we need — our hashed payloads use only objects,
// arrays, strings, booleans, null, and INTEGER numbers (timestamps,
// sizes, version tags). Floats are intentionally unsupported: if one
// appears in a hashed payload that's a bug, and we throw rather than
// commit to something non-reproducible.
//
// why here and not the dweb module's codec dir: the manifest hash IS the
// peerd:// address, and the .peerd export format (DESIGN-10) commits to
// the same hash — exports must work in store packages, which prune the
// dweb module. The dweb imports FROM here.

export const canonicalize = (v) => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(',')}]`;
  const t = typeof v;
  if (t === 'string') return JSON.stringify(v);
  if (t === 'boolean') return v ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(v)) throw new Error('canonicalize: non-finite number');
    if (!Number.isInteger(v)) {
      throw new Error('canonicalize: non-integer number in a signed payload');
    }
    return String(v);
  }
  if (t === 'object') {
    const keys = Object.keys(v).sort();
    const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalize(v[k])}`);
    return `{${parts.join(',')}}`;
  }
  throw new Error(`canonicalize: unsupported type ${t}`);
};
