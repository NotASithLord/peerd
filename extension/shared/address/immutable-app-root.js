// @ts-check
import { parseDwappUri, formatDwappUri, DwappUriError } from './dwapp-uri.js';

// why: a manual executable address must pin its signer and entire App revision.
// File navigation and unsigned/hash-only inspection need separate user contracts.
/** @param {string} input */
export const immutableAppRoot = (input) => {
  const parts = parseDwappUri(input);
  if (!parts.did) throw new DwappUriError('App addresses must include a publisher key.');
  if (parts.path !== undefined) throw new DwappUriError('File paths are not supported; enter the root App address.');
  return { address: formatDwappUri(parts), publisher: parts.did, hash: parts.hash,
    uri: `peerd://${parts.did}/${parts.hash}` };
};
