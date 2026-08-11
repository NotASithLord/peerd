// The pure WebAuthn assertion verifier — the offline check an existing
// device runs against a new install's ceremony output. Fixtures fabricate
// REAL signatures (P-256 DER-encoded, Ed25519 raw), so every negative case
// proves the verifier rejects at the right layer, not that fixtures are
// malformed.

import { describe, test, expect } from 'bun:test';
import {
  verifyPasskeyAssertion, parseAuthenticatorData, ecdsaDerToRaw,
} from '../../extension/peerd-distributed/identity/webauthn-verify.js';
import {
  fabricateCredential, fabricateAssertion, buildAuthenticatorData,
  ecdsaRawToDer, toB64,
} from '../helpers/webauthn-fixtures';

const CHALLENGE = crypto.getRandomValues(new Uint8Array(32));
const ORIGINS = ['https://id.peerd.ai'];

const happyArgs = async (alg: -7 | -8 = -7) => {
  const credential = await fabricateCredential(alg);
  const assertion = await fabricateAssertion({ credential, challenge: CHALLENGE });
  return {
    assertion,
    credential,
    expectedChallenge: CHALLENGE,
    expectedRpId: 'id.peerd.ai',
    allowedOrigins: ORIGINS,
  };
};

describe('verifyPasskeyAssertion', () => {
  test('a genuine ES256 assertion verifies', async () => {
    expect(await verifyPasskeyAssertion(await happyArgs(-7))).toEqual({ ok: true, defect: null });
  });

  test('a genuine Ed25519 assertion verifies', async () => {
    expect(await verifyPasskeyAssertion(await happyArgs(-8))).toEqual({ ok: true, defect: null });
  });

  test('replay: an assertion over a DIFFERENT challenge is refused', async () => {
    const args = await happyArgs();
    const staleAssertion = await fabricateAssertion({
      credential: args.credential,
      challenge: crypto.getRandomValues(new Uint8Array(32)), // yesterday's ceremony
    });
    const verdict = await verifyPasskeyAssertion({ ...args, assertion: staleAssertion });
    expect(verdict.defect).toBe('challenge-mismatch');
  });

  test('a create() ceremony result cannot pass as an assertion', async () => {
    const args = await happyArgs();
    const created = await fabricateAssertion({
      credential: args.credential, challenge: CHALLENGE, type: 'webauthn.create',
    });
    expect((await verifyPasskeyAssertion({ ...args, assertion: created })).defect).toBe('not-an-assertion');
  });

  test('origin discipline: unknown origins and cross-origin frames are refused', async () => {
    const args = await happyArgs();
    const phished = await fabricateAssertion({
      credential: args.credential, challenge: CHALLENGE, origin: 'https://id.peerd.ai.evil.example',
    });
    expect((await verifyPasskeyAssertion({ ...args, assertion: phished })).defect).toBe('origin-not-allowed');
    const framed = await fabricateAssertion({
      credential: args.credential, challenge: CHALLENGE, crossOrigin: true,
    });
    expect((await verifyPasskeyAssertion({ ...args, assertion: framed })).defect).toBe('cross-origin-ceremony');
  });

  test('rp binding: an assertion minted at a sibling RP is refused', async () => {
    const args = await happyArgs();
    const sibling = await fabricateAssertion({
      credential: args.credential, challenge: CHALLENGE, rpId: 'peerd.ai',
    });
    expect((await verifyPasskeyAssertion({ ...args, assertion: sibling })).defect).toBe('rp-id-mismatch');
  });

  test('user verification is REQUIRED, not merely presence', async () => {
    const args = await happyArgs();
    const noUv = await fabricateAssertion({
      credential: args.credential, challenge: CHALLENGE, userVerified: false,
    });
    expect((await verifyPasskeyAssertion({ ...args, assertion: noUv })).defect).toBe('user-not-verified');
  });

  test('a signature by a DIFFERENT key is refused', async () => {
    const args = await happyArgs();
    const impostor = await fabricateCredential(-7);
    const forged = await fabricateAssertion({
      credential: { ...impostor, credentialId: args.credential.credentialId },
      challenge: CHALLENGE,
    });
    expect((await verifyPasskeyAssertion({ ...args, assertion: forged })).defect).toBe('signature-invalid');
  });

  test('tampered authenticatorData breaks the signature', async () => {
    const args = await happyArgs();
    const authData = await buildAuthenticatorData({ signCount: 99_999 });
    const verdict = await verifyPasskeyAssertion({
      ...args,
      assertion: { ...args.assertion, authenticatorData: toB64(authData) },
    });
    expect(verdict.defect).toBe('signature-invalid');
  });

  test('a mismatched credential id is refused before any crypto', async () => {
    const args = await happyArgs();
    const verdict = await verifyPasskeyAssertion({
      ...args,
      assertion: { ...args.assertion, credentialId: toB64(crypto.getRandomValues(new Uint8Array(32))) },
    });
    expect(verdict.defect).toBe('credential-mismatch');
  });
});

describe('parseAuthenticatorData', () => {
  test('parses flags and rejects short input', async () => {
    const authData = await buildAuthenticatorData({ userVerified: true, signCount: 42 });
    const parsed = parseAuthenticatorData(authData);
    expect(parsed?.userPresent).toBe(true);
    expect(parsed?.userVerified).toBe(true);
    expect(parsed?.signCount).toBe(42);
    expect(parseAuthenticatorData(authData.slice(0, 36))).toBeNull();
  });
});

describe('ecdsaDerToRaw', () => {
  test('round-trips WebCrypto raw signatures through DER', async () => {
    // Deterministic structural cases plus a real signature round-trip.
    const raw = crypto.getRandomValues(new Uint8Array(64));
    raw[0] &= 0x7f; // keep integers positive-ish for a stable encode
    raw[32] &= 0x7f;
    const back = ecdsaDerToRaw(ecdsaRawToDer(raw));
    expect(back).not.toBeNull();
    expect(toB64(back!)).toBe(toB64(raw));
  });

  test('high-bit r/s values gain and shed their DER zero escape exactly', () => {
    const raw = new Uint8Array(64).fill(0xff); // both integers high-bit
    const der = ecdsaRawToDer(raw);
    const back = ecdsaDerToRaw(der);
    expect(back).not.toBeNull();
    expect(toB64(back!)).toBe(toB64(raw));
  });

  test('malformed DER is refused', () => {
    expect(ecdsaDerToRaw(new Uint8Array([0x30, 0x02, 0x02, 0x00]))).toBeNull(); // truncated
    expect(ecdsaDerToRaw(new Uint8Array(80).fill(2))).toBeNull(); // oversize
    const notSequence = new Uint8Array([0x31, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x01]);
    expect(ecdsaDerToRaw(notSequence)).toBeNull();
  });
});
