// The new-device enrollment exchange, end to end over fabricated (but
// cryptographically real) passkey ceremonies. The happy path proves a fresh
// install can become the person; the adversarial paths prove each of the
// issue's §13 invariants at the exact layer that owns it: possession-MAC
// gating, assertion freshness, ephemeral-key channel binding, grant
// exchange binding, and the enrollee's identity-chain verification against
// a hostile sponsor.

import { describe, test, expect } from 'bun:test';
import { generateIdentity, mintKeypairMaterial } from '../../extension/peerd-distributed/identity/keypair.js';
import { buildPasskeyBinding } from '../../extension/peerd-distributed/identity/passkey-binding.js';
import { buildDeviceRoster } from '../../extension/peerd-distributed/identity/device-certificate.js';
import {
  deriveEnrollSecrets, buildEnrollRequest, evaluateEnrollRequest,
  buildEnrollChallenge, enrollCeremonyChallenge, buildEnrollProof,
  evaluateEnrollProof, sealEnrollmentGrant, openEnrollmentGrant,
  mintEnrollmentKeyPair, exportEnrollmentPublicKey,
} from '../../extension/peerd-distributed/self/enroll.js';
import { mintDiscoverySecret } from '../../extension/peerd-distributed/self/rendezvous.js';
import { identityFromMaterial } from '../../extension/peerd-distributed/identity/keypair.js';
import { fabricateCredential, fabricateAssertion, toB64 } from '../helpers/webauthn-fixtures';

const ORIGINS = ['https://id.peerd.ai'];

// A person with one existing (sponsor) device, a bound passkey, and the
// discovery secret: the state Device A is in before Device B appears.
const sponsorSetup = async () => {
  const material = await mintKeypairMaterial();
  const person = await identityFromMaterial(material);
  const passkey = await fabricateCredential(-7);
  const binding = await buildPasskeyBinding({
    personIdentity: person,
    credentials: [{
      credentialId: passkey.credentialId, alg: passkey.alg,
      publicKeySpki: passkey.publicKeySpki, addedAt: 1, status: 'active' as const,
    }],
    seq: 1,
  });
  const sponsorDevice = await generateIdentity();
  const roster = await buildDeviceRoster({
    personIdentity: person,
    devices: [{ deviceDid: sponsorDevice.did, deviceId: 'desktop-1', addedAt: 1, status: 'active' as const }],
    seq: 1,
  });
  const prfOutput = crypto.getRandomValues(new Uint8Array(32));
  const secrets = await deriveEnrollSecrets(prfOutput);
  return {
    material, person, passkey, binding, roster,
    discoverySecret: mintDiscoverySecret(),
    prfOutput, secrets,
  };
};

// Drive the full protocol between an honest sponsor and an honest enrollee.
const runEnrollment = async (setup: Awaited<ReturnType<typeof sponsorSetup>>) => {
  // Enrollee: ceremony #1 derived the same secrets (same passkey PRF).
  const enrolleeSecrets = await deriveEnrollSecrets(setup.prfOutput);
  const enrolleePair = await mintEnrollmentKeyPair();
  const enrolleeKey = await exportEnrollmentPublicKey(enrolleePair.publicKey);

  const request = await buildEnrollRequest({
    macKey: enrolleeSecrets.macKey,
    credentialId: setup.passkey.credentialId,
    ephemeralKey: enrolleeKey,
  });
  const admitted = await evaluateEnrollRequest(request, {
    macKey: setup.secrets.macKey, binding: setup.binding,
  });
  if (!admitted.ok) return { admitted, verdict: null, outcome: null };

  const challenge = buildEnrollChallenge();
  // Enrollee: ceremony #2 asserts over the channel-bound challenge.
  const ceremonyChallenge = await enrollCeremonyChallenge(challenge.challenge, enrolleeKey);
  const assertion = await fabricateAssertion({ credential: setup.passkey, challenge: ceremonyChallenge });
  const proof = buildEnrollProof({ assertion, ephemeralKey: enrolleeKey });

  const verdict = await evaluateEnrollProof(proof, {
    binding: setup.binding,
    issuedChallenge: challenge.challenge,
    requestEphemeralKey: request.ephemeralKey,
    allowedOrigins: ORIGINS,
  });
  if (!verdict.ok) return { admitted, verdict, outcome: null };

  const grant = await sealEnrollmentGrant({
    payload: {
      v: 1,
      material: { seed: setup.material.seed, pub: setup.material.pub },
      discoverySecret: toB64(setup.discoverySecret),
      passkeyBinding: setup.binding,
      deviceRoster: setup.roster,
    },
    enrolleeKey,
    issuedChallenge: challenge.challenge,
    credentialId: setup.passkey.credentialId,
  });
  const outcome = await openEnrollmentGrant(grant, {
    enrolleePrivateKey: enrolleePair.privateKey,
    enrolleeKey,
    issuedChallenge: challenge.challenge,
    credentialId: setup.passkey.credentialId,
  });
  return { admitted, verdict, outcome, grant, challenge, enrolleePair, enrolleeKey };
};

