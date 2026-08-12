// The new-device enrollment exchange, end to end over fabricated (but
// cryptographically real) passkey ceremonies. The happy path proves a fresh
// install becomes a certified device of the person; the adversarial paths
// prove each of the issue's §13 invariants at the exact layer that owns it:
// possession-MAC gating, assertion freshness, ephemeral-key AND device-key
// channel binding, grant exchange binding, and the enrollee's identity-chain
// verification against a hostile sponsor.
//
// The load-bearing property, asserted here and in self-custody.test.ts: the
// grant conveys BOUNDED DEVICE AUTHORITY, never the person root. Revocation
// is only real if a revoked device cannot re-authorize itself.

import { describe, test, expect } from 'bun:test';
import { generateIdentity, mintKeypairMaterial } from '../../extension/peerd-distributed/identity/keypair.js';
import { buildPasskeyBinding } from '../../extension/peerd-distributed/identity/passkey-binding.js';
import {
  buildDeviceRoster, issueDeviceCertificate, verifyDeviceRoster, rosterSupersedes,
} from '../../extension/peerd-distributed/identity/device-certificate.js';
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
    material, person, passkey, binding, roster, sponsorDevice,
    discoverySecret: mintDiscoverySecret(),
    prfOutput, secrets,
  };
};

/**
 * The sponsor's half of the grant: it holds the root, so it is the only
 * party that can certify the enrollee's device and sign the roster naming
 * it. Mirrors custody.sponsorDeviceEnrollment without the storage IO.
 */
const issueForEnrollee = async (
  setup: Awaited<ReturnType<typeof sponsorSetup>>,
  enrollee: { did: string; deviceId: string },
) => {
  const seq = setup.roster.seq + 1;
  const certificate = await issueDeviceCertificate({
    personIdentity: setup.person, deviceDid: enrollee.did, deviceId: enrollee.deviceId,
    label: 'Laptop', seq, now: 2,
  });
  const roster = await buildDeviceRoster({
    personIdentity: setup.person,
    devices: [
      ...setup.roster.devices,
      { deviceDid: enrollee.did, deviceId: enrollee.deviceId, label: 'Laptop', addedAt: 2, status: 'active' as const },
    ],
    seq,
  });
  return { certificate, roster };
};

