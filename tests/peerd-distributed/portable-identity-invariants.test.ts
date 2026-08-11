// The portable-identity security invariants (issue §13), each asserted
// directly against the shipped code. This file is the executable version of
// the threat model: if one of these ever passes when it should fail, the
// arc's trust story is broken, and the failing test names which invariant.
//
// Invariants 1-18 from the issue, in order. A few are structural (enforced
// by construction rather than by a runtime check) — those assert the
// structure that makes the attack impossible, and say so.

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateIdentity, mintKeypairMaterial, identityFromMaterial } from '../../extension/peerd-distributed/identity/keypair.js';
import { issueDeviceCertificate, buildDeviceRoster } from '../../extension/peerd-distributed/identity/device-certificate.js';
import { buildPasskeyBinding } from '../../extension/peerd-distributed/identity/passkey-binding.js';
import {
  deriveRendezvousTopic, mintDiscoverySecret, rendezvousWindow,
  SELF_RENDEZVOUS_DOMAIN, ENROLL_RENDEZVOUS_DOMAIN,
} from '../../extension/peerd-distributed/self/rendezvous.js';
import {
  buildAuthHello, evaluateAuthHello, buildAuthProof, verifyAuthProof, mintAuthNonce,
} from '../../extension/peerd-distributed/self/handshake.js';
import { createSelfDeviceCoordinator } from '../../extension/peerd-distributed/self/coordinator.js';
import { createSyncSource } from '../../extension/peerd-distributed/self/host.js';
import { buildSnapshotOffer, validateSnapshotManifest, SYNC_SURFACES, encodeSurfacePayload } from '../../extension/peerd-distributed/self/sync.js';
import { ensureFounderCustody } from '../../extension/peerd-distributed/self/custody.js';
import { STORE_REGISTRY, storeEntry } from '../../extension/peerd-runtime/lifecycle/store-registry.js';
import { isCustodySecretName } from '../../extension/peerd-runtime/transfer/transfer.js';
import { fabricateCredential } from '../helpers/webauthn-fixtures';

const ROOM = 'peerd-self/topic';

const fakeVault = () => {
  const m = new Map<string, string>();
  return {
    getSecret: async (name: string) => m.get(name) ?? null,
    setSecret: async (name: string, value: string) => { m.set(name, value); },
    map: m,
  };
};

