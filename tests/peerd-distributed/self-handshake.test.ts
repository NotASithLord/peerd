// Mutual same-person authentication: the trust-tier boundary. The happy
// path runs the full four-message dance both ways; every adversarial case
// is one of the issue's invariants: same-did claims, certs without keys,
// keys without certs, replays, reflections, revocations, and cross-protocol
// signature reuse must all refuse.

import { describe, test, expect } from 'bun:test';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import {
  issueDeviceCertificate, buildDeviceRoster,
} from '../../extension/peerd-distributed/identity/device-certificate.js';
import {
  buildAuthHello, evaluateAuthHello, buildAuthProof, verifyAuthProof,
  proofSigningBytes, mintAuthNonce, SELF_AUTH_PROTO,
} from '../../extension/peerd-distributed/self/handshake.js';
import { signEnvelope, buildEnvelope } from '../../extension/peerd-distributed/transport/envelope.js';

const ROOM = 'rendezvous-topic-hex';

// One person, two certified devices: the legitimate setup.
const household = async () => {
  const person = await generateIdentity();
  const desktop = await generateIdentity();
  const laptop = await generateIdentity();
  const desktopCert = await issueDeviceCertificate({
    personIdentity: person, deviceDid: desktop.did, deviceId: 'desktop-1', label: 'Desktop', now: 1,
  });
  const laptopCert = await issueDeviceCertificate({
    personIdentity: person, deviceDid: laptop.did, deviceId: 'laptop-1', label: 'Laptop', now: 2, seq: 2,
  });
  const roster = await buildDeviceRoster({
    personIdentity: person,
    devices: [
      { deviceDid: desktop.did, deviceId: 'desktop-1', label: 'Desktop', addedAt: 1, status: 'active' },
      { deviceDid: laptop.did, deviceId: 'laptop-1', label: 'Laptop', addedAt: 2, status: 'active' },
    ],
    seq: 2,
  });
  return { person, desktop, laptop, desktopCert, laptopCert, roster };
};

// Run the full mutual handshake between two prepared sides; returns each
// side's verdicts so tests can assert on both directions.
const runHandshake = async (
  a: { identity: any, cert: any, personDid: string, roster?: any },
  b: { identity: any, cert: any, personDid: string, roster?: any },
) => {
  const aNonce = mintAuthNonce();
  const bNonce = mintAuthNonce();
  const aHello = buildAuthHello({ cert: a.cert, nonce: aNonce });
  const bHello = buildAuthHello({ cert: b.cert, nonce: bNonce });

  const aSeesB = await evaluateAuthHello(bHello, {
    personDid: a.personDid, selfDeviceDid: a.identity.did,
    linkDeviceDid: b.identity.did, roster: a.roster ?? null,
  });
  const bSeesA = await evaluateAuthHello(aHello, {
    personDid: b.personDid, selfDeviceDid: b.identity.did,
    linkDeviceDid: a.identity.did, roster: b.roster ?? null,
  });
  if (!aSeesB.ok || !bSeesA.ok) return { aSeesB, bSeesA, aVerifiesB: null, bVerifiesA: null };

  const aProof = await buildAuthProof({
    deviceSign: a.identity.sign, roomId: ROOM,
    selfDeviceDid: a.identity.did, peerDeviceDid: b.identity.did,
    selfNonce: aNonce, peerNonce: bNonce,
  });
  const bProof = await buildAuthProof({
    deviceSign: b.identity.sign, roomId: ROOM,
    selfDeviceDid: b.identity.did, peerDeviceDid: a.identity.did,
    selfNonce: bNonce, peerNonce: aNonce,
  });
  const aVerifiesB = await verifyAuthProof(bProof, {
    roomId: ROOM, peerDeviceDid: b.identity.did, selfDeviceDid: a.identity.did,
    peerNonce: bNonce, selfNonce: aNonce,
  });
  const bVerifiesA = await verifyAuthProof(aProof, {
    roomId: ROOM, peerDeviceDid: a.identity.did, selfDeviceDid: b.identity.did,
    peerNonce: aNonce, selfNonce: bNonce,
  });
  return { aSeesB, bSeesA, aVerifiesB, bVerifiesA };
};