describe('enrollment protocol', () => {
  test('happy path: a fresh install becomes the person, with the full chain verified', async () => {
    const setup = await sponsorSetup();
    const { admitted, verdict, outcome } = await runEnrollment(setup);
    expect(admitted.ok).toBe(true);
    expect(verdict?.ok).toBe(true);
    expect(outcome?.ok).toBe(true);
    expect(outcome?.did).toBe(setup.person.did);
    expect(outcome?.payload?.material.seed).toBe(setup.material.seed);
    expect(outcome?.payload?.discoverySecret).toBe(toB64(setup.discoverySecret));
  });

  test('a stranger on the topic cannot even obtain a challenge (possession MAC)', async () => {
    const setup = await sponsorSetup();
    const strangerSecrets = await deriveEnrollSecrets(crypto.getRandomValues(new Uint8Array(32)));
    const pair = await mintEnrollmentKeyPair();
    const request = await buildEnrollRequest({
      macKey: strangerSecrets.macKey,
      credentialId: setup.passkey.credentialId, // even knowing the credential id
      ephemeralKey: await exportEnrollmentPublicKey(pair.publicKey),
    });
    const admitted = await evaluateEnrollRequest(request, {
      macKey: setup.secrets.macKey, binding: setup.binding,
    });
    expect(admitted.ok).toBe(false);
    expect(admitted.defect).toBe('mac-mismatch');
  });

  test('a revoked credential is refused at request time', async () => {
    const setup = await sponsorSetup();
    const revokedBinding = await buildPasskeyBinding({
      personIdentity: setup.person,
      credentials: [{ ...setup.binding.credentials[0], status: 'revoked' as const }],
      seq: 2,
    });
    const pair = await mintEnrollmentKeyPair();
    const request = await buildEnrollRequest({
      macKey: setup.secrets.macKey,
      credentialId: setup.passkey.credentialId,
      ephemeralKey: await exportEnrollmentPublicKey(pair.publicKey),
    });
    const admitted = await evaluateEnrollRequest(request, {
      macKey: setup.secrets.macKey, binding: revokedBinding,
    });
    expect(admitted.defect).toBe('unknown-credential');
  });

  test('channel binding: swapping the ephemeral key invalidates the assertion', async () => {
    const setup = await sponsorSetup();
    const enrolleePair = await mintEnrollmentKeyPair();
    const enrolleeKey = await exportEnrollmentPublicKey(enrolleePair.publicKey);
    const challenge = buildEnrollChallenge();
    const ceremonyChallenge = await enrollCeremonyChallenge(challenge.challenge, enrolleeKey);
    const assertion = await fabricateAssertion({ credential: setup.passkey, challenge: ceremonyChallenge });

    // A relay substitutes ITS key while forwarding the genuine assertion.
    const mitmPair = await mintEnrollmentKeyPair();
    const mitmKey = await exportEnrollmentPublicKey(mitmPair.publicKey);
    const spliced = buildEnrollProof({ assertion, ephemeralKey: mitmKey });
    // Case 1: sponsor pins the request's key, splice detected structurally.
    expect((await evaluateEnrollProof(spliced, {
      binding: setup.binding,
      issuedChallenge: challenge.challenge,
      requestEphemeralKey: enrolleeKey,
      allowedOrigins: ORIGINS,
    })).defect).toBe('ephemeral-key-mismatch');
    // Case 2: the relay also forged the original request around its own key
    // then the recomputed ceremony challenge no longer matches the assertion.
    const verdict = await evaluateEnrollProof(spliced, {
      binding: setup.binding,
      issuedChallenge: challenge.challenge,
      requestEphemeralKey: mitmKey,
      allowedOrigins: ORIGINS,
    });
    expect(verdict.defect).toBe('assertion-challenge-mismatch');
  });

  test('replay: an assertion for an old challenge fails against a fresh one', async () => {
    const setup = await sponsorSetup();
    const enrolleePair = await mintEnrollmentKeyPair();
    const enrolleeKey = await exportEnrollmentPublicKey(enrolleePair.publicKey);
    const oldChallenge = buildEnrollChallenge();
    const recorded = await fabricateAssertion({
      credential: setup.passkey,
      challenge: await enrollCeremonyChallenge(oldChallenge.challenge, enrolleeKey),
    });
    const freshChallenge = buildEnrollChallenge();
    const verdict = await evaluateEnrollProof(buildEnrollProof({ assertion: recorded, ephemeralKey: enrolleeKey }), {
      binding: setup.binding,
      issuedChallenge: freshChallenge.challenge,
      requestEphemeralKey: enrolleeKey,
      allowedOrigins: ORIGINS,
    });
    expect(verdict.defect).toBe('assertion-challenge-mismatch');
  });

  test('a recorded grant is undecryptable in any other exchange', async () => {
    const setup = await sponsorSetup();
    const run = await runEnrollment(setup);
    expect(run.outcome?.ok).toBe(true);
    // The same grant, replayed into a NEW exchange (fresh key + challenge):
    const freshPair = await mintEnrollmentKeyPair();
    const freshKey = await exportEnrollmentPublicKey(freshPair.publicKey);
    const replayed = await openEnrollmentGrant(run.grant, {
      enrolleePrivateKey: freshPair.privateKey,
      enrolleeKey: freshKey,
      issuedChallenge: buildEnrollChallenge().challenge,
      credentialId: setup.passkey.credentialId,
    });
    expect(replayed.ok).toBe(false);
    expect(replayed.defect).toBe('open-failed');
    // Even the ORIGINAL private key cannot open it under a different
    // claimed challenge: the KDF salt commits to the transcript.
    const wrongTranscript = await openEnrollmentGrant(run.grant, {
      enrolleePrivateKey: run.enrolleePair!.privateKey,
      enrolleeKey: run.enrolleeKey!,
      issuedChallenge: buildEnrollChallenge().challenge,
      credentialId: setup.passkey.credentialId,
    });
    expect(wrongTranscript.ok).toBe(false);
  });

  test('a hostile sponsor cannot substitute a different identity (chain refuses)', async () => {
    const setup = await sponsorSetup();
    const enrolleePair = await mintEnrollmentKeyPair();
    const enrolleeKey = await exportEnrollmentPublicKey(enrolleePair.publicKey);
    const challenge = buildEnrollChallenge();

    // The attacker controls their own root + roster, but NOT the passkey
    // binding for the enrollee's credential under their root, they can
    // only ship the victim's binding (wrong did) or their own (wrong
    // credential set).
    const attackerMaterial = await mintKeypairMaterial();
    const attackerPerson = await identityFromMaterial(attackerMaterial);
    const attackerDevice = await generateIdentity();
    const attackerRoster = await buildDeviceRoster({
      personIdentity: attackerPerson,
      devices: [{ deviceDid: attackerDevice.did, deviceId: 'evil-1', addedAt: 1, status: 'active' as const }],
      seq: 1,
    });

    // Variant 1: attacker identity + the VICTIM's binding record.
    const grantWithVictimBinding = await sealEnrollmentGrant({
      payload: {
        v: 1,
        material: { seed: attackerMaterial.seed, pub: attackerMaterial.pub },
        discoverySecret: toB64(mintDiscoverySecret()),
        passkeyBinding: setup.binding,
        deviceRoster: attackerRoster,
      },
      enrolleeKey,
      issuedChallenge: challenge.challenge,
      credentialId: setup.passkey.credentialId,
    });
    const verdict1 = await openEnrollmentGrant(grantWithVictimBinding, {
      enrolleePrivateKey: enrolleePair.privateKey,
      enrolleeKey,
      issuedChallenge: challenge.challenge,
      credentialId: setup.passkey.credentialId,
    });
    expect(verdict1.ok).toBe(false);
    expect(verdict1.defect).toBe('binding-person-did-mismatch');

    // Variant 2: attacker identity + a binding the attacker signed
    // themselves, verifies under their did, but cannot contain the
    // enrollee's credential as ACTIVE unless they enrolled it… in which
    // case they'd bind THEIR identity to the user's passkey. Try an empty
    // credential set:
    const attackerBinding = await buildPasskeyBinding({
      personIdentity: attackerPerson, credentials: [], seq: 1,
    });
    const grantWithAttackerBinding = await sealEnrollmentGrant({
      payload: {
        v: 1,
        material: { seed: attackerMaterial.seed, pub: attackerMaterial.pub },
        discoverySecret: toB64(mintDiscoverySecret()),
        passkeyBinding: attackerBinding,
        deviceRoster: attackerRoster,
      },
      enrolleeKey,
      issuedChallenge: challenge.challenge,
      credentialId: setup.passkey.credentialId,
    });
    const verdict2 = await openEnrollmentGrant(grantWithAttackerBinding, {
      enrolleePrivateKey: enrolleePair.privateKey,
      enrolleeKey,
      issuedChallenge: challenge.challenge,
      credentialId: setup.passkey.credentialId,
    });
    expect(verdict2.ok).toBe(false);
    expect(verdict2.defect).toBe('credential-not-bound');
  });

  test('a tampered grant payload fails AES-GCM authentication', async () => {
    const setup = await sponsorSetup();
    const run = await runEnrollment(setup);
    const tampered = { ...run.grant, ct: `${run.grant!.ct.slice(0, -4)}AAAA` };
    const verdict = await openEnrollmentGrant(tampered, {
      enrolleePrivateKey: run.enrolleePair!.privateKey,
      enrolleeKey: run.enrolleeKey!,
      issuedChallenge: run.challenge!.challenge,
      credentialId: setup.passkey.credentialId,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.defect).toBe('open-failed');
  });

  test('the grant payload never carries a device private key', async () => {
    const setup = await sponsorSetup();
    const { outcome } = await runEnrollment(setup);
    expect(outcome?.ok).toBe(true);
    const keys = Object.keys(outcome!.payload!);
    expect(keys.sort()).toEqual(['deviceRoster', 'discoverySecret', 'material', 'passkeyBinding', 'v']);
  });

  test('PRF-derived secrets are purpose-separated and sized', async () => {
    const prf = crypto.getRandomValues(new Uint8Array(32));
    const { topicSecret, macKey } = await deriveEnrollSecrets(prf);
    expect(topicSecret.length).toBe(32);
    expect(macKey.length).toBe(32);
    expect(toB64(topicSecret)).not.toBe(toB64(macKey));
    await expect(deriveEnrollSecrets(new Uint8Array(16))).rejects.toThrow(/32 bytes/);
  });
});