describe('1-2: the DID and the rendezvous topic do not reveal each other', () => {
  test('knowing a DID cannot produce the topic (the secret is independent of identity)', async () => {
    const person = await generateIdentity();
    const secret = mintDiscoverySecret();
    const topic = await deriveRendezvousTopic(secret, 100);
    // Structural: the derivation module imports NO identity code — its only
    // inputs are (secret, domain, epoch), so there is no function an
    // attacker holding the DID could feed it. (Comments mention "did" while
    // explaining the property, so assert on the CODE, not the prose.)
    const rendezvous = readFileSync(
      join(import.meta.dir, '..', '..', 'extension', 'peerd-distributed', 'self', 'rendezvous.js'), 'utf8');
    const code = rendezvous.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/from\s+['"][^'"]*identity/);
    expect(code).not.toMatch(/\bdid\b/i);
    // A guess built from the DID bytes yields an unrelated topic.
    const didAsSecret = new Uint8Array(32);
    didAsSecret.set(new TextEncoder().encode(person.did).slice(0, 32));
    expect(await deriveRendezvousTopic(didAsSecret, 100)).not.toBe(topic);
  });

  test('observing a topic cannot produce the DID (HMAC output, no identity input)', async () => {
    const secret = mintDiscoverySecret();
    const topic = await deriveRendezvousTopic(secret, 100);
    expect(topic).toMatch(/^[0-9a-f]{64}$/); // opaque MAC output
    // Two different people with the same secret would collide on the topic —
    // proof the topic carries no identity information at all.
    const a = await generateIdentity();
    const b = await generateIdentity();
    expect(a.did).not.toBe(b.did);
    expect(await deriveRendezvousTopic(secret, 100)).toBe(await deriveRendezvousTopic(secret, 100));
  });
});

describe('3-6: topic ≠ trust; DID claim ≠ authentication', () => {
  test('3: joining/guessing the topic establishes NOTHING', async () => {
    // Proven end-to-end in self-coordinator.test.ts (the intruder case);
    // here: the hello evaluator ignores the room entirely when deciding
    // trust — it evaluates the certificate chain, not membership.
    const person = await generateIdentity();
    const device = await generateIdentity();
    const stranger = await generateIdentity();
    const strangerRoot = await generateIdentity();
    const strangerCert = await issueDeviceCertificate({
      personIdentity: strangerRoot, deviceDid: stranger.did, deviceId: 's', now: 1,
    });
    const verdict = await evaluateAuthHello(buildAuthHello({ cert: strangerCert, nonce: mintAuthNonce() }), {
      personDid: person.did, selfDeviceDid: device.did, linkDeviceDid: stranger.did, roster: null,
    });
    expect(verdict.ok).toBe(false);
  });

  test('4: the same DID string is not sufficient authentication', async () => {
    // An attacker who somehow learned the person DID still cannot produce a
    // certificate under it: issuing requires the ROOT private key.
    const person = await generateIdentity();
    const attacker = await generateIdentity();
    const attackerDevice = await generateIdentity();
    // Best the attacker can do: sign a cert with their own key and relabel.
    const forged = await issueDeviceCertificate({
      personIdentity: attacker, deviceDid: attackerDevice.did, deviceId: 'x', now: 1,
    });
    const relabelled = { ...forged, personDid: person.did };
    const victimDevice = await generateIdentity();
    const verdict = await evaluateAuthHello(buildAuthHello({ cert: relabelled, nonce: mintAuthNonce() }), {
      personDid: person.did, selfDeviceDid: victimDevice.did, linkDeviceDid: attackerDevice.did, roster: null,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.defect).toBe('cert-signature-invalid');
  });

  test('5: a valid certificate without the device private key is insufficient', async () => {
    const person = await generateIdentity();
    const laptop = await generateIdentity();
    const desktop = await generateIdentity();
    const thief = await generateIdentity();
    const laptopCert = await issueDeviceCertificate({
      personIdentity: person, deviceDid: laptop.did, deviceId: 'l', now: 1,
    });
    // The thief replays the laptop's genuine certificate over their own link.
    const verdict = await evaluateAuthHello(buildAuthHello({ cert: laptopCert, nonce: mintAuthNonce() }), {
      personDid: person.did, selfDeviceDid: desktop.did, linkDeviceDid: thief.did, roster: null,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.defect).toBe('cert-device-did-mismatch');
  });

  test('6: a device key without a person-root certificate is insufficient', async () => {
    const person = await generateIdentity();
    const desktop = await generateIdentity();
    const rogue = await generateIdentity();
    // No certificate at all.
    for (const cert of [undefined, null, {}, { v: 1 }]) {
      const verdict = await evaluateAuthHello(
        { t: 'AUTH_HELLO', proto: 1, cert, nonce: mintAuthNonce() },
        { personDid: person.did, selfDeviceDid: desktop.did, linkDeviceDid: rogue.did, roster: null },
      );
      expect(verdict.ok).toBe(false);
    }
  });
});

describe('7-8: the hosted page holds no authority and sees no profile', () => {
  test('7: passkey authentication alone gives the website no signing capability', () => {
    const page = readFileSync(join(import.meta.dir, '..', '..', 'web-identity', 'ceremony.js'), 'utf8');
    // The page never derives, wraps, signs, or stores anything; it relays raw
    // authenticator output. (Full posture suite: tests/web/identity-ceremony-posture.)
    for (const forbidden of ['deriveBits', 'deriveKey', 'importKey', 'HKDF', 'sign(']) {
      expect(page).not.toContain(forbidden);
    }
  });

  test('8: id.peerd.ai never receives the profile during peer sync', () => {
    const page = readFileSync(join(import.meta.dir, '..', '..', 'web-identity', 'ceremony.js'), 'utf8');
    // Structural: the page has no network egress at all (CSP connect-src
    // 'none' + no fetch/XHR/WebSocket), so it cannot receive or forward
    // anything, and the sync protocol is peer-to-peer by construction —
    // no frame in sync.js names an origin or URL.
    for (const forbidden of ['fetch(', 'XMLHttpRequest', 'WebSocket']) {
      expect(page).not.toContain(forbidden);
    }
    const sync = readFileSync(
      join(import.meta.dir, '..', '..', 'extension', 'peerd-distributed', 'self', 'sync.js'), 'utf8');
    expect(sync).not.toContain('http');
  });
});

describe('9-10: device keys stay home; the root stops signing routine traffic', () => {
  test('9: the device private key never leaves the installation', async () => {
    const io = fakeVault();
    await ensureFounderCustody({ io, label: 'Desktop' });
    // It lives under the prefix the export shaper structurally refuses…
    expect([...io.map.keys()]).toContain('distributed/device-key/v1');
    expect(isCustodySecretName('distributed/device-key/v1')).toBe(true);
    // …it is registry-marked device-bound and portable by NO axis…
    const entry = storeEntry('device-key')!;
    expect(entry.deviceBound).toBe(true);
    expect(entry.portable).toBe(false);
    expect(entry.personPortable ?? false).toBe(false);
    // …and it is not among the surfaces sync can even name.
    expect(SYNC_SURFACES).not.toContain('device-key');
    expect(SYNC_SURFACES).not.toContain('device-keys');
  });

  test('10: the coordinator signs with the DEVICE key and never holds the root', async () => {
    const io = fakeVault();
    const founder = await ensureFounderCustody({ io, label: 'Desktop' });
    const device = await identityFromMaterial(JSON.parse(io.map.get('distributed/device-key/v1')!));
    // A proof produced by the coordinator's signer verifies under the DEVICE
    // did, not the person did — routine traffic is device-signed.
    const peer = await generateIdentity();
    const selfNonce = mintAuthNonce();
    const peerNonce = mintAuthNonce();
    const proof = await buildAuthProof({
      deviceSign: device.sign, roomId: ROOM,
      selfDeviceDid: device.did, peerDeviceDid: peer.did, selfNonce, peerNonce,
    });
    expect((await verifyAuthProof(proof, {
      roomId: ROOM, peerDeviceDid: device.did, selfDeviceDid: peer.did,
      peerNonce: selfNonce, selfNonce: peerNonce,
    })).ok).toBe(true);
    // The same proof does NOT verify under the person root.
    expect((await verifyAuthProof(proof, {
      roomId: ROOM, peerDeviceDid: founder.personDid, selfDeviceDid: peer.did,
      peerNonce: selfNonce, selfNonce: peerNonce,
    })).ok).toBe(false);
    // The coordinator's input surface carries no root signer.
    const source = readFileSync(
      join(import.meta.dir, '..', '..', 'extension', 'peerd-distributed', 'self', 'coordinator.js'), 'utf8');
    expect(source).not.toContain('personIdentity');
  });
});

describe('11-12: self-device status cannot be forged or bypassed', () => {
  test('11: self-device status is not reachable through ordinary peer APIs', () => {
    const source = readFileSync(
      join(import.meta.dir, '..', '..', 'extension', 'peerd-distributed', 'self', 'coordinator.js'), 'utf8');
    // The ONLY writer of status:'self' is maybePromote, and it demands both
    // verification directions — there is no setter an API could call.
    const promotions = source.match(/status\s*=\s*'self'/g) ?? [];
    expect(promotions.length).toBe(1);
    expect(source).toMatch(/if\s*\(entry\.selfVerified\s*&&\s*entry\.peerVerified\)/);
    // No exported mutator.
    expect(source).not.toMatch(/markSelfDevice|setSelfDevice|trustPeer/);
  });

  test('12: state-transfer endpoints refuse non-self peers', async () => {
    const bytes = encodeSurfacePayload({ v: 1, settings: { theme: 'dark' } });
    const { manifest } = await buildSnapshotOffer({ surfaces: { settings: { bytes, version: 1 } } });
    const sent: any[] = [];
    const source = createSyncSource({
      coordinator: { isSelfDevice: () => false }, // nobody is authenticated
      send: async (_to, frame) => { sent.push(frame); },
      manifest,
      readSurfaceBytes: () => bytes,
    });
    await source.onFrame('did:key:zStranger', {
      t: 'SYNC_PULL', proto: 1, snapshotId: manifest.snapshotId, surface: 'settings',
    });
    expect(sent).toEqual([]);
  });
});

describe('13-14: consent and provenance never travel', () => {
  test('13: permission grants never arrive via profile sync', () => {
    const grants = storeEntry('permission-grants')!;
    expect(grants.personPortable ?? false).toBe(false);
    expect(grants.portable).toBe(false);
    expect(SYNC_SURFACES).not.toContain('permission-grants');
    expect(SYNC_SURFACES).not.toContain('learnedOrigins');
  });

  test('14: audit provenance is not rewritten', () => {
    const audit = storeEntry('audit')!;
    expect(audit.personPortable ?? false).toBe(false);
    expect(audit.portable).toBe(false);
    expect(SYNC_SURFACES).not.toContain('audit');
  });

  test('live engine handles are excluded too (§10)', () => {
    const engines = storeEntry('engine-registries')!;
    expect(engines.deviceBound).toBe(true);
    expect(engines.personPortable ?? false).toBe(false);
  });
});

describe('15-16: discovery rotates; proofs do not replay', () => {
  test('15: discovery identifiers rotate and are domain-separated', async () => {
    const secret = mintDiscoverySecret();
    expect(await deriveRendezvousTopic(secret, 1)).not.toBe(await deriveRendezvousTopic(secret, 2));
    expect(await deriveRendezvousTopic(secret, 1, SELF_RENDEZVOUS_DOMAIN))
      .not.toBe(await deriveRendezvousTopic(secret, 1, ENROLL_RENDEZVOUS_DOMAIN));
    const window = await rendezvousWindow(secret, { now: 10 * 6 * 3600_000, skew: 1 });
    expect(new Set(window.map((w) => w.topic)).size).toBe(window.length); // all distinct
  });

  test('16: replayed device-auth proofs fail', async () => {
    const person = await generateIdentity();
    const desktop = await generateIdentity();
    const laptop = await generateIdentity();
    const oldSelf = mintAuthNonce();
    const oldPeer = mintAuthNonce();
    const recorded = await buildAuthProof({
      deviceSign: laptop.sign, roomId: ROOM,
      selfDeviceDid: laptop.did, peerDeviceDid: desktop.did,
      selfNonce: oldPeer, peerNonce: oldSelf,
    });
    // A fresh session issues new nonces; the recording is worthless.
    expect((await verifyAuthProof(recorded, {
      roomId: ROOM, peerDeviceDid: laptop.did, selfDeviceDid: desktop.did,
      peerNonce: mintAuthNonce(), selfNonce: mintAuthNonce(),
    })).ok).toBe(false);
    void person;
  });
});

describe('17-18: no silent enrollment, no payload-driven custody writes', () => {
  test('17: a webpage cannot trigger silent enrollment (gesture + extension origin + assertion)', () => {
    const page = readFileSync(join(import.meta.dir, '..', '..', 'web-identity', 'ceremony.js'), 'utf8');
    // Three independent barriers, all in code:
    expect(page).toMatch(/runButton\.addEventListener\('click'/);            // user gesture
    expect(page).toMatch(/if\s*\(!EXTENSION_ORIGIN\.test\(event\.origin\)\)/); // extension-origin only
    expect(page).toMatch(/window\.top\s*!==\s*window\.self/);                 // not embeddable
    // And the grant additionally requires a sponsor-verified assertion:
    const enroll = readFileSync(
      join(import.meta.dir, '..', '..', 'extension', 'peerd-distributed', 'self', 'enroll.js'), 'utf8');
    expect(enroll).toContain('verifyPasskeyAssertion');
  });

  test('18: a hostile sync payload cannot overwrite identity or device custody', async () => {
    // The surface vocabulary is CLOSED — no payload can name an identity or
    // custody store, so there is no path from a sync frame to those writes.
    for (const forbidden of ['dweb-identity', 'device-key', 'vault', 'identity', 'permission-grants', 'audit']) {
      expect(SYNC_SURFACES).not.toContain(forbidden);
    }
    // A manifest inventing one is refused structurally.
    const bytes = encodeSurfacePayload({ v: 1 });
    const { manifest } = await buildSnapshotOffer({ surfaces: { settings: { bytes, version: 1 } } });
    expect(validateSnapshotManifest({
      ...manifest,
      surfaces: [{ name: 'dweb-identity', version: 1, bytes: 10, hash: 'a'.repeat(64) }],
    })).toMatch(/unknown-surface/);
    // And no registry store maps identity custody to a sync surface.
    for (const entry of STORE_REGISTRY) {
      if (entry.store === 'dweb-identity' || entry.store === 'device-key') {
        expect(entry.syncSurface).toBeUndefined();
      }
    }
  });
});

describe('the enrollment authority is revocable without changing the DID', () => {
  test('revoking a passkey and a device leaves the person DID untouched', async () => {
    const material = await mintKeypairMaterial();
    const person = await identityFromMaterial(material);
    const passkey = await fabricateCredential(-7);
    const credential = {
      credentialId: passkey.credentialId, alg: passkey.alg,
      publicKeySpki: passkey.publicKeySpki, addedAt: 1, status: 'active' as const,
    };
    const device = await generateIdentity();
    const v1Binding = await buildPasskeyBinding({ personIdentity: person, credentials: [credential], seq: 1 });
    const v1Roster = await buildDeviceRoster({
      personIdentity: person,
      devices: [{ deviceDid: device.did, deviceId: 'd', addedAt: 1, status: 'active' }],
      seq: 1,
    });
    const v2Binding = await buildPasskeyBinding({
      personIdentity: person, credentials: [{ ...credential, status: 'revoked' }], seq: 2,
    });
    const v2Roster = await buildDeviceRoster({
      personIdentity: person,
      devices: [{ deviceDid: device.did, deviceId: 'd', addedAt: 1, status: 'revoked' }],
      seq: 2,
    });
    expect(v2Binding.personDid).toBe(v1Binding.personDid);
    expect(v2Roster.personDid).toBe(v1Roster.personDid);
    expect(v2Binding.personDid).toBe(material.did);
  });
});
