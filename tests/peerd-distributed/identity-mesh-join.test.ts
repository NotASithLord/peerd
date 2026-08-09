// The load-bearing integration for portable identity: the DID that
// backup/restore round-trips MUST be the one the p2p mesh joins with.
//
// Restore and mesh-join meet at exactly one place - the vault secret
// distributed/identity/v1. Restore writes it (adoptIdentityRecord ->
// vault.setSecret), and the offscreen mesh host reads it to join
// (client.identityMaterial = loadIdentityMaterial -> identityFromMaterial
// -> joinBaseNetwork, in offscreen/dweb-base.js). This test drives that
// exact seam over a fake secret store: adopt a recovery record, then load
// it back the way the mesh does, and prove the identity signs a
// HELLO-style payload verifiably under the SAME did. If this breaks, a
// restored identity would fail to authenticate on the mesh - the peer
// would recover its key but not its place in the network.

import { describe, test, expect } from 'bun:test';
import {
  buildIdentityRecord, adoptIdentityRecord,
} from '../../extension/peerd-distributed/identity/recovery-record.js';
import {
  mintKeypairMaterial, loadIdentityMaterial, identityFromMaterial, verifySignature,
} from '../../extension/peerd-distributed/identity/keypair.js';

// A fake vault-secret surface - the same get/setSecret shape the SW's
// identity custody exposes to both the transfer helper and the mesh host.
const fakeSecrets = (seed: Record<string, string> = {}) => {
  const m = new Map<string, string>(Object.entries(seed));
  return {
    getSecret: async (name: string) => m.get(name) ?? null,
    setSecret: async (name: string, value: string) => { m.set(name, value); },
    map: m,
  };
};

const IDENTITY_SECRET = 'distributed/identity/v1';

// Exactly what offscreen/dweb-base.js does to obtain the mesh identity:
// client.identityMaterial(io) === loadIdentityMaterial(io), then
// client.identityFromMaterial(material). Reproduced here so the test
// breaks if that consumption path and the stored shape ever diverge.
const meshIdentityFrom = async (io: ReturnType<typeof fakeSecrets>) => {
  const material = await loadIdentityMaterial(io);
  return identityFromMaterial(material);
};

describe('restored identity joins the mesh as the same did', () => {
  test('adopt on a fresh install → the mesh loads and authenticates as that did', async () => {
    // A peer's identity, backed up to a passphrase recovery record.
    const original = await mintKeypairMaterial();
    const record = await buildIdentityRecord({
      material: { seed: original.seed, pub: original.pub },
      wrappers: [{ kind: 'passphrase', passphrase: 'export-passphrase-xyz' }],
    });

    // Fresh install: empty secret store. Restore writes the recovered
    // material to the identity secret, exactly as dwebTransfer.adoptRecord
    // does (vault.setSecret(identitySecretName, outcome.material)).
    const vault = fakeSecrets();
    const outcome = await adoptIdentityRecord({
      record, passphrase: 'export-passphrase-xyz', existingMaterial: null,
    });
    expect(outcome.adopted).toBe(true);
    expect(outcome.did).toBe(original.did);
    await vault.setSecret(IDENTITY_SECRET, outcome.material as string);

    // Now the mesh host starts and reads that secret to join. It must
    // come up as the ORIGINAL did - same place in the network.
    const identity = await meshIdentityFrom(vault);
    expect(identity.did).toBe(original.did);

    // And it must actually authenticate: the mesh HELLO handshake signs
    // with identity.sign and peers verify via verifySignature(did, …).
    const hello = new TextEncoder().encode(`peerd-hello:${identity.did}:room:lobby`);
    const sig = await identity.sign(hello);
    expect(await verifySignature(original.did, sig, hello)).toBe(true);
  });

  test('loading did not fork the identity: the secret is unchanged after a mesh join', async () => {
    const original = await mintKeypairMaterial();
    const vault = fakeSecrets({
      [IDENTITY_SECRET]: JSON.stringify({ v: 1, seed: original.seed, pub: original.pub }),
    });
    const before = vault.map.get(IDENTITY_SECRET);
    const identity = await meshIdentityFrom(vault);
    expect(identity.did).toBe(original.did);
    // A pre-existing identity must be reused verbatim - loadIdentityMaterial
    // must not re-mint and orphan the peer from its network identity.
    expect(vault.map.get(IDENTITY_SECRET)).toBe(before);
    expect(vault.map.size).toBe(1);
  });

  test('replace on a peer that already has a DIFFERENT did → mesh rejoins as the incoming did', async () => {
    // The device is already on the mesh as `local`; the user restores a
    // different identity `incoming` with explicit replace approval.
    const local = await mintKeypairMaterial();
    const incoming = await mintKeypairMaterial();
    const record = await buildIdentityRecord({
      material: { seed: incoming.seed, pub: incoming.pub },
      wrappers: [{ kind: 'passphrase', passphrase: 'pw-replace-123' }],
    });
    const existing = JSON.stringify({ v: 1, seed: local.seed, pub: local.pub });
    const vault = fakeSecrets({ [IDENTITY_SECRET]: existing });

    const outcome = await adoptIdentityRecord({
      record, passphrase: 'pw-replace-123', existingMaterial: existing, replaceExisting: true,
    });
    expect(outcome.adopted).toBe(true);
    expect(outcome.did).toBe(incoming.did);
    await vault.setSecret(IDENTITY_SECRET, outcome.material as string);

    // The runtime restart (stopIdentityRuntime → write → startIdentityRuntime,
    // driven by dwebTransfer) means the NEXT mesh load sees the incoming did.
    const identity = await meshIdentityFrom(vault);
    expect(identity.did).toBe(incoming.did);
    expect(identity.did).not.toBe(local.did);
  });
});
