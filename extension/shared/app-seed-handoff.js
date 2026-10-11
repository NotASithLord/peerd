// @ts-check
// One signed representation crosses the verified dweb-to-storage boundary.

import { base64ByteLength, fromBase64, toBase64 } from './bundle/bytes.js';
import { MAX_NETWORK_BUNDLE_BYTES } from './bundle/bundle.js';
import { manifestHash, verifyManifestChunks } from './bundle/manifest.js';
import { chunkBytes } from './bundle/chunk.js';
import { unpackTransportBundle } from './bundle/transport.js';

/** @param {any} app @param {any} manifest @param {Uint8Array} payload */
export const appSeedHandoff = (app, manifest, payload) => {
  const metadata = { ...app };
  // why: Sending decoded files plus the original signed payload in one Chrome
  // runtime message exceeds its wire limit for otherwise supported Apps.
  delete metadata.files;
  delete metadata.fileKinds;
  delete metadata.entryFile;
  return { ...metadata, seedBundle: { manifest, payload: toBase64(payload) } };
};

/** Runs in the isolated artifact codec after the kernel admits the exact
 * offscreen sender and publication custody.
 * Authorship was verified by the dweb host. Recheck its content commitment here
 * before storage effects; signing remains inside the distributed module.
 * @param {any} seedBundle @param {any} dweb
 */
export const decodeAppSeedHandoff = async (seedBundle, dweb) => {
  const { manifest, payload: encoded } = seedBundle ?? {};
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
      || typeof encoded !== 'string'
      || encoded.length > 4 * Math.ceil(MAX_NETWORK_BUNDLE_BYTES / 3)
      || base64ByteLength(encoded) > MAX_NETWORK_BUNDLE_BYTES
      || ![1, 2].includes(manifest.v) || manifest.type !== 'app'
      || typeof manifest.sig !== 'string' || !manifest.sig
      || typeof dweb?.publisher !== 'string' || manifest.publisher !== dweb.publisher
      || typeof dweb?.hash !== 'string'
      || new TextEncoder().encode(JSON.stringify(manifest)).byteLength > 256_000) {
    throw new Error('dweb-seed-bundle-invalid');
  }
  if (await manifestHash(manifest) !== dweb.hash) throw new Error('dweb-seed-hash-mismatch');
  const payload = fromBase64(encoded);
  const verified = await verifyManifestChunks(manifest, chunkBytes(payload));
  if (!verified.ok) throw new Error('dweb-seed-payload-invalid');
  const { entry, files, fileKinds } = await unpackTransportBundle({ manifest, payload, limits: {
    maxDecodedBytes: 50_000_000, maxFileBytes: 50_000_000, maxFiles: 256, maxPathChars: 512,
  } });
  if (!entry || !Object.hasOwn(files, entry)) throw new Error('dweb-seed-entry-missing');
  return { entryFile: entry, files, fileKinds };
};
