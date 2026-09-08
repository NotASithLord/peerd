import { describe, expect, test } from 'bun:test';
import { createKernelDwebVaultEffects } from '../../extension/background/kernel-preview-addon.js';
import { encodeDidKey } from '../../extension/peerd-distributed/identity/did.js';

const makeFixture = (overrides: any = {}) => {
  let stored: string | null = overrides.stored ?? null;
  let writes = 0;
  const audits: any[] = [];
  const effects = createKernelDwebVaultEffects({
    enabled: overrides.enabled ?? true,
    active: overrides.active ?? (() => true),
    vault: {
      isLocked: () => false,
      getSecret: async () => stored,
      setSecret: async (_name: string, value: string) => { stored = value; writes++; },
      ...overrides.vault,
    },
    auditLog: {
      append: async (entry: any) => { audits.push(entry); },
      ...overrides.auditLog,
    },
    listApps: async () => overrides.apps ?? [],
  });
  const custody = {
    handle: (operation: string, args: any = {}) => effects.handle(
      operation === 'get' ? 'identity/read'
        : operation === 'set' ? 'identity/create' : operation,
      args,
    ),
  };
  return { custody, audits, get stored() { return stored; }, get writes() { return writes; } };
};

describe('dweb identity custody', () => {
  test('reads and first-mints the root inside the custody handler', async () => {
    const fixture = makeFixture();
    expect(await fixture.custody.handle('get')).toEqual({ ok: true, value: null });
    expect(await fixture.custody.handle('set', { value: 'root' })).toEqual({ ok: true });
    expect(fixture.stored).toBe('root');
    expect(fixture.audits).toEqual([{ type: 'dweb_identity_issued', details: {} }]);
  });

  test('fails closed when disabled, locked, or given a non-string root', async () => {
    const disabled = makeFixture({ enabled: false });
    expect(await disabled.custody.handle('get')).toEqual({ ok: false, error: 'dweb-disabled' });
    const locked = makeFixture({ vault: { isLocked: () => true } });
    expect(await locked.custody.handle('get')).toEqual({ ok: false, error: 'vault-locked' });
    const fixture = makeFixture();
    expect(await fixture.custody.handle('set', { value: 3 })).toEqual({ ok: false, error: 'value-required' });
  });

  test('refuses oversized identity material before vault access', async () => {
    let reads = 0;
    const fixture = makeFixture({
      vault: { getSecret: async () => { reads += 1; return null; } },
    });
    expect(await fixture.custody.handle('set', { value: 'x'.repeat(64 * 1024 + 1) }))
      .toEqual({ ok: false, error: 'value-too-large' });
    expect(await fixture.custody.handle('identity/commit', {
      value: 'x'.repeat(64 * 1024 + 1), incomingDid: 'did:key:zIncoming',
      expectedExistingDid: null,
    })).toEqual({ ok: false, error: 'value-too-large' });
    expect(reads).toBe(0);
  });

  test('rechecks inside the mutation lane and never overwrites a recovered root', async () => {
    const fixture = makeFixture({ stored: 'recovered-root' });
    expect(await fixture.custody.handle('set', { value: 'stale-mint' }))
      .toEqual({ ok: false, error: 'identity-already-exists' });
    expect(fixture.writes).toBe(0);
  });

  test('blocks first mint while a local shared app still depends on the missing root', async () => {
    const fixture = makeFixture({ apps: [{ shared: true }] });
    expect(await fixture.custody.handle('set', { value: 'replacement-root' }))
      .toEqual({ ok: false, error: 'identity-in-use' });
    expect(fixture.writes).toBe(0);
  });

  test('blocks legacy root minting on an enrolled certificate-only device', async () => {
    const fixture = makeFixture({
      vault: {
        getSecret: async (name: string) => name === 'distributed/self-records/v1'
          ? '{"v":1}' : null,
      },
    });
    expect(await fixture.custody.handle('set', { value: 'unrelated-root' }))
      .toEqual({ ok: false, error: 'certificate-only-device' });
    expect(fixture.writes).toBe(0);
  });

  test('does not report a durable mint as failed when audit append fails', async () => {
    const fixture = makeFixture({
      auditLog: { append: async () => { throw new Error('audit unavailable'); } },
    });
    expect(await fixture.custody.handle('set', { value: 'root' })).toEqual({ ok: true });
    expect(fixture.stored).toBe('root');
  });

  test('commits only the approved old identity and reconciles a landed write', async () => {
    const identity = (lastByte: number) => {
      const pub = new Uint8Array(32);
      pub[31] = lastByte;
      return {
        did: encodeDidKey(pub),
        material: JSON.stringify({
          v: 1,
          seed: btoa(String.fromCharCode(...new Uint8Array(32))),
          pub: btoa(String.fromCharCode(...pub)),
        }),
      };
    };
    const oldIdentity = identity(1);
    const unexpected = identity(2);
    const incoming = identity(3);
    let stored = unexpected.material;
    let writes = 0;
    let reportWriteFailure = false;
    const effects = createKernelDwebVaultEffects({
      enabled: true, active: () => true,
      vault: {
        isLocked: () => false,
        getSecret: async (name: string) => name === 'distributed/identity/v1' ? stored : null,
        setSecret: async (_name: string, value: string) => {
          stored = value;
          writes += 1;
          if (reportWriteFailure) throw new Error('lost acknowledgement');
        },
      },
      auditLog: { append: async () => {} }, listApps: async () => [],
    });
    expect(await effects.handle('identity/commit', {
      value: incoming.material, incomingDid: incoming.did,
    })).toEqual({ ok: false, error: 'identity-cas-required' });
    expect(await effects.handle('identity/commit', {
      value: incoming.material,
      incomingDid: incoming.did,
      expectedExistingDid: oldIdentity.did,
    })).toMatchObject({ ok: false, error: 'identity-changed' });
    expect(writes).toBe(0);

    reportWriteFailure = true;
    expect(await effects.handle('identity/commit', {
      value: incoming.material,
      incomingDid: incoming.did,
      expectedExistingDid: unexpected.did,
    })).toEqual({ ok: true, committed: true, alreadyApplied: true });
    expect(stored).toBe(incoming.material);
    expect(writes).toBe(1);
  });

  test('rechecks the approved identity immediately before the durable write', async () => {
    const identity = (lastByte: number) => {
      const pub = new Uint8Array(32); pub[31] = lastByte;
      return {
        did: encodeDidKey(pub),
        material: JSON.stringify({
          v: 1, seed: btoa(String.fromCharCode(...new Uint8Array(32))),
          pub: btoa(String.fromCharCode(...pub)),
        }),
      };
    };
    const approved = identity(4);
    const changed = identity(5);
    const incoming = identity(6);
    let stored = approved.material;
    let writes = 0;
    const effects = createKernelDwebVaultEffects({
      enabled: true, active: () => true,
      vault: {
        isLocked: () => false,
        getSecret: async (name: string) => name === 'distributed/identity/v1' ? stored : null,
        setSecret: async (_name: string, value: string) => { stored = value; writes++; },
      },
      auditLog: { append: async () => {} },
      listApps: async () => { stored = changed.material; return []; },
    });
    expect(await effects.handle('identity/commit', {
      value: incoming.material, incomingDid: incoming.did,
      expectedExistingDid: approved.did,
    })).toEqual({ ok: false, error: 'identity-changed' });
    expect(writes).toBe(0);
    expect(stored).toBe(changed.material);
  });
});
