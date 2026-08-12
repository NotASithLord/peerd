// The new-device enrollment exchange, end to end over fabricated (but
// cryptographically real) passkey ceremonies. The happy path proves a fresh
// install can become the person; the adversarial paths prove each of the
// issue's §13 invariants at the exact layer that owns it: possession-MAC
// gating, assertion freshness, ephemeral-key channel binding, grant
// exchange binding, and the enrollee's identity-chain verification against
// a hostile sponsor.

import { describe, test, expect } from 'bun:test';
import { generateIdentity, mintKeypairMaterial } from '../../extension/peerd-distributed/identity/keypair.js';
import {
  buildPasskeyBinding, validatePasskeyBinding,
} from '../../extension/peerd-distributed/identity/passkey-binding.js';
import { buildDeviceRoster } from '../../extension/peerd-distributed/identity/device-certificate.js';
import {
  deriveEnrollSecrets, deriveEnrollIdentityCommitment,
  buildEnrollRequest, evaluateEnrollRequest,
  buildEnrollChallenge, enrollCeremonyChallenge, buildEnrollProof,
  evaluateEnrollProof, sealEnrollmentGrant, openEnrollmentGrant,
  mintEnrollmentKeyPair, exportEnrollmentPublicKey,
} from '../../extension/peerd-distributed/self/enroll.js';
import { mintDiscoverySecret } from '../../extension/peerd-distributed/self/rendezvous.js';
import { issueEnrolledDeviceRecords } from '../../extension/peerd-distributed/self/custody.js';
import { identityFromMaterial } from '../../extension/peerd-distributed/identity/keypair.js';
import { fabricateCredential, fabricateAssertion, toB64 } from '../helpers/webauthn-fixtures';

const ORIGINS = ['https://id.peerd.ai'];

