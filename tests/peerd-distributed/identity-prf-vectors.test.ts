// FROZEN derivation vectors for the passkey-PRF wrapper - the
// credential-orphaning lock. These constants are permanent protocol
// state: a change to the PRF input tag, the HKDF salt/info, or the
// AES-KW wrap makes every passkey wrapper ever minted unopenable. If
// one of these assertions fails, the change orphans credentials - do
// not update the expected values; revert the derivation.

import { describe, test, expect } from 'bun:test';
import { identityPrfInput } from '../../extension/peerd-distributed/identity/handoff.js';
import { makePrfWrapper, openPrfWrapper, validateCredentialWrapper } from '../../extension/peerd-distributed/identity/credential-wrapper.js';

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

// SHA-256("peerd.identity.credential.v1") - the input every portable
// credential's PRF is evaluated with, on every machine, forever.
const FROZEN_PRF_INPUT_HEX = '0621b47c1726c9a97a2d213d7122fa68d858d48181c0d60c43ace37fe0cae45b';

// makePrfWrapper(CapK = 32×0x24, prfOutput = 32×0x42) - locks the whole
// chain: HKDF(zero salt, info "peerd/capsule-wrapper/v1") → AES-KW KEK →
// deterministic RFC 3394 wrap of the raw CapK bytes.
const FROZEN_WRAPPED_CAPK_B64 = 'ojw8GNfkkOL8asuk5WIkEtS73Vr10LAq7riNVhqr50eXkvruhwRBMA==';

describe('frozen passkey-PRF derivation vectors', () => {
  test('the PRF input is the frozen 32-byte digest', async () => {
    expect(hex(await identityPrfInput())).toBe(FROZEN_PRF_INPUT_HEX);
  });

  test('PRF output → KEK → wrapped CapK matches the frozen vector exactly', async () => {
    const capK = await crypto.subtle.importKey(
      'raw', new Uint8Array(32).fill(0x24), { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt'],
    );
    const wrapper = await makePrfWrapper(capK, new Uint8Array(32).fill(0x42));
    expect(wrapper.wrappedKey).toBe(FROZEN_WRAPPED_CAPK_B64);
  });

  test('and the frozen wrapper still opens (the vector is live, not a fossil)', async () => {
    const wrapper = {
      kind: 'passkey-prf',
      wrappedKey: FROZEN_WRAPPED_CAPK_B64,
      credentialId: null,
      transports: null,
    };
    const capK = await openPrfWrapper(wrapper, new Uint8Array(32).fill(0x42));
    expect(capK.type).toBe('secret');
    await expect(openPrfWrapper(wrapper, new Uint8Array(32).fill(0x43))).rejects.toThrow();
  });
});

// Untrusted-wrapper bounds for the new kind - same posture as the
// passphrase wrapper's pinned KDF: a hostile record gets no knobs.
describe('passkey-prf wrapper validation', () => {
  const good = {
    kind: 'passkey-prf',
    wrappedKey: FROZEN_WRAPPED_CAPK_B64,
    credentialId: 'Y3JlZA==',
    transports: ['internal', 'hybrid'],
  };

  test('a well-formed wrapper passes; hostile shapes are named', () => {
    expect(validateCredentialWrapper(good)).toBeNull();
    expect(validateCredentialWrapper({ ...good, kdf: { name: 'Argon2id' } })).toBe('unexpected-kdf');
    expect(validateCredentialWrapper({ ...good, wrappedKey: 'AAAA' })).toBe('bad-wrapped-key');
    expect(validateCredentialWrapper({ ...good, credentialId: 'not base64!!' })).toBe('bad-credential-id');
    expect(validateCredentialWrapper({ ...good, credentialId: 'A'.repeat(4096) })).toBe('bad-credential-id');
    expect(validateCredentialWrapper({ ...good, transports: Array(20).fill('usb') })).toBe('bad-transports');
    expect(validateCredentialWrapper({ ...good, transports: [42] })).toBe('bad-transports');
  });
});
