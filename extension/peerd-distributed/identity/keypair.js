// @ts-check
// peerd-distributed/identity/keypair.js — Ed25519 identity.
//
// why: every envelope, manifest, and record in the network is signed by
// an Ed25519 identity key (ARCHITECTURE §3.1). Native WebCrypto Ed25519
// ships in Chrome 137+, Safari 17+, Firefox 129+ — no vendored crypto.
//
// Two ways to get an identity:
//   generateIdentity()         — ephemeral (demo pages, tests, throwaway)
//   createPersistentIdentity() — Phase 1: seed lives as a vault secret, so
//                                the did survives restarts and feed
//                                attribution holds. IO is INJECTED (get/
//                                setSecret) per the functional-core rule —
//                                this file never touches the vault itself.
// Portable backup never changes derivation: it encrypts this same random seed
// into a recovery capsule. Future passkey custody remains a design proposal.

import { encodeDidKey, decodeDidKey } from './did.js';
import { toBase64, fromBase64, concat } from '/shared/bundle/bytes.js';

/**
 * A signing identity: the public did, the raw public key, and a sign()
 * closure over a non-extractable private key.
 * @typedef {{
 *   did: string,
 *   publicKey: Uint8Array,
 *   sign: (bytes: Uint8Array) => Promise<Uint8Array>,
 * }} Identity
 */

// An "identity" is the public did plus a sign() closure over a
// non-extractable private key. The private key never leaves this object.
/** @returns {Promise<Identity>} */
export const generateIdentity = async () => {
  const kp = /** @type {CryptoKeyPair} */ (
    await crypto.subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])
  );
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const did = encodeDidKey(pubRaw);
  /** @param {Uint8Array} bytes */
  const sign = async (bytes) =>
    new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, /** @type {BufferSource} */ (bytes)));
  return { did, publicKey: pubRaw, sign };
};

// RFC 5958 PKCS#8 wrapper for a raw Ed25519 seed. WebCrypto exports/imports
// Ed25519 private keys ONLY as PKCS#8; the encoding is this fixed 16-byte
// prefix + the 32-byte seed (48 bytes total), so wrapping by concatenation
// is exact, not a heuristic.
const PKCS8_ED25519_PREFIX = Uint8Array.from([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06,
  0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

export const IDENTITY_SECRET_NAME = 'distributed/identity/v1';

/**
 * Rehydrate an identity from its stored material. The private key is
 * imported non-extractable; the seed bytes passed in are the caller's to
 * zero/forget.
 *
 * @param {{ seed: Uint8Array, publicKey: Uint8Array }} material
 * @returns {Promise<Identity>}
 */
export const importIdentity = async ({ seed, publicKey }) => {
  if (seed.length !== 32) throw new Error('importIdentity: seed must be 32 bytes');
  if (publicKey.length !== 32) throw new Error('importIdentity: public key must be 32 bytes');
  const pkcs8 = concat(PKCS8_ED25519_PREFIX, seed);
  /** @type {CryptoKey} */
  let priv;
  try {
    priv = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
  } finally {
    pkcs8.fill(0);
  }
  const did = encodeDidKey(publicKey);
  /** @param {Uint8Array} bytes */
  const sign = async (bytes) =>
    new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, priv, /** @type {BufferSource} */ (bytes)));
  return { did, publicKey, sign };
};

/**
 * Load (or first-create) the persistent identity MATERIAL: base64 seed +
 * public key + did. The secret value stores BOTH seed and public key —
 * WebCrypto cannot derive an Ed25519 public key from a seed alone, and
 * splitting the pair across stores would make one half's loss
 * unrecoverable.
 *
 * why material and not a live key: the vault lives in the SW, but rooms
 * run in the page that holds them open (the network host). The material
 * crosses ONE extension-internal boundary, once per tab, and is imported
 * non-extractable on arrival — the same trust call as mirroring the
 * vault DK to chrome.storage.session (DECISIONS #7): extension contexts
 * are one trust domain.
 *
 * @param {{
 *   getSecret: (name: string) => Promise<string | null>,
 *   setSecret: (name: string, value: string) => Promise<void>,
 * }} io — the vault's secret surface (or any same-shaped store in tests)
 * @returns {Promise<{ seed: string, pub: string, did: string }>}
 */
