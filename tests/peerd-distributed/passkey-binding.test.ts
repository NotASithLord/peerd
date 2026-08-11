// The passkey binding record — the root-signed statement that makes a
// WebAuthn credential an enrollment authority for a did. Forgery, rollback,
// and revocation-laundering must all fail; lifecycle changes (add / revoke /
// rotate) must never change the did.

import { describe, test, expect } from 'bun:test';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import {
  buildPasskeyBinding, validatePasskeyBinding, verifyPasskeyBinding,
  bindingSupersedes, activeBindingCredential,
  CANONICAL_RP_ID, MAX_BINDING_CREDENTIALS,
} from '../../extension/peerd-distributed/identity/passkey-binding.js';
import { fabricateCredential } from '../helpers/webauthn-fixtures';

const bindingCredential = async (status: 'active' | 'revoked' = 'active') => {
  const fabricated = await fabricateCredential(-7);
  return {
    credentialId: fabricated.credentialId,
    alg: fabricated.alg,
    publicKeySpki: fabricated.publicKeySpki,
    addedAt: 1_700_000_000_000,
    status,
  };
};

describe('passkey binding record', () => {
  test('build → verify round-trip; defaults to the canonical RP id', async () => {
    const person = await generateIdentity();
    const credential = await bindingCredential();
    const binding = await buildPasskeyBinding({
      personIdentity: person, credentials: [credential], seq: 1,
    });
    expect(binding.rpId).toBe(CANONICAL_RP_ID);
    expect(binding.personDid).toBe(person.did);
    expect(validatePasskeyBinding(binding)).toBeNull();
    expect((await verifyPasskeyBinding(binding, { expectedPersonDid: person.did })).ok).toBe(true);
  });

  test('a binding claiming a DIFFERENT person fails signature verification', async () => {
    const person = await generateIdentity();
    const victim = await generateIdentity();
    const binding = await buildPasskeyBinding({
      personIdentity: person, credentials: [await bindingCredential()], seq: 1,
    });
    // Attacker re-labels their own signed binding as the victim's.
    const forged = { ...binding, personDid: victim.did };
    const verdict = await verifyPasskeyBinding(forged, { expectedPersonDid: victim.did });
    expect(verdict.ok).toBe(false);
    expect(verdict.defect).toBe('signature-invalid');
  });

  test('credential swaps and revocation laundering invalidate the signature', async () => {
    const person = await generateIdentity();
    const enrolled = await bindingCredential('revoked');
    const binding = await buildPasskeyBinding({
      personIdentity: person, credentials: [enrolled], seq: 2,
    });
    const attacker = await bindingCredential();
    for (const credentials of [
      [{ ...enrolled, status: 'active' as const }],          // un-revoke
      [{ ...enrolled, publicKeySpki: attacker.publicKeySpki }], // key swap
      [...binding.credentials, attacker],                     // append authority
    ]) {
      const verdict = await verifyPasskeyBinding({ ...binding, credentials });
      expect(verdict.ok).toBe(false);
      expect(verdict.defect).toBe('signature-invalid');
    }
  });

  test('lifecycle: add / revoke / rotate are new snapshots under the SAME did', async () => {
    const person = await generateIdentity();
    const first = await bindingCredential();
    const v1 = await buildPasskeyBinding({ personIdentity: person, credentials: [first], seq: 1 });
    const second = await bindingCredential();
    const v2 = await buildPasskeyBinding({
      personIdentity: person,
      credentials: [{ ...first, status: 'revoked' }, second],
      seq: 2,
    });
    expect(v2.personDid).toBe(v1.personDid); // the did never changes
    expect(bindingSupersedes(v2, v1)).toBe(true);
    expect(bindingSupersedes(v1, v2)).toBe(false); // rollback refused
    expect(bindingSupersedes(v1, v1)).toBe(false); // equal seq is a fork
    expect(activeBindingCredential(v2, first.credentialId)).toBeNull(); // revoked ≡ never enrolled
    expect(activeBindingCredential(v2, second.credentialId)).not.toBeNull();
    expect(activeBindingCredential(v2, 'bm90LWVucm9sbGVk')).toBeNull(); // unknown
  });

  test('bounds: credential count, algs, field shapes', async () => {
    const person = await generateIdentity();
    const credential = await bindingCredential();
    const binding = await buildPasskeyBinding({
      personIdentity: person, credentials: [credential], seq: 1,
    });
    expect(validatePasskeyBinding({
      ...binding,
      credentials: Array.from({ length: MAX_BINDING_CREDENTIALS + 1 }, () => credential),
    })).toBe('bad-credentials');
    expect(validatePasskeyBinding({
      ...binding, credentials: [credential, credential],
    })).toBe('duplicate-credential');
    expect(validatePasskeyBinding({
      ...binding, credentials: [{ ...credential, alg: -35 }],
    })).toBe('bad-credential-alg');
    expect(validatePasskeyBinding({
      ...binding, credentials: [{ ...credential, publicKeySpki: 'not base64!!' }],
    })).toBe('bad-credential-key');
    expect(validatePasskeyBinding({ ...binding, rpId: '' })).toBe('bad-rp-id');
    expect(validatePasskeyBinding({ ...binding, seq: 0 })).toBe('bad-seq');
  });
});
