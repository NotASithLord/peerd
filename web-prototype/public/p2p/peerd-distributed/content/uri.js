// peerd-distributed/content/uri.js — peerd:// parse/format (PROTOCOL §4.1).
//
//   peerd://<did>/<content_hash>[/<path>]   authored (signed by publisher)
//   peerd://<content_hash>[/<path>]         pure content-addressed
//
// content_hash is the 64-hex SHA-256 of the manifest. why: the did
// contains colons ("did:key:z…") so we can't naively split on ':'; we
// detect the "did:" prefix explicitly, then the first '/'.

const SCHEME = 'peerd://';
const HASH_RE = /^[0-9a-f]{64}$/;

export const formatPeerdUri = ({ did, hash, path } = {}) => {
  if (!hash || !HASH_RE.test(hash)) {
    throw new Error('formatPeerdUri: hash must be 64 lowercase hex chars');
  }
  let uri = SCHEME;
  if (did) uri += `${did}/`;
  uri += hash;
  if (path) uri += `/${path}`;
  return uri;
};

export const parsePeerdUri = (s) => {
  if (typeof s !== 'string' || !s.startsWith(SCHEME)) {
    throw new Error('parsePeerdUri: not a peerd:// URI');
  }
  let rest = s.slice(SCHEME.length);
  let did;
  if (rest.startsWith('did:')) {
    const slash = rest.indexOf('/');
    if (slash < 0) throw new Error('parsePeerdUri: did present but no content hash');
    did = rest.slice(0, slash);
    rest = rest.slice(slash + 1);
  }
  const parts = rest.split('/');
  const hash = parts.shift();
  if (!HASH_RE.test(hash)) {
    throw new Error('parsePeerdUri: invalid content hash');
  }
  const path = parts.length ? parts.join('/') : undefined;
  return { did, hash, path };
};