// A person with one existing (sponsor) device, a bound passkey, and the
// discovery secret: the state Device A is in before Device B appears.
const sponsorSetup = async () => {
  const material = await mintKeypairMaterial();
  const person = await identityFromMaterial(material);
  const passkey = await fabricateCredential(-7);
  const prfOutput = crypto.getRandomValues(new Uint8Array(32));
  const identityCommitment = await deriveEnrollIdentityCommitment(prfOutput, {
    personDid: person.did,
    credentialId: passkey.credentialId,
    alg: passkey.alg,
    publicKeySpki: passkey.publicKeySpki,
  });
  const binding = await buildPasskeyBinding({
    personIdentity: person,
    credentials: [{
      credentialId: passkey.credentialId, alg: passkey.alg,
      publicKeySpki: passkey.publicKeySpki, identityCommitment,
      addedAt: 1, status: 'active' as const,
    }],
    seq: 1,
  });
  const sponsorDevice = await generateIdentity();
  const roster = await buildDeviceRoster({
    personIdentity: person,
    devices: [{ deviceDid: sponsorDevice.did, deviceId: 'desktop-1', addedAt: 1, status: 'active' as const }],
    seq: 1,
  });
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
  const enrolleeDevice = await generateIdentity();
  const enrolleeDeviceId = 'laptop-1';

  const request = await buildEnrollRequest({
    macKey: enrolleeSecrets.macKey,
    credentialId: setup.passkey.credentialId,
    ephemeralKey: enrolleeKey,
    deviceDid: enrolleeDevice.did,
    deviceId: enrolleeDeviceId,
  });
  const admitted = await evaluateEnrollRequest(request, {
    macKey: setup.secrets.macKey, binding: setup.binding,
  });
  if (!admitted.ok) return { admitted, verdict: null, outcome: null };

  const challenge = buildEnrollChallenge();
  // Enrollee: ceremony #2 asserts over the channel-bound challenge.
  const ceremonyChallenge = await enrollCeremonyChallenge(
    challenge.challenge, enrolleeKey, enrolleeDevice.did,
  );
  const assertion = await fabricateAssertion({ credential: setup.passkey, challenge: ceremonyChallenge });
  const proof = buildEnrollProof({
    assertion, ephemeralKey: enrolleeKey, deviceDid: enrolleeDevice.did,
  });

  const verdict = await evaluateEnrollProof(proof, {
    binding: setup.binding,
    issuedChallenge: challenge.challenge,
    requestEphemeralKey: request.ephemeralKey,
    requestDeviceDid: request.deviceDid,
    allowedOrigins: ORIGINS,
  });
  if (!verdict.ok) return { admitted, verdict, outcome: null };

  const issued = await issueEnrolledDeviceRecords({
    personIdentity: setup.person, priorRoster: setup.roster,
    deviceDid: enrolleeDevice.did, deviceId: enrolleeDeviceId, label: 'Laptop', now: 2,
  });

  const grant = await sealEnrollmentGrant({
    payload: {
      v: 1,
      personDid: setup.person.did,
      deviceCertificate: issued.certificate,
      discoverySecret: toB64(setup.discoverySecret),
      passkeyBinding: setup.binding,
      deviceRoster: issued.roster,
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
    prfOutput: setup.prfOutput,
    expectedDeviceDid: enrolleeDevice.did,
    expectedDeviceId: enrolleeDeviceId,
  });
  return {
    admitted, verdict, outcome, grant, challenge, enrolleePair, enrolleeKey,
    enrolleeDevice, enrolleeDeviceId, issued,
  };
};

describe('enrollment protocol', () => {
  test('the verifier rejects a root-signed binding for any non-canonical RP', async () => {
    const setup = await sponsorSetup();
    expect(validatePasskeyBinding({
      ...setup.binding, rpId: 'peerd.ai',
    })).toBe('non-canonical-rp-id');
  });

  test('happy path: a fresh install becomes the person, with the full chain verified', async () => {
    const setup = await sponsorSetup();
    const run = await runEnrollment(setup);
    expect(run.admitted.ok).toBe(true);
    expect(run.verdict?.ok).toBe(true);
    expect(run.outcome?.ok).toBe(true);
    expect(run.outcome?.did).toBe(setup.person.did);
    expect(run.outcome?.payload).not.toHaveProperty('material');
    expect(run.outcome?.payload?.deviceCertificate.deviceDid).toBe(run.enrolleeDevice?.did);
    expect(run.outcome?.payload?.discoverySecret).toBe(toB64(setup.discoverySecret));
  });

  test('a stranger on the topic cannot even obtain a challenge (possession MAC)', async () => {
    const setup = await sponsorSetup();
    const strangerSecrets = await deriveEnrollSecrets(crypto.getRandomValues(new Uint8Array(32)));
    const pair = await mintEnrollmentKeyPair();
    const device = await generateIdentity();
    const request = await buildEnrollRequest({
      macKey: strangerSecrets.macKey,
      credentialId: setup.passkey.credentialId, // even knowing the credential id
      ephemeralKey: await exportEnrollmentPublicKey(pair.publicKey),
      deviceDid: device.did,
      deviceId: 'stranger-1',
    });
    const admitted = await evaluateEnrollRequest(request, {
      macKey: setup.secrets.macKey, binding: setup.binding,
    });
    expect(admitted.ok).toBe(false);
    expect(admitted.defect).toBe('mac-mismatch');
  });

  test('a relay cannot substitute the device key named by the enrollee', async () => {
    const setup = await sponsorSetup();
    const pair = await mintEnrollmentKeyPair();
    const honestDevice = await generateIdentity();
    const attackerDevice = await generateIdentity();
    const request = await buildEnrollRequest({
      macKey: setup.secrets.macKey,
      credentialId: setup.passkey.credentialId,
      ephemeralKey: await exportEnrollmentPublicKey(pair.publicKey),
      deviceDid: honestDevice.did,
      deviceId: 'laptop-1',
    });
    expect((await evaluateEnrollRequest({
      ...request, deviceDid: attackerDevice.did,
    }, {
      macKey: setup.secrets.macKey, binding: setup.binding,
    })).defect).toBe('mac-mismatch');
  });

  test('a revoked credential is refused at request time', async () => {
    const setup = await sponsorSetup();
    const revokedBinding = await buildPasskeyBinding({
      personIdentity: setup.person,
      credentials: [{ ...setup.binding.credentials[0], status: 'revoked' as const }],
      seq: 2,
    });
    const pair = await mintEnrollmentKeyPair();
    const device = await generateIdentity();
    const request = await buildEnrollRequest({
      macKey: setup.secrets.macKey,
      credentialId: setup.passkey.credentialId,
      ephemeralKey: await exportEnrollmentPublicKey(pair.publicKey),
      deviceDid: device.did,
      deviceId: 'revoked-try-1',
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
    const enrolleeDevice = await generateIdentity();
    const challenge = buildEnrollChallenge();
    const ceremonyChallenge = await enrollCeremonyChallenge(
      challenge.challenge, enrolleeKey, enrolleeDevice.did,
    );
    const assertion = await fabricateAssertion({ credential: setup.passkey, challenge: ceremonyChallenge });

    // A relay substitutes ITS key while forwarding the genuine assertion.
    const mitmPair = await mintEnrollmentKeyPair();
    const mitmKey = await exportEnrollmentPublicKey(mitmPair.publicKey);
    const spliced = buildEnrollProof({
      assertion, ephemeralKey: mitmKey, deviceDid: enrolleeDevice.did,
    });
    // Case 1: sponsor pins the request's key, splice detected structurally.
    expect((await evaluateEnrollProof(spliced, {
      binding: setup.binding,
      issuedChallenge: challenge.challenge,
      requestEphemeralKey: enrolleeKey,
      requestDeviceDid: enrolleeDevice.did,
      allowedOrigins: ORIGINS,
    })).defect).toBe('ephemeral-key-mismatch');
    // Case 2: the relay also forged the original request around its own key
    // then the recomputed ceremony challenge no longer matches the assertion.
    const verdict = await evaluateEnrollProof(spliced, {
      binding: setup.binding,
      issuedChallenge: challenge.challenge,
      requestEphemeralKey: mitmKey,
      requestDeviceDid: enrolleeDevice.did,
      allowedOrigins: ORIGINS,
    });
    expect(verdict.defect).toBe('assertion-challenge-mismatch');
  });

  test('channel binding also commits the assertion to the device being certified', async () => {
    const setup = await sponsorSetup();
    const pair = await mintEnrollmentKeyPair();
    const enrolleeKey = await exportEnrollmentPublicKey(pair.publicKey);
    const honestDevice = await generateIdentity();
    const attackerDevice = await generateIdentity();
    const challenge = buildEnrollChallenge();
    const assertion = await fabricateAssertion({
      credential: setup.passkey,
      challenge: await enrollCeremonyChallenge(
        challenge.challenge, enrolleeKey, honestDevice.did,
      ),
    });
    const proof = buildEnrollProof({
      assertion, ephemeralKey: enrolleeKey, deviceDid: attackerDevice.did,
    });
    expect((await evaluateEnrollProof(proof, {
      binding: setup.binding,
      issuedChallenge: challenge.challenge,
      requestEphemeralKey: enrolleeKey,
      requestDeviceDid: honestDevice.did,
      allowedOrigins: ORIGINS,
    })).defect).toBe('device-did-mismatch');
    expect((await evaluateEnrollProof(proof, {
      binding: setup.binding,
      issuedChallenge: challenge.challenge,
      requestEphemeralKey: enrolleeKey,
      requestDeviceDid: attackerDevice.did,
      allowedOrigins: ORIGINS,
    })).defect).toBe('assertion-challenge-mismatch');
  });

  test('replay: an assertion for an old challenge fails against a fresh one', async () => {
    const setup = await sponsorSetup();
    const enrolleePair = await mintEnrollmentKeyPair();
    const enrolleeKey = await exportEnrollmentPublicKey(enrolleePair.publicKey);
    const enrolleeDevice = await generateIdentity();
    const oldChallenge = buildEnrollChallenge();
    const recorded = await fabricateAssertion({
      credential: setup.passkey,
      challenge: await enrollCeremonyChallenge(
        oldChallenge.challenge, enrolleeKey, enrolleeDevice.did,
      ),
    });
    const freshChallenge = buildEnrollChallenge();
    const verdict = await evaluateEnrollProof(buildEnrollProof({
      assertion: recorded, ephemeralKey: enrolleeKey, deviceDid: enrolleeDevice.did,
    }), {
      binding: setup.binding,
      issuedChallenge: freshChallenge.challenge,
      requestEphemeralKey: enrolleeKey,
      requestDeviceDid: enrolleeDevice.did,
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
      prfOutput: setup.prfOutput,
      expectedDeviceDid: run.enrolleeDevice!.did,
      expectedDeviceId: run.enrolleeDeviceId!,
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
      prfOutput: setup.prfOutput,
      expectedDeviceDid: run.enrolleeDevice!.did,
      expectedDeviceId: run.enrolleeDeviceId!,
    });
    expect(wrongTranscript.ok).toBe(false);
  });

  test('a valid grant cannot be redirected to a different local device key', async () => {
    const setup = await sponsorSetup();
    const run = await runEnrollment(setup);
    const otherDevice = await generateIdentity();
    const redirected = await openEnrollmentGrant(run.grant, {
      enrolleePrivateKey: run.enrolleePair!.privateKey,
      enrolleeKey: run.enrolleeKey!,
      issuedChallenge: run.challenge!.challenge,
      credentialId: setup.passkey.credentialId,
      prfOutput: setup.prfOutput,
      expectedDeviceDid: otherDevice.did,
      expectedDeviceId: 'other-install',
    });
    expect(redirected.ok).toBe(false);
    expect(redirected.defect).toBe('certificate-device-did-mismatch');
  });

  test('a hostile sponsor cannot substitute a different identity (chain refuses)', async () => {
    const setup = await sponsorSetup();
    const enrolleePair = await mintEnrollmentKeyPair();
    const enrolleeKey = await exportEnrollmentPublicKey(enrolleePair.publicKey);
    const enrolleeDevice = await generateIdentity();
    const enrolleeDeviceId = 'target-laptop';
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
    const attackerIssued = await issueEnrolledDeviceRecords({
      personIdentity: attackerPerson, priorRoster: attackerRoster,
      deviceDid: enrolleeDevice.did, deviceId: enrolleeDeviceId, now: 2,
    });

    // Variant 1: attacker identity + the VICTIM's binding record.
    const grantWithVictimBinding = await sealEnrollmentGrant({
      payload: {
        v: 1,
        personDid: attackerPerson.did,
        deviceCertificate: attackerIssued.certificate,
        discoverySecret: toB64(mintDiscoverySecret()),
        passkeyBinding: setup.binding,
        deviceRoster: attackerIssued.roster,
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
      prfOutput: setup.prfOutput,
      expectedDeviceDid: enrolleeDevice.did,
      expectedDeviceId: enrolleeDeviceId,
    });
    expect(verdict1.ok).toBe(false);
    expect(verdict1.defect).toBe('binding-person-did-mismatch');

    // Variant 2: the real attack the old implementation missed. The sponsor
    // knows the victim binding's PUBLIC credential row and can copy it into
    // a binding under the attacker root. The PRF commitment still names the
    // original person, so the recovering device rejects the substitution.
    const attackerBinding = await buildPasskeyBinding({
      personIdentity: attackerPerson,
      credentials: [setup.binding.credentials[0]],
      seq: 1,
    });
    const grantWithAttackerBinding = await sealEnrollmentGrant({
      payload: {
        v: 1,
        personDid: attackerPerson.did,
        deviceCertificate: attackerIssued.certificate,
        discoverySecret: toB64(mintDiscoverySecret()),
        passkeyBinding: attackerBinding,
        deviceRoster: attackerIssued.roster,
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
      prfOutput: setup.prfOutput,
      expectedDeviceDid: enrolleeDevice.did,
      expectedDeviceId: enrolleeDeviceId,
    });
    expect(verdict2.ok).toBe(false);
    expect(verdict2.defect).toBe('identity-commitment-mismatch');
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
      prfOutput: setup.prfOutput,
      expectedDeviceDid: run.enrolleeDevice!.did,
      expectedDeviceId: run.enrolleeDeviceId!,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.defect).toBe('open-failed');
  });

  test('the grant payload carries no person or device private key', async () => {
    const setup = await sponsorSetup();
    const { outcome } = await runEnrollment(setup);
    expect(outcome?.ok).toBe(true);
    const keys = Object.keys(outcome!.payload!);
    expect(keys.sort()).toEqual([
      'deviceCertificate', 'deviceRoster', 'discoverySecret', 'passkeyBinding', 'personDid', 'v',
    ]);
    expect(JSON.stringify(outcome!.payload!)).not.toContain(setup.material.seed);
  });

  test('the grant sealer refuses root material or any unversioned payload extension', async () => {
    const setup = await sponsorSetup();
    const run = await runEnrollment(setup);
    await expect(sealEnrollmentGrant({
      payload: {
        ...run.outcome!.payload!,
        material: setup.material,
      } as any,
      enrolleeKey: run.enrolleeKey!,
      issuedChallenge: run.challenge!.challenge,
      credentialId: setup.passkey.credentialId,
    })).rejects.toThrow(/field is not allowed: material/);

    await expect(sealEnrollmentGrant({
      payload: {
        ...run.outcome!.payload!,
        passkeyBinding: { ...run.outcome!.payload!.passkeyBinding, material: setup.material },
      } as any,
      enrolleeKey: run.enrolleeKey!,
      issuedChallenge: run.challenge!.challenge,
      credentialId: setup.passkey.credentialId,
    })).rejects.toThrow(/binding is malformed: unknown-field/);
  });

  test('a valid certificate with a roster that marks this device revoked is refused', async () => {
    const setup = await sponsorSetup();
    const run = await runEnrollment(setup);
    const revokedRoster = await buildDeviceRoster({
      personIdentity: setup.person,
      devices: run.issued!.roster.devices.map((row: any) => (
        row.deviceDid === run.enrolleeDevice!.did
          ? { ...row, status: 'revoked' as const }
          : row
      )),
      seq: run.issued!.roster.seq + 1,
    });
    const grant = await sealEnrollmentGrant({
      payload: {
        ...run.outcome!.payload!,
        deviceRoster: revokedRoster,
      },
      enrolleeKey: run.enrolleeKey!,
      issuedChallenge: run.challenge!.challenge,
      credentialId: setup.passkey.credentialId,
    });
    const outcome = await openEnrollmentGrant(grant, {
      enrolleePrivateKey: run.enrolleePair!.privateKey,
      enrolleeKey: run.enrolleeKey!,
      issuedChallenge: run.challenge!.challenge,
      credentialId: setup.passkey.credentialId,
      prfOutput: setup.prfOutput,
      expectedDeviceDid: run.enrolleeDevice!.did,
      expectedDeviceId: run.enrolleeDeviceId!,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.defect).toBe('roster-device-not-active');
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
