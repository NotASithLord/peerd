import { describe, test, expect } from 'bun:test';
import {
  createPersistentIdentity,
  importIdentity,
  verifySignature,
} from '../../extension/peerd-distributed/identity/keypair.js';

// A fake vault-secret surface: same get/setSecret shape, no crypto, no
// browser. The identity module never knows the difference — IO is injected.
const fakeSecrets = () => {
  const m = new Map<string, string>();
  return {
    getSecret: async (name: string) => m.get(name) ?? null,
    setSecret: async (name: string, value: string) => { m.set(name, value); },
    dump: () => m,
  };
};

describe('persistent identity', () => {
  test('first run creates; second run reloads the SAME did', async () => {
    const io = fakeSecrets();
    const a = await createPersistentIdentity(io);
    const b = await createPersistentIdentity(io);
    expect(a.did).toBe(b.did);
    expect(a.did.startsWith('did:key:z')).toBe(true);
    expect(io.dump().size).toBe(1); // exactly one secret written
  });

  test('a reloaded identity signs verifiably under the stored did', async () => {
    const io = fakeSecrets();
    await createPersistentIdentity(io); // create
    const reloaded = await createPersistentIdentity(io); // reload path
    const bytes = new TextEncoder().encode('phase 1');
    const sig = await reloaded.sign(bytes);
    expect(await verifySignature(reloaded.did, sig, bytes)).toBe(true);
  });

  test('two stores yield two distinct identities', async () => {
    const a = await createPersistentIdentity(fakeSecrets());
    const b = await createPersistentIdentity(fakeSecrets());
    expect(a.did).not.toBe(b.did);
  });

  test('the stored secret holds seed AND pub (recovery needs both)', async () => {
    const io = fakeSecrets();
    await createPersistentIdentity(io);
    const stored = JSON.parse([...io.dump().values()][0]);
    expect(stored.v).toBe(1);
    expect(typeof stored.seed).toBe('string');
    expect(typeof stored.pub).toBe('string');
  });

  test('importIdentity rejects a wrong-size seed', async () => {
    await expect(
      importIdentity({ seed: new Uint8Array(16), publicKey: new Uint8Array(32) }),
    ).rejects.toThrow('32 bytes');
  });
});