describe('mutual self-device authentication', () => {
  test('two certified devices of one person authenticate both ways', async () => {
    const { person, desktop, laptop, desktopCert, laptopCert, roster } = await household();
    const result = await runHandshake(
      { identity: desktop, cert: desktopCert, personDid: person.did, roster },
      { identity: laptop, cert: laptopCert, personDid: person.did, roster },
    );
    expect(result.aSeesB.ok).toBe(true);
    expect(result.bSeesA.ok).toBe(true);
    expect(result.aVerifiesB).toEqual({ ok: true, defect: null });
    expect(result.bVerifiesA).toEqual({ ok: true, defect: null });
  });

  test('invariant: the same did CLAIM is not authentication: a device of a different person refuses', async () => {
    const { person, desktop, desktopCert } = await household();
    const impostorPerson = await generateIdentity();
    const impostorDevice = await generateIdentity();
    const impostorCert = await issueDeviceCertificate({
      personIdentity: impostorPerson, deviceDid: impostorDevice.did, deviceId: 'evil-1', now: 3,
    });
    const result = await runHandshake(
      { identity: desktop, cert: desktopCert, personDid: person.did },
      { identity: impostorDevice, cert: impostorCert, personDid: impostorPerson.did },
    );
    // Desktop refuses the impostor's cert (wrong root)…
    expect(result.aSeesB.ok).toBe(false);
    expect(result.aSeesB.defect).toBe('cert-person-did-mismatch');
    // …and the impostor can't validate desktop's cert either.
    expect(result.bSeesA.ok).toBe(false);
  });

  test('invariant: a stolen VALID certificate without its device key is insufficient', async () => {
    const { person, desktop, laptop, laptopCert, desktopCert } = await household();
    const thief = await generateIdentity(); // holds laptop's CERT but not its key
    // The mesh link authenticated the thief's key, not the laptop's:
    const verdict = await evaluateAuthHello(buildAuthHello({ cert: laptopCert, nonce: mintAuthNonce() }), {
      personDid: person.did, selfDeviceDid: desktop.did, linkDeviceDid: thief.did, roster: null,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.defect).toBe('cert-device-did-mismatch');

    // Even reaching the proof stage (say the link did was somehow right),
    // the thief cannot sign as the laptop:
    const desktopNonce = mintAuthNonce();
    const thiefNonce = mintAuthNonce();
    const forgedProof = await buildAuthProof({
      deviceSign: thief.sign, roomId: ROOM,
      selfDeviceDid: laptop.did, peerDeviceDid: desktop.did,
      selfNonce: thiefNonce, peerNonce: desktopNonce,
    });
    const proofVerdict = await verifyAuthProof(forgedProof, {
      roomId: ROOM, peerDeviceDid: laptop.did, selfDeviceDid: desktop.did,
      peerNonce: thiefNonce, selfNonce: desktopNonce,
    });
    expect(proofVerdict.ok).toBe(false);
    expect(proofVerdict.defect).toBe('signature-invalid');
    void desktopCert;
  });

  test('invariant: a device key WITHOUT a person-root certificate is insufficient', async () => {
    const { person, desktop } = await household();
    const uncertified = await generateIdentity();
    const selfSigned = await issueDeviceCertificate({
      personIdentity: uncertified, // signs its own cert: not the person root
      deviceDid: uncertified.did, deviceId: 'rogue-1', now: 4,
    }).catch(() => null);
    // Issuing refuses deviceDid === personDid, so the rogue must forge:
    expect(selfSigned).toBeNull();
    const rogueHelper = await generateIdentity();
    const forged = await issueDeviceCertificate({
      personIdentity: rogueHelper, deviceDid: uncertified.did, deviceId: 'rogue-1', now: 4,
    });
    const verdict = await evaluateAuthHello(buildAuthHello({ cert: forged, nonce: mintAuthNonce() }), {
      personDid: person.did, selfDeviceDid: desktop.did, linkDeviceDid: uncertified.did, roster: null,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.defect).toBe('cert-person-did-mismatch');
  });

  test('replay: a recorded proof dies with its nonces', async () => {
    const { person, desktop, laptop, laptopCert } = await household();
    const oldDesktopNonce = mintAuthNonce();
    const oldLaptopNonce = mintAuthNonce();
    const recorded = await buildAuthProof({
      deviceSign: laptop.sign, roomId: ROOM,
      selfDeviceDid: laptop.did, peerDeviceDid: desktop.did,
      selfNonce: oldLaptopNonce, peerNonce: oldDesktopNonce,
    });
    // A new session issues fresh nonces; the recorded proof can't answer them.
    const verdict = await verifyAuthProof(recorded, {
      roomId: ROOM, peerDeviceDid: laptop.did, selfDeviceDid: desktop.did,
      peerNonce: mintAuthNonce(), selfNonce: mintAuthNonce(),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.defect).toBe('signature-invalid');
    void person; void laptopCert;
  });

  test('reflection: my own proof bounced back at me does not verify', async () => {
    const { desktop, laptop } = await household();
    const desktopNonce = mintAuthNonce();
    const laptopNonce = mintAuthNonce();
    const desktopProof = await buildAuthProof({
      deviceSign: desktop.sign, roomId: ROOM,
      selfDeviceDid: desktop.did, peerDeviceDid: laptop.did,
      selfNonce: desktopNonce, peerNonce: laptopNonce,
    });
    // Desktop verifying "the laptop's proof" but receiving its own back:
    const verdict = await verifyAuthProof(desktopProof, {
      roomId: ROOM, peerDeviceDid: laptop.did, selfDeviceDid: desktop.did,
      peerNonce: laptopNonce, selfNonce: desktopNonce,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.defect).toBe('signature-invalid');
  });

  test('context binding: a proof from another room does not verify here', async () => {
    const { desktop, laptop } = await household();
    const desktopNonce = mintAuthNonce();
    const laptopNonce = mintAuthNonce();
    const proofElsewhere = await buildAuthProof({
      deviceSign: laptop.sign, roomId: 'a-different-room',
      selfDeviceDid: laptop.did, peerDeviceDid: desktop.did,
      selfNonce: laptopNonce, peerNonce: desktopNonce,
    });
    const verdict = await verifyAuthProof(proofElsewhere, {
      roomId: ROOM, peerDeviceDid: laptop.did, selfDeviceDid: desktop.did,
      peerNonce: laptopNonce, selfNonce: desktopNonce,
    });
    expect(verdict.defect).toBe('signature-invalid');
  });

  test('revocation: a roster-revoked device is refused at hello', async () => {
    const { person, desktop, laptop, laptopCert } = await household();
    const roster = await buildDeviceRoster({
      personIdentity: person,
      devices: [{ deviceDid: laptop.did, deviceId: 'laptop-1', addedAt: 2, status: 'revoked' }],
      seq: 5,
    });
    const verdict = await evaluateAuthHello(buildAuthHello({ cert: laptopCert, nonce: mintAuthNonce() }), {
      personDid: person.did, selfDeviceDid: desktop.did, linkDeviceDid: laptop.did, roster,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.defect).toBe('device-revoked');
  });

  test('a newly minted certificate absent from the held roster is refused', async () => {
    const { person, desktop, roster } = await household();
    const unknown = await generateIdentity();
    const unknownCert = await issueDeviceCertificate({
      personIdentity: person, deviceDid: unknown.did, deviceId: 'fresh-after-revocation', seq: 99,
    });
    const verdict = await evaluateAuthHello(
      buildAuthHello({ cert: unknownCert, nonce: mintAuthNonce() }),
      { personDid: person.did, selfDeviceDid: desktop.did, linkDeviceDid: unknown.did, roster },
    );
    expect(verdict).toMatchObject({ ok: false, defect: 'device-not-active' });
  });

  test('a device talking to itself is refused', async () => {
    const { person, desktop, desktopCert } = await household();
    const verdict = await evaluateAuthHello(buildAuthHello({ cert: desktopCert, nonce: mintAuthNonce() }), {
      personDid: person.did, selfDeviceDid: desktop.did, linkDeviceDid: desktop.did, roster: null,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.defect).toBe('self-connection');
  });

  test('cross-protocol: an envelope signature can never verify as an auth proof', async () => {
    const { desktop, laptop } = await household();
    const nonceA = mintAuthNonce();
    const nonceB = mintAuthNonce();
    // The laptop signs an ordinary mesh envelope; an attacker replants the
    // signature bytes as an AUTH_PROOF. Domain separation must refuse it.
    const envelope = await signEnvelope(buildEnvelope({
      ch: 3, typ: 0, from: laptop.did,
      body: { data: 'hi' }, id: 'x', ts: 1,
    }), laptop);
    const verdict = await verifyAuthProof(
      { t: 'AUTH_PROOF', proto: SELF_AUTH_PROTO, sig: envelope.sig },
      {
        roomId: ROOM, peerDeviceDid: laptop.did, selfDeviceDid: desktop.did,
        peerNonce: nonceB, selfNonce: nonceA,
      },
    );
    expect(verdict.ok).toBe(false);
    // …and conversely, proof bytes are domain-tagged so they can't be an envelope.
    const bytes = proofSigningBytes({
      roomId: ROOM, proverDeviceDid: laptop.did, verifierDeviceDid: desktop.did,
      proverNonce: nonceB, verifierNonce: nonceA,
    });
    expect(new TextDecoder().decode(bytes.slice(0, 25))).toBe('peerd/self-device-auth/v1');
  });

  test('malformed hellos are refused with named defects', async () => {
    const { person, desktop, laptop, laptopCert } = await household();
    const context = {
      personDid: person.did, selfDeviceDid: desktop.did, linkDeviceDid: laptop.did, roster: null,
    };
    expect((await evaluateAuthHello(null, context)).defect).toBe('not-auth-hello');
    expect((await evaluateAuthHello({ t: 'AUTH_HELLO', proto: 2, cert: laptopCert, nonce: mintAuthNonce() }, context)).defect).toBe('unsupported-proto');
    expect((await evaluateAuthHello(buildAuthHello({ cert: laptopCert, nonce: 'AAAA' }), context)).defect).toBe('bad-nonce');
    expect((await evaluateAuthHello(buildAuthHello({ cert: { ...laptopCert, v: 9 }, nonce: mintAuthNonce() }), context)).defect).toBe('cert-unsupported-version-9');
  });
});
