// Test fixtures that fabricate REAL WebAuthn assertion wire shapes with
// WebCrypto keys, genuine signatures over genuine authenticatorData ||
// H(clientDataJSON), so the verifier under test does full cryptographic
// work, not shape checking. The ECDSA path DER-encodes signatures exactly
// as an authenticator would (webauthn-verify.js must convert them back).

const te = new TextEncoder();

export const toB64 = (bytes: Uint8Array) => {
  let s = '';
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s);
};

export const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const toB64Url = (bytes: Uint8Array) =>
  toB64(bytes).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');

export const sha256 = async (bytes: Uint8Array) =>
  new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));

// Raw r||s (WebCrypto output) → ASN.1 DER, the WebAuthn wire encoding.
const derInteger = (value: Uint8Array) => {
  let start = 0;
  while (start < value.length - 1 && value[start] === 0) start++;
  let trimmed = value.slice(start);
  if (trimmed[0] & 0x80) {
    const padded = new Uint8Array(trimmed.length + 1);
    padded.set(trimmed, 1);
    trimmed = padded;
  }
  return Uint8Array.from([0x02, trimmed.length, ...trimmed]);
};

export const ecdsaRawToDer = (raw: Uint8Array) => {
  const r = derInteger(raw.slice(0, 32));
  const s = derInteger(raw.slice(32, 64));
  return Uint8Array.from([0x30, r.length + s.length, ...r, ...s]);
};

export type FabricatedCredential = {
  credentialId: string;
  alg: number;
  publicKeySpki: string;
  sign: (bytes: Uint8Array) => Promise<Uint8Array>; // wire-encoded signature
};

/** A fake passkey: ES256 (DER signatures) or Ed25519 (raw signatures). */
export const fabricateCredential = async (alg: -7 | -8 = -7): Promise<FabricatedCredential> => {
  if (alg === -7) {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
    ) as CryptoKeyPair;
    return {
      credentialId: toB64(crypto.getRandomValues(new Uint8Array(32))),
      alg,
      publicKeySpki: toB64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))),
      sign: async (bytes) => ecdsaRawToDer(new Uint8Array(
        await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, pair.privateKey, bytes as BufferSource),
      )),
    };
  }
  const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']) as CryptoKeyPair;
  return {
    credentialId: toB64(crypto.getRandomValues(new Uint8Array(32))),
    alg,
    publicKeySpki: toB64(new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey))),
    sign: async (bytes) => new Uint8Array(
      await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, bytes as BufferSource),
    ),
  };
};

export const buildAuthenticatorData = async ({
  rpId = 'id.peerd.ai',
  userPresent = true,
  userVerified = true,
  signCount = 7,
}: { rpId?: string; userPresent?: boolean; userVerified?: boolean; signCount?: number } = {}) => {
  const rpIdHash = await sha256(te.encode(rpId));
  const flags = (userPresent ? 0x01 : 0) | (userVerified ? 0x04 : 0);
  const authData = new Uint8Array(37);
  authData.set(rpIdHash, 0);
  authData[32] = flags;
  authData[33] = (signCount >>> 24) & 0xff;
  authData[34] = (signCount >>> 16) & 0xff;
  authData[35] = (signCount >>> 8) & 0xff;
  authData[36] = signCount & 0xff;
  return authData;
};

/** Fabricate a complete wire assertion the way a genuine ceremony would. */
export const fabricateAssertion = async ({
  credential,
  challenge,
  origin = 'https://id.peerd.ai',
  rpId = 'id.peerd.ai',
  type = 'webauthn.get',
  userPresent = true,
  userVerified = true,
  crossOrigin,
}: {
  credential: FabricatedCredential;
  challenge: Uint8Array;
  origin?: string;
  rpId?: string;
  type?: string;
  userPresent?: boolean;
  userVerified?: boolean;
  crossOrigin?: boolean;
}) => {
  const clientData = te.encode(JSON.stringify({
    type,
    challenge: toB64Url(challenge),
    origin,
    ...(crossOrigin !== undefined ? { crossOrigin } : {}),
  }));
  const authData = await buildAuthenticatorData({ rpId, userPresent, userVerified });
  const signedBytes = new Uint8Array(authData.length + 32);
  signedBytes.set(authData, 0);
  signedBytes.set(await sha256(clientData), authData.length);
  return {
    credentialId: credential.credentialId,
    authenticatorData: toB64(authData),
    clientDataJSON: toB64(clientData),
    signature: toB64(await credential.sign(signedBytes)),
  };
};