// Drive the full protocol between an honest sponsor and an honest enrollee.
const runEnrollment = async (setup: Awaited<ReturnType<typeof sponsorSetup>>) => {
  // Enrollee: ceremony #1 derived the same secrets (same passkey PRF), and
  // its OWN device key exists before it asks for anything.
  const enrolleeSecrets = await deriveEnrollSecrets(setup.prfOutput);
  const enrolleeDevice = await generateIdentity();
  const enrolleeDeviceId = 'laptop-1';
  const enrolleePair = await mintEnrollmentKeyPair();
  const enrolleeKey = await exportEnrollmentPublicKey(enrolleePair.publicKey);

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
  // Enrollee: ceremony #2 asserts over the channel-bound challenge, which
  // commits to both the seal key and the device about to be certified.
  const ceremonyChallenge = await enrollCeremonyChallenge(
    challenge.challenge, enrolleeKey, enrolleeDevice.did,
  );
  const assertion = await fabricateAssertion({ credential: setup.passkey, challenge: ceremonyChallenge });
  const proof = buildEnrollProof({ assertion, ephemeralKey: enrolleeKey, deviceDid: enrolleeDevice.did });

  const verdict = await evaluateEnrollProof(proof, {
    binding: setup.binding,
    issuedChallenge: challenge.challenge,
    requestEphemeralKey: request.ephemeralKey,
    requestDeviceDid: request.deviceDid,
    allowedOrigins: ORIGINS,
  });
  if (!verdict.ok) return { admitted, verdict, outcome: null };

  const issued = await issueForEnrollee(setup, { did: enrolleeDevice.did, deviceId: enrolleeDeviceId });
  const grant = await sealEnrollmentGrant({
    payload: {
      v: 1,
      personDid: setup.person.did,
      deviceCertificate: issued.certificate,
      deviceRoster: issued.roster,
      discoverySecret: toB64(setup.discoverySecret),
      passkeyBinding: setup.binding,
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
    deviceDid: enrolleeDevice.did,
  });
  return {
    admitted, verdict, outcome, grant, challenge, enrolleePair, enrolleeKey,
    enrolleeDevice, enrolleeDeviceId, issued,
  };
};

describe('enrollment protocol', () => {
  test('happy path: a fresh install becomes a certified device of the person', async () => {
    const setup = await sponsorSetup();
    const run = await runEnrollment(setup);
    expect(run.admitted.ok).toBe(true);
    expect(run.verdict?.ok).toBe(true);
    expect(run.outcome?.ok).toBe(true);
    expect(run.outcome?.did).toBe(setup.person.did);
    expect(run.outcome?.payload?.discoverySecret).toBe(toB64(setup.discoverySecret));
    // The certificate it received is for ITS key, under the person's did.
    expect(run.outcome?.payload?.deviceCertificate.deviceDid).toBe(run.enrolleeDevice!.did);
    expect(run.outcome?.payload?.deviceCertificate.personDid).toBe(setup.person.did);
  });

  test('the grant carries NO private key of any kind, root least of all', async () => {
    const setup = await sponsorSetup();
    const { outcome } = await runEnrollment(setup);
    expect(outcome?.ok).toBe(true);
    const payload = outcome!.payload!;
    expect(Object.keys(payload).sort()).toEqual([
      'deviceCertificate', 'deviceRoster', 'discoverySecret', 'passkeyBinding', 'personDid', 'v',
    ]);
    // Belt and braces: the person's seed appears nowhere in the payload, at
    // any depth, under any key name.
    expect(JSON.stringify(payload)).not.toContain(setup.material.seed);
    expect(payload).not.toHaveProperty('material');
  });

  test('a grant that still ships root material is refused, not silently ignored', async () => {
    const setup = await sponsorSetup();
    const enrolleeDevice = await generateIdentity();
    const enrolleePair = await mintEnrollmentKeyPair();
    const enrolleeKey = await exportEnrollmentPublicKey(enrolleePair.publicKey);
    const challenge = buildEnrollChallenge();
    const issued = await issueForEnrollee(setup, { did: enrolleeDevice.did, deviceId: 'laptop-1' });

    // An old-protocol (or hostile) sponsor bundling the seed alongside a
    // perfectly valid chain. The enrollee must not accept the downgrade.
    const grant = await sealEnrollmentGrant({
      payload: {
        v: 1,
        personDid: setup.person.did,
        deviceCertificate: issued.certificate,
        deviceRoster: issued.roster,
        discoverySecret: toB64(setup.discoverySecret),
        passkeyBinding: setup.binding,
        material: { seed: setup.material.seed, pub: setup.material.pub },
      } as any,
      enrolleeKey,
      issuedChallenge: challenge.challenge,
      credentialId: setup.passkey.credentialId,
    });
    const outcome = await openEnrollmentGrant(grant, {
      enrolleePrivateKey: enrolleePair.privateKey,
      enrolleeKey,
      issuedChallenge: challenge.challenge,
      credentialId: setup.passkey.credentialId,
      deviceDid: enrolleeDevice.did,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.defect).toBe('root-material-present');
  });

  test('a stranger on the topic cannot even obtain a challenge (possession MAC)', async () => {
    const setup = await sponsorSetup();
    const strangerSecrets = await deriveEnrollSecrets(crypto.getRandomValues(new Uint8Array(32)));
    const pair = await mintEnrollmentKeyPair();
    const stranger = await generateIdentity();
    const request = await buildEnrollRequest({
      macKey: strangerSecrets.macKey,
      credentialId: setup.passkey.credentialId, // even knowing the credential id
      ephemeralKey: await exportEnrollmentPublicKey(pair.publicKey),
      deviceDid: stranger.did,
      deviceId: 'evil-1',
    });
    const admitted = await evaluateEnrollRequest(request, {
      macKey: setup.secrets.macKey, binding: setup.binding,
    });
    expect(admitted.ok).toBe(false);
    expect(admitted.defect).toBe('mac-mismatch');
  });

  test('a relay cannot swap in its own device did (the MAC covers it)', async () => {
    const setup = await sponsorSetup();
    const enrolleeSecrets = await deriveEnrollSecrets(setup.prfOutput);
    const honestDevice = await generateIdentity();
    const attackerDevice = await generateIdentity();
    const pair = await mintEnrollmentKeyPair();
    const request = await buildEnrollRequest({
      macKey: enrolleeSecrets.macKey,
      credentialId: setup.passkey.credentialId,
      ephemeralKey: await exportEnrollmentPublicKey(pair.publicKey),
      deviceDid: honestDevice.did,
      deviceId: 'laptop-1',
    });
    // The relay rewrites the device it wants certified, keeping everything
    // else. The sponsor is about to SIGN a certificate for this did.
    const tampered = { ...request, deviceDid: attackerDevice.did };
    const admitted = await evaluateEnrollRequest(tampered, {
      macKey: setup.secrets.macKey, binding: setup.binding,
    });
    expect(admitted.defect).toBe('mac-mismatch');
  });

  test('a malformed device did never reaches a signed certificate', async () => {
    const setup = await sponsorSetup();
    const enrolleeSecrets = await deriveEnrollSecrets(setup.prfOutput);
    const pair = await mintEnrollmentKeyPair();
    const request = await buildEnrollRequest({
      macKey: enrolleeSecrets.macKey,
      credentialId: setup.passkey.credentialId,
      ephemeralKey: await exportEnrollmentPublicKey(pair.publicKey),
      deviceDid: 'did:key:not-a-real-key',
      deviceId: 'laptop-1',
    });
    const admitted = await evaluateEnrollRequest(request, {
      macKey: setup.secrets.macKey, binding: setup.binding,
    });
    expect(admitted.ok).toBe(false);
    expect(admitted.defect).toBe('bad-deviceDid');
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
      deviceId: 'laptop-1',
    });
    const admitted = await evaluateEnrollRequest(request, {
      macKey: setup.secrets.macKey, binding: revokedBinding,
    });
    expect(admitted.defect).toBe('unknown-credential');
  });

  test('channel binding: swapping the ephemeral key invalidates the assertion', async () => {
    const setup = await sponsorSetup();
    const device = await generateIdentity();
    const enrolleePair = await mintEnrollmentKeyPair();
    const enrolleeKey = await exportEnrollmentPublicKey(enrolleePair.publicKey);
    const challenge = buildEnrollChallenge();
    const ceremonyChallenge = await enrollCeremonyChallenge(challenge.challenge, enrolleeKey, device.did);
    const assertion = await fabricateAssertion({ credential: setup.passkey, challenge: ceremonyChallenge });

    // A relay substitutes ITS key while forwarding the genuine assertion.
    const mitmPair = await mintEnrollmentKeyPair();
    const mitmKey = await exportEnrollmentPublicKey(mitmPair.publicKey);
    const spliced = buildEnrollProof({ assertion, ephemeralKey: mitmKey, deviceDid: device.did });
    // Case 1: sponsor pins the request's key, splice detected structurally.
    expect((await evaluateEnrollProof(spliced, {
      binding: setup.binding,
      issuedChallenge: challenge.challenge,
      requestEphemeralKey: enrolleeKey,
      requestDeviceDid: device.did,
      allowedOrigins: ORIGINS,
    })).defect).toBe('ephemeral-key-mismatch');
    // Case 2: the relay also forged the original request around its own key
    // then the recomputed ceremony challenge no longer matches the assertion.
    const verdict = await evaluateEnrollProof(spliced, {
      binding: setup.binding,
      issuedChallenge: challenge.challenge,
      requestEphemeralKey: mitmKey,
      requestDeviceDid: device.did,
      allowedOrigins: ORIGINS,
    });
    expect(verdict.defect).toBe('assertion-challenge-mismatch');
  });

  test('channel binding: the assertion also commits to the device being certified', async () => {
    const setup = await sponsorSetup();
    const honestDevice = await generateIdentity();
    const attackerDevice = await generateIdentity();
    const enrolleePair = await mintEnrollmentKeyPair();
    const enrolleeKey = await exportEnrollmentPublicKey(enrolleePair.publicKey);
    const challenge = buildEnrollChallenge();
    // The person approved enrolling THEIR device.
    const assertion = await fabricateAssertion({
      credential: setup.passkey,
      challenge: await enrollCeremonyChallenge(challenge.challenge, enrolleeKey, honestDevice.did),
    });

    // Re-pointed at the attacker's device key, with the same genuine
    // assertion and the same seal key. Structural pin catches it first…
    const spliced = buildEnrollProof({ assertion, ephemeralKey: enrolleeKey, deviceDid: attackerDevice.did });
    expect((await evaluateEnrollProof(spliced, {
      binding: setup.binding,
      issuedChallenge: challenge.challenge,
      requestEphemeralKey: enrolleeKey,
      requestDeviceDid: honestDevice.did,
      allowedOrigins: ORIGINS,
    })).defect).toBe('device-did-mismatch');

    // …and if the attacker forged the request around its did too, the
    // recomputed ceremony challenge no longer matches the assertion. One
    // Touch ID approval cannot be redirected onto another device's key.
    const verdict = await evaluateEnrollProof(spliced, {
      binding: setup.binding,
      issuedChallenge: challenge.challenge,
      requestEphemeralKey: enrolleeKey,
      requestDeviceDid: attackerDevice.did,
      allowedOrigins: ORIGINS,
    });
    expect(verdict.defect).toBe('assertion-challenge-mismatch');
  });

  test('replay: an assertion for an old challenge fails against a fresh one', async () => {
    const setup = await sponsorSetup();
    const device = await generateIdentity();
    const enrolleePair = await mintEnrollmentKeyPair();
    const enrolleeKey = await exportEnrollmentPublicKey(enrolleePair.publicKey);
    const oldChallenge = buildEnrollChallenge();
    const recorded = await fabricateAssertion({
      credential: setup.passkey,
      challenge: await enrollCeremonyChallenge(oldChallenge.challenge, enrolleeKey, device.did),
    });
    const freshChallenge = buildEnrollChallenge();
    const verdict = await evaluateEnrollProof(
      buildEnrollProof({ assertion: recorded, ephemeralKey: enrolleeKey, deviceDid: device.did }),
      {
        binding: setup.binding,
        issuedChallenge: freshChallenge.challenge,
        requestEphemeralKey: enrolleeKey,
        requestDeviceDid: device.did,
        allowedOrigins: ORIGINS,
      },
    );
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
      deviceDid: run.enrolleeDevice!.did,
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
      deviceDid: run.enrolleeDevice!.did,
    });
    expect(wrongTranscript.ok).toBe(false);
  });

  test('a certificate for someone else\'s device is refused by the enrollee', async () => {
    const setup = await sponsorSetup();
    const enrolleeDevice = await generateIdentity();
    const otherDevice = await generateIdentity();
    const enrolleePair = await mintEnrollmentKeyPair();
    const enrolleeKey = await exportEnrollmentPublicKey(enrolleePair.publicKey);
    const challenge = buildEnrollChallenge();
    // Genuinely person-signed, just not for this install's key: adopting it
    // would leave the device holding authority it cannot exercise.
    const issued = await issueForEnrollee(setup, { did: otherDevice.did, deviceId: 'other-1' });
    const grant = await sealEnrollmentGrant({
      payload: {
        v: 1,
        personDid: setup.person.did,
        deviceCertificate: issued.certificate,
        deviceRoster: issued.roster,
        discoverySecret: toB64(setup.discoverySecret),
        passkeyBinding: setup.binding,
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
      deviceDid: enrolleeDevice.did,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.defect).toBe('certificate-device-did-mismatch');
  });

  test('a grant whose roster does not list this device as active is refused', async () => {
    const setup = await sponsorSetup();
    const enrolleeDevice = await generateIdentity();
    const enrolleePair = await mintEnrollmentKeyPair();
    const enrolleeKey = await exportEnrollmentPublicKey(enrolleePair.publicKey);
    const challenge = buildEnrollChallenge();
    const certificate = await issueDeviceCertificate({
      personIdentity: setup.person, deviceDid: enrolleeDevice.did, deviceId: 'laptop-1', seq: 2, now: 2,
    });
    // Certificate issued, but the roster names it revoked: dead on arrival,
    // and better refused here than discovered at the first handshake.
    const roster = await buildDeviceRoster({
      personIdentity: setup.person,
      devices: [
        ...setup.roster.devices,
        { deviceDid: enrolleeDevice.did, deviceId: 'laptop-1', addedAt: 2, status: 'revoked' as const },
      ],
      seq: 2,
    });
    const grant = await sealEnrollmentGrant({
      payload: {
        v: 1,
        personDid: setup.person.did,
        deviceCertificate: certificate,
        deviceRoster: roster,
        discoverySecret: toB64(setup.discoverySecret),
        passkeyBinding: setup.binding,
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
      deviceDid: enrolleeDevice.did,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.defect).toBe('device-not-active-in-roster');
  });

  test('a hostile sponsor cannot substitute a different identity (chain refuses)', async () => {
    const setup = await sponsorSetup();
    const enrolleeDevice = await generateIdentity();
    const enrolleePair = await mintEnrollmentKeyPair();
    const enrolleeKey = await exportEnrollmentPublicKey(enrolleePair.publicKey);
    const challenge = buildEnrollChallenge();

    // The attacker controls their own root, so they can certify the
    // enrollee's device under THEIR did and sign a matching roster. What
    // they cannot produce is a passkey binding, under that same did, that
    // lists the enrollee's credential as active.
    const attackerMaterial = await mintKeypairMaterial();
    const attackerPerson = await identityFromMaterial(attackerMaterial);
    const attackerCert = await issueDeviceCertificate({
      personIdentity: attackerPerson, deviceDid: enrolleeDevice.did, deviceId: 'laptop-1', seq: 1, now: 2,
    });
    const attackerRoster = await buildDeviceRoster({
      personIdentity: attackerPerson,
      devices: [{ deviceDid: enrolleeDevice.did, deviceId: 'laptop-1', addedAt: 2, status: 'active' as const }],
      seq: 1,
    });

    // Variant 1: attacker identity + the VICTIM's binding record.
    const grantWithVictimBinding = await sealEnrollmentGrant({
      payload: {
        v: 1,
        personDid: attackerPerson.did,
        deviceCertificate: attackerCert,
        deviceRoster: attackerRoster,
        discoverySecret: toB64(mintDiscoverySecret()),
        passkeyBinding: setup.binding,
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
      deviceDid: enrolleeDevice.did,
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
        personDid: attackerPerson.did,
        deviceCertificate: attackerCert,
        deviceRoster: attackerRoster,
        discoverySecret: toB64(mintDiscoverySecret()),
        passkeyBinding: attackerBinding,
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
      deviceDid: enrolleeDevice.did,
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
      deviceDid: run.enrolleeDevice!.did,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.defect).toBe('open-failed');
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

describe('revocation is real because enrollment grants no root', () => {
  test('a revoked device cannot forge a newer roster that reinstates it', async () => {
    const setup = await sponsorSetup();
    const run = await runEnrollment(setup);
    expect(run.outcome?.ok).toBe(true);
    const enrolled = run.enrolleeDevice!;

    // The person revokes the enrolled device from a root-holding device.
    const revoked = await buildDeviceRoster({
      personIdentity: setup.person,
      devices: run.issued!.roster.devices.map((row: any) => (
        row.deviceDid === enrolled.did ? { ...row, status: 'revoked' as const } : row
      )),
      seq: run.issued!.roster.seq + 1,
    });
    expect(rosterSupersedes(revoked, run.issued!.roster)).toBe(true);

    // The revoked device now tries to write itself back in. Everything it
    // holds is public (its certificate, the old roster, the person's did)
    // plus its own device key. What it does NOT hold is the person root, so
    // the only signature it can produce over a seq+1 roster is its own.
    const forged = await buildDeviceRoster({
      personIdentity: enrolled, // signing with the DEVICE key, not the root
      devices: [{ deviceDid: enrolled.did, deviceId: run.enrolleeDeviceId!, addedAt: 3, status: 'active' as const }],
      seq: revoked.seq + 1,
    });
    // It is newer, and it is a valid signature, of the wrong signer.
    expect(forged.seq).toBeGreaterThan(revoked.seq);
    const verdict = await verifyDeviceRoster(forged, { expectedPersonDid: setup.person.did });
    expect(verdict.ok).toBe(false);
    expect(verdict.defect).toBe('person-did-mismatch');

    // And it cannot re-sign under the person's did either: buildDeviceRoster
    // stamps personDid from the signer, so claiming the person's did means
    // producing a signature it has no key for.
    const relabelled = { ...forged, personDid: setup.person.did };
    expect((await verifyDeviceRoster(relabelled, { expectedPersonDid: setup.person.did })).ok).toBe(false);
  });

  test('a device holding the root COULD forge one, which is why it is never granted', async () => {
    // The counterfactual, asserted so the property above is understood as a
    // consequence of the grant's contents rather than of luck. If a grant
    // handed over the root seed, this is exactly what a revoked device would
    // do next, and every peer would accept it.
    const setup = await sponsorSetup();
    const rootHolder = await identityFromMaterial(setup.material);
    const freshKey = await generateIdentity();
    const reinstated = await buildDeviceRoster({
      personIdentity: rootHolder,
      devices: [{ deviceDid: freshKey.did, deviceId: 'reborn-1', addedAt: 9, status: 'active' as const }],
      seq: setup.roster.seq + 5,
    });
    expect((await verifyDeviceRoster(reinstated, { expectedPersonDid: setup.person.did })).ok).toBe(true);
    expect(rosterSupersedes(reinstated, setup.roster)).toBe(true);
  });
});
