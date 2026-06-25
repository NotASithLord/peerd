// peerd-distributed/dht/records.js — signed DHT items (BEP-44, PROTOCOL §5).
//
// Every item peerd stores in the DHT has a known signing publisher, so all v1
// items are MUTABLE in BEP-44 terms: keyed by the publisher's pubkey (+ an
// optional ≤64-byte salt so one publisher can address many independent
// pointers), Ed25519-signed, carrying a monotonically increasing `seq` that
// storers MUST NOT downgrade — only upgrade. That seq is the anti-rollback
// rule: an attacker who replays an old signed value can't revert a key.
//
// The value is opaque to the DHT (D-7): a dwapp announcement, a version
// pointer, a provider list — all the same signed bytes here.

import { decodeDidKey } from '../identity/did.js';
import { canonicalize } from '/shared/bundle/canonical.js';
import { utf8, concat, toBase64, fromBase64 } from '/shared/bundle/bytes.js';
import { verifySignature } from '../identity/keypair.js';

const DOMAIN = 'peerd/dht-item/v1';
export const MAX_ITEM_BYTES = 2048; // browser-tuned (BEP-44 is 1000)
export const MAX_SALT_LEN = 64;

const sha256 = async (bytes) => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));

/** The mutable-item key: SHA-256(raw pubkey || utf8(salt)). Verifiable. */
export const mutableKey = (pubkey, salt = '') => sha256(concat(pubkey, utf8(salt)));

/** The key an item claims, derived from its own publisher + salt. */
export const itemKey = (item) => mutableKey(decodeDidKey(item.publisher), item.salt ?? '');

// Signed over a canonical (salt, seq, value) — the three fields a storer must
// trust. The publisher/key are DERIVED from the signer, never trusted as sent.
const signingBytes = (item) =>
  concat(utf8(DOMAIN), Uint8Array.from([0]),
    utf8(canonicalize({ salt: item.salt ?? '', seq: item.seq, v: item.value })));

/** @param {{ value: any, seq: number, salt?: string }} fields */
export const signItem = async ({ value, seq, salt = '' }, identity) => {
  const item = { publisher: identity.did, value, seq, salt };
  const sig = await identity.sign(signingBytes(item));
  return { ...item, sig: toBase64(sig) };
};

/** Structural + size validation that doesn't need crypto (cheap pre-check). */
export const itemWellFormed = (item) => {
  if (!item || typeof item !== 'object') return false;
  if (typeof item.publisher !== 'string' || !item.publisher) return false;
  if (typeof item.seq !== 'number' || !Number.isInteger(item.seq) || item.seq < 0) return false;
  if (typeof item.sig !== 'string' || !item.sig) return false;
  if (item.salt != null && (typeof item.salt !== 'string' || item.salt.length > MAX_SALT_LEN)) return false;
  if (utf8(canonicalize(item.value ?? null)).length > MAX_ITEM_BYTES) return false;
  return true;
};

/** Full validation: well-formed AND the signature verifies against publisher. */
export const verifyItem = async (item) => {
  if (!itemWellFormed(item)) return false;
  try {
    return await verifySignature(item.publisher, fromBase64(item.sig), signingBytes(item));
  } catch {
    return false;
  }
};

// --- provider records (PROTOCOL §5.4, content provider sets) -----------------
//
// A provider record is a node's SELF-SIGNED claim "I serve the bytes at this
// content key". Unlike a mutable item, MANY providers publish under ONE key
// (H(content_addr)); the k-closest nodes aggregate the set. Each entry is signed
// by its own provider, so a holder can serve the set but never forge membership
// (the liability-firewall analogue for the directory). Domain-separated from
// dht-item so a provider claim can't be replayed as a value record.
const PROVIDER_DOMAIN = 'peerd/dht-provider/v1';

const providerBytes = (entry) =>
  concat(utf8(PROVIDER_DOMAIN), Uint8Array.from([0]),
    utf8(canonicalize({ key: entry.key, ts: entry.ts })));

/** @param {{ key: string, ts: number }} fields — key is the hex content key. */
export const signProvider = async ({ key, ts }, identity) => {
  const entry = { key, provider: identity.did, ts };
  const sig = await identity.sign(providerBytes(entry));
  return { ...entry, sig: toBase64(sig) };
};

export const providerWellFormed = (entry) =>
  !!entry && typeof entry === 'object'
  && typeof entry.key === 'string' && entry.key.length > 0 && entry.key.length <= 128
  && typeof entry.provider === 'string' && entry.provider.length > 0
  && typeof entry.ts === 'number' && Number.isFinite(entry.ts)
  && typeof entry.sig === 'string' && entry.sig.length > 0;

export const verifyProvider = async (entry) => {
  if (!providerWellFormed(entry)) return false;
  try {
    return await verifySignature(entry.provider, fromBase64(entry.sig), providerBytes(entry));
  } catch {
    return false;
  }
};
