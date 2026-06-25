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
// The PRF-derived seed (HKDF over the passkey PRF output) remains Phase 3
// (NORTH-STAR D-6); the vault-random seed below is its documented fallback
// and stores under the same secret name, so the upgrade is a derivation
// change, not a migration.

import { encodeDidKey, decodeDidKey } from './did.js';
import { toBase64, fromBase64, concat } from '/shared/bundle/bytes.js';

// An "identity" is the public did plus a sign() closure over a
// non-extractable private key. The private key never leaves this object.
export const generateIdentity = async () => {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
    'sign',
    'verify',
  ]);
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const did = encodeDidKey(pubRaw);
  const sign = async (bytes) =>
    new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, bytes));
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

const SECRET_NAME = 'distributed/identity/v1';

/**
 * Rehydrate an identity from its stored material. The private key is
 * imported non-extractable; the seed bytes passed in are the caller's to
 * zero/forget.
 *
 * @param {{ seed: Uint8Array, publicKey: Uint8Array }} material
 */
export const importIdentity = async ({ seed, publicKey }) => {
  if (seed.length !== 32) throw new Error('importIdentity: seed must be 32 bytes');
  const priv = await crypto.subtle.importKey(
    'pkcs8',
    concat(PKCS8_ED25519_PREFIX, seed),
    { name: 'Ed25519' },
    false,
    ['sign'],
  );
  const did = encodeDidKey(publicKey);
  const sign = async (bytes) =>
    new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, priv, bytes));
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
  const stored = await getSecret(SECRET_NAME);
  if (stored) {
    const { seed, pub } = JSON.parse(stored);
    return { seed, pub, did: encodeDidKey(fromBase64(pub)) };
  }
  // First run: generate EXTRACTABLE once to capture the seed, persist,
  // and never export again.
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  if (pkcs8.length !== 48) throw new Error(`unexpected Ed25519 PKCS#8 length: ${pkcs8.length}`);
  const seed = pkcs8.slice(-32);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  await setSecret(SECRET_NAME, JSON.stringify({ v: 1, seed: toBase64(seed), pub: toBase64(publicKey) }));
  return { seed: toBase64(seed), pub: toBase64(publicKey), did: encodeDidKey(publicKey) };
};

/** Rehydrate a signing identity from stored/transferred material. */
export const identityFromMaterial = ({ seed, pub }) =>
  importIdentity({ seed: fromBase64(seed), publicKey: fromBase64(pub) });

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
export const importVerifyKey = (pubkey32) =>
  crypto.subtle.importKey('raw', pubkey32, { name: 'Ed25519' }, true, ['verify']);

// Verify a signature against a did:key. The single primitive every
// inbound-authenticity check funnels through.
export const verifySignature = async (did, signature, bytes) => {
  const key = await importVerifyKey(decodeDidKey(did));
  return crypto.subtle.verify({ name: 'Ed25519' }, key, signature, bytes);
};