export const loadIdentityMaterial = async ({ getSecret, setSecret }) => {
  const stored = await getSecret(IDENTITY_SECRET_NAME);
  if (stored) {
    const { seed, pub } = JSON.parse(stored);
    const did = await assertIdentityMaterial({ seed, pub });
    return { seed, pub, did };
  }
  // First run: mint once and persist. Any later backup exports it only inside
  // the authenticated, passphrase-encrypted recovery capsule.
  const material = await mintKeypairMaterial();
  await setSecret(IDENTITY_SECRET_NAME, JSON.stringify({ v: 1, seed: material.seed, pub: material.pub }));
  return material;
};

/**
 * Mint fresh Ed25519 material: generate EXTRACTABLE exactly once to
 * capture the seed, then hand back base64 material for the caller to
 * persist as the identity secret — the generated
 * handle is dropped, and later use re-imports non-extractable.
 *
 * @returns {Promise<{ seed: string, pub: string, did: string }>}
 */
export const mintKeypairMaterial = async () => {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  /** @type {Uint8Array | null} */
  let seed = null;
  /** @type {Uint8Array | null} */
  let publicKey = null;
  try {
    if (pkcs8.length !== 48) throw new Error(`unexpected Ed25519 PKCS#8 length: ${pkcs8.length}`);
    seed = pkcs8.slice(-32);
    publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    return { seed: toBase64(seed), pub: toBase64(publicKey), did: encodeDidKey(publicKey) };
  } finally {
    // Best-effort lifetime reduction on every exit, including export or
    // encoding failures. The returned base64 owns the only required copies.
    seed?.fill(0);
    publicKey?.fill(0);
    pkcs8.fill(0);
  }
};

/**
 * Rehydrate a signing identity from stored/transferred material.
 * @param {{ seed: string, pub: string }} material
 */
export const identityFromMaterial = async ({ seed, pub }) => {
  const seedBytes = fromBase64(seed);
  try {
    return await importIdentity({ seed: seedBytes, publicKey: fromBase64(pub) });
  } finally {
    // WebCrypto copied the seed into a non-extractable handle; do not leave the
    // decoded transfer buffer live for the rest of this turn.
    seedBytes.fill(0);
  }
};

const MATERIAL_PROOF = new TextEncoder().encode('peerd/identity-material-proof/v1');

/**
 * Prove that independently serialized seed/public-key fields are one Ed25519
 * pair before the material becomes an identity. Merely deriving the advertised
 * did from `pub` would accept a capsule whose signer can never verify under it.
 *
 * @param {{ seed: string, pub: string }} material
 * @returns {Promise<string>} the verified did
 */
export const assertIdentityMaterial = async (material) => {
  if (typeof material?.seed !== 'string' || typeof material?.pub !== 'string') {
    throw new Error('identity material must contain base64 seed and pub');
  }
  const identity = await identityFromMaterial(material);
  const signature = await identity.sign(MATERIAL_PROOF);
  if (!(await verifySignature(identity.did, signature, MATERIAL_PROOF))) {
    throw new Error('identity seed does not match public key');
  }
  return identity.did;
};

/**
 * Load the persistent identity, creating it on first use (the one-context
 * convenience over loadIdentityMaterial + identityFromMaterial).
 * @param {{
 *   getSecret: (name: string) => Promise<string | null>,
 *   setSecret: (name: string, value: string) => Promise<void>,
 * }} io
 */
export const createPersistentIdentity = async (io) =>
  identityFromMaterial(await loadIdentityMaterial(io));

// Import a peer's public key (from their did:key) for verification.
/** @param {Uint8Array} pubkey32 */
export const importVerifyKey = (pubkey32) =>
  crypto.subtle.importKey('raw', /** @type {BufferSource} */ (pubkey32), { name: 'Ed25519' }, true, ['verify']);

// Verify a signature against a did:key. The single primitive every
// inbound-authenticity check funnels through.
/**
 * @param {string} did
 * @param {Uint8Array} signature
 * @param {Uint8Array} bytes
 */
export const verifySignature = async (did, signature, bytes) => {
  const key = await importVerifyKey(decodeDidKey(did));
  return crypto.subtle.verify(
    { name: 'Ed25519' }, key,
    /** @type {BufferSource} */ (signature),
    /** @type {BufferSource} */ (bytes),
  );
};
