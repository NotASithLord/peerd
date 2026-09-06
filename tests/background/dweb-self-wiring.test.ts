// The service-worker half of same-user device sync: the custody allowlist
// and the two relay routes the offscreen host reaches.
//
// These are the seams where the wiring can be wrong in a way no protocol
// test would catch: the offscreen document is the process that talks to the
// network, and these are the only two doors it has into the vault and the
// stores. Both must be closed to everyone else.

import { describe, test, expect } from 'bun:test';
import { createKernelDwebVaultEffects } from '../../extension/background/kernel-preview-addon.js';
import { makeDwebSelfRoutes } from '../../extension/background/routes/dweb-self.js';
import { encodeDidKey } from '../../extension/peerd-distributed/identity/did.js';

const IDENTITY_SECRET = 'distributed/identity/v1';
const SELF_CUSTODY_SECRET_NAMES = Object.freeze([
  'distributed/device-key/v1',
  'distributed/self-discovery/v1',
  'distributed/self-records/v1',
]);

const fakeVault = (seed: Record<string, string> = {}) => {
  const map = new Map(Object.entries(seed));
  let locked = false;
  return {
    map,
    lock: () => { locked = true; },
    isLocked: () => locked,
    getSecret: async (name: string) => map.get(name) ?? null,
    setSecret: async (name: string, value: string) => { map.set(name, value); },
  };
};

const custodyFor = (vault: ReturnType<typeof fakeVault>, overrides: any = {}) => {
  const effects = createKernelDwebVaultEffects({
    enabled: overrides.enabled ?? true,
    active: overrides.active ?? (() => true),
    vault,
    auditLog: { append: async () => {} },
    listApps: async () => [],
  });
  return {
    handle: (operation: string, args: any = {}) => effects.handle(
      operation === 'self-get' ? 'self/read' : 'self/write', args,
    ),
  };
};

describe('self-device custody allowlist', () => {
  test('serves exactly the three self-device secrets, and nothing else', async () => {
    const vault = fakeVault({
      'distributed/device-key/v1': '{"seed":"d"}',
      'distributed/self-discovery/v1': 'AAAA',
      'distributed/self-records/v1': '{"v":1}',
      [IDENTITY_SECRET]: '{"seed":"THE-ROOT"}',
      'provider:anthropic': 'sk-secret',
    });
    const custody = custodyFor(vault);

    for (const name of SELF_CUSTODY_SECRET_NAMES) {
      expect(await custody.handle('self-get', { name }))
        .toEqual({ ok: true, value: vault.map.get(name) ?? null });
    }
    // The root, by its own name, through the parameterized path.
    expect(await custody.handle('self-get', { name: IDENTITY_SECRET }))
      .toEqual({ ok: false, error: 'secret-not-allowed' });
    // Any other vault secret, e.g. a provider API key.
    expect(await custody.handle('self-get', { name: 'provider:anthropic' }))
      .toEqual({ ok: false, error: 'secret-not-allowed' });
    expect(await custody.handle('self-get', { name: '' }))
      .toEqual({ ok: false, error: 'secret-not-allowed' });
    expect(await custody.handle('self-get', {} as any))
      .toEqual({ ok: false, error: 'secret-not-allowed' });
  });

  test('the allowlist cannot be widened into the root by a lookalike name', async () => {
    const vault = fakeVault({ [IDENTITY_SECRET]: 'root' });
    const custody = custodyFor(vault);
    for (const name of [
      'distributed/identity/v1 ', ' distributed/identity/v1', 'distributed/identity/v2',
      'distributed/device-key/v1/../identity/v1', 'DISTRIBUTED/IDENTITY/V1',
    ]) {
      expect((await custody.handle('self-get', { name })).ok).toBe(false);
    }
  });

  test('writes are bounded and refused when the vault is locked', async () => {
    const vault = fakeVault();
    const custody = custodyFor(vault);
    const name = 'distributed/self-records/v1';
    const records = JSON.stringify({ roster: { personDid: 'did:key:zPerson', seq: 1, sig: 'sig-1' } });
    expect(await custody.handle('self-set', { name, value: records })).toEqual({ ok: true });
    expect(vault.map.get(name)).toBe(records);
    expect(await custody.handle('self-set', { name, value: 'x'.repeat(300_000) }))
      .toEqual({ ok: false, error: 'value-too-large' });
    expect(await custody.handle('self-set', { name, value: 42 as any }))
      .toEqual({ ok: false, error: 'value-required' });

    vault.lock();
    expect(await custody.handle('self-get', { name })).toEqual({ ok: false, error: 'vault-locked' });
  });

  test('roster custody rejects rollback and same-sequence equivocation', async () => {
    const vault = fakeVault();
    const custody = custodyFor(vault);
    const name = 'distributed/self-records/v1';
    const row = (seq: number, sig = `sig-${seq}`) => JSON.stringify({
      certificate: {}, roster: { personDid: 'did:key:zPerson', seq, sig },
    });
    expect(await custody.handle('self-set', { name, value: row(6) })).toEqual({ ok: true });
    expect(await custody.handle('self-set', { name, value: row(7) })).toEqual({ ok: true });
    expect(await custody.handle('self-set', { name, value: row(6) }))
      .toEqual({ ok: false, error: 'roster-rollback' });
    expect(await custody.handle('self-set', { name, value: row(7, 'different') }))
      .toEqual({ ok: false, error: 'roster-equivocation' });
    expect(vault.map.get(name)).toBe(row(7));
  });

  test('self records cannot commit for a different person after root mint wins the shared lane', async () => {
    const pub = new Uint8Array(32);
    pub[31] = 7;
    const rootDid = encodeDidKey(pub);
    const root = JSON.stringify({
      v: 1, seed: btoa(String.fromCharCode(...new Uint8Array(32))),
      pub: btoa(String.fromCharCode(...pub)),
    });
    const vault = fakeVault({ [IDENTITY_SECRET]: root });
    const custody = custodyFor(vault);
    const name = 'distributed/self-records/v1';
    const mismatched = JSON.stringify({
      certificate: { personDid: 'did:key:zDifferent' },
      roster: { personDid: 'did:key:zDifferent', seq: 1, sig: 'sig' },
    });
    expect(await custody.handle('self-set', { name, value: mismatched }))
      .toEqual({ ok: false, error: 'identity-self-mismatch' });
    expect(vault.map.get(name)).toBeUndefined();

    const matching = JSON.stringify({
      certificate: { personDid: rootDid }, roster: { personDid: rootDid, seq: 1, sig: 'sig' },
    });
    expect(await custody.handle('self-set', { name, value: matching })).toEqual({ ok: true });
  });

  test('inert when the build or the setting says so', async () => {
    const vault = fakeVault({ 'distributed/self-records/v1': '{}' });
    const name = 'distributed/self-records/v1';
    expect(await custodyFor(vault, { enabled: false }).handle('self-get', { name }))
      .toEqual({ ok: false, error: 'dweb-disabled' });
    expect(await custodyFor(vault, { active: () => false }).handle('self-get', { name }))
      .toEqual({ ok: false, error: 'dweb-disabled' });
  });

  test('either half of an interrupted enrollment blocks a replacement person root', async () => {
    const mint = (vault: ReturnType<typeof fakeVault>) => createKernelDwebVaultEffects({
      enabled: true, active: () => true, vault,
      auditLog: { append: async () => {} }, listApps: async () => [],
    }).handle('identity/create', { value: 'root' });
    expect((await mint(fakeVault())).ok).toBe(true);
    expect(await mint(fakeVault({
      'distributed/self-records/v1': '{"v":1}',
    }))).toMatchObject({ ok: false, error: 'certificate-only-device' });
    expect(await mint(fakeVault({
      'distributed/self-discovery/v1': 'AAAA',
    }))).toMatchObject({ ok: false, error: 'certificate-only-device' });
    // A pre-minted per-install device key alone is not an enrollment commit.
    expect((await mint(fakeVault({
      'distributed/device-key/v1': '{"seed":"d"}',
    }))).ok).toBe(true);
  });
});

const routesFor = (overrides: Record<string, any> = {}) => {
  const baseHostCalls: Array<{ type: string; payload: any }> = [];
  const audited: any[] = [];
  const applied: Array<{ surface: string; payload: any }> = [];
  const routes = makeDwebSelfRoutes({
    dwebReady: async () => true,
    isOffscreenSender: (sender: any) => sender?.offscreen === true,
    callBaseHost: async (type: string, payload: any = {}) => {
      baseHostCalls.push({ type, payload });
      if (type === 'dweb/base-host/self-start') return { ok: true, running: true };
      if (type === 'dweb/base-host/self-status') {
        return { ok: true, running: true, candidates: [{ deviceDid: 'did:key:zPeer' }], selfDevices: [] };
      }
      return { ok: true, offered: ['did:key:zPeer'] };
    },
    auditLog: { append: async (entry: any) => { audited.push(entry); } },
    surfaceShapers: {
      settings: async () => ({ v: 1, settings: { theme: 'dark' } }),
      memory: async () => ({ v: 1, memory: { docs: [] } }),
      broken: async () => { throw new Error('store unavailable'); },
      withheld: async () => null,
    },
    surfaceAppliers: {
      settings: async (payload: any) => { applied.push({ surface: 'settings', payload }); return { written: 1 }; },
    },
    now: () => 1_700_000_000_000,
    ...overrides,
  } as any);
  return { routes, baseHostCalls, audited, applied };
};

const OFFSCREEN = { offscreen: true };

describe('the offscreen host reaches the stores through exactly two doors', () => {
  test('read-surface and apply-surface refuse any sender that is not the offscreen doc', async () => {
    const { routes, applied } = routesFor();
    await routes['dweb/self-prepare-offer']({ surfaces: ['settings'] });

    // A side panel, an options page, a content script: all just senders.
    for (const sender of [undefined, {}, { tab: { id: 3 } }, { offscreen: false }]) {
      expect(await routes['dweb/self-read-surface']({ snapshotId: 'x', surface: 'settings' }, sender))
        .toEqual({ ok: false, error: 'unauthorized-relay' });
      expect(await routes['dweb/self-apply-surface']({ surface: 'settings', bytes: 'e30=' }, sender))
        .toEqual({ ok: false, error: 'unauthorized-relay' });
    }
    expect(applied).toEqual([]); // nothing was written by any of them
  });

  test('prepare-offer shapes only what was asked for, and says what it could not', async () => {
    const { routes, baseHostCalls, audited } = routesFor();
    const reply = await routes['dweb/self-prepare-offer']({
      surfaces: ['settings', 'memory', 'broken', 'withheld', 'secrets'],
      label: 'Desktop',
    });
    expect(reply.ok).toBe(true);
    expect(reply.surfaces.sort()).toEqual(['memory', 'settings']);
    // A shaper that threw, one that withheld, and one this build does not
    // have are all reported rather than silently missing.
    expect(reply.unavailable.sort()).toEqual(['broken', 'secrets', 'withheld']);

    const offer = baseHostCalls.find((c) => c.type === 'dweb/base-host/self-offer');
    expect(offer).toBeDefined();
    const manifest = offer!.payload.manifest;
    expect(manifest.label).toBe('Desktop');
    expect(manifest.surfaces.map((s: any) => s.name).sort()).toEqual(['memory', 'settings']);
    // Every entry carries a real byte count and a hex SHA-256.
    for (const entry of manifest.surfaces) {
      expect(entry.bytes).toBeGreaterThan(0);
      expect(entry.hash).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(audited.map((e) => e.type)).toContain('dweb_self_snapshot_offered');
  });

  test('prepare-offer deduplicates names and refuses a surface above its wire cap', async () => {
    const { routes, baseHostCalls } = routesFor();
    const deduped = await routes['dweb/self-prepare-offer']({ surfaces: ['settings', 'settings'] });
    expect(deduped.ok).toBe(true);
    expect(baseHostCalls.at(-1)?.payload.manifest.surfaces.map((s: any) => s.name))
      .toEqual(['settings']);

    const { routes: capped, baseHostCalls: cappedCalls } = routesFor({
      surfaceByteCaps: { settings: 8 },
    });
    const cappedReply = await capped['dweb/self-prepare-offer']({ surfaces: ['settings', 'settings'] });
    expect(cappedReply).toMatchObject({ ok: true, surfaces: [], unavailable: ['settings'] });
    expect(cappedCalls.at(-1)?.payload.manifest).toMatchObject({
      surfaces: [], unavailable: { settings: 'over-transfer-cap' },
    });
  });

  test('a remote restore request targets its offer to that proven self device', async () => {
    const { routes, baseHostCalls } = routesFor();
    const reply = await routes['dweb/self-prepare-offer']({
      surfaces: ['settings'], targetDeviceDid: 'did:key:zReceiver',
    });
    expect(reply.ok).toBe(true);
    const offer = baseHostCalls.find((call) => call.type === 'dweb/base-host/self-offer');
    expect(offer?.payload.targetDeviceDid).toBe('did:key:zReceiver');
  });

  test('a surface never asked for is not in the snapshot, so it cannot be served', async () => {
    const { routes } = routesFor();
    const prepared = await routes['dweb/self-prepare-offer']({ surfaces: ['settings'] });
    const { snapshotId } = prepared;
    expect((await routes['dweb/self-read-surface']({ snapshotId, surface: 'settings' }, OFFSCREEN)).ok).toBe(true);
    // `memory` has a shaper, but this offer withheld it. Consent by omission.
    expect(await routes['dweb/self-read-surface']({ snapshotId, surface: 'memory' }, OFFSCREEN))
      .toEqual({ ok: false, error: 'unavailable' });
    // And an unknown snapshot serves nothing at all.
    expect(await routes['dweb/self-read-surface']({ snapshotId: 'other', surface: 'settings' }, OFFSCREEN))
      .toEqual({ ok: false, error: 'unavailable' });
  });

  test('a re-pull of the same surface serves identical bytes (idempotent recovery)', async () => {
    const { routes } = routesFor();
    const { snapshotId } = await routes['dweb/self-prepare-offer']({ surfaces: ['settings'] });
    const first = await routes['dweb/self-read-surface']({ snapshotId, surface: 'settings' }, OFFSCREEN);
    const second = await routes['dweb/self-read-surface']({ snapshotId, surface: 'settings' }, OFFSCREEN);
    expect(second.bytes).toBe(first.bytes);
  });

  test('an expired snapshot cannot be served without a newer prepare call', async () => {
    let clock = 1_700_000_000_000;
    const { routes } = routesFor({ now: () => clock });
    const { snapshotId } = await routes['dweb/self-prepare-offer']({ surfaces: ['settings'] });
    clock += 30 * 60_000 + 1;
    expect(await routes['dweb/self-read-surface']({ snapshotId, surface: 'settings' }, OFFSCREEN))
      .toEqual({ ok: false, error: 'snapshot-expired' });
    expect(await routes['dweb/self-read-surface']({ snapshotId, surface: 'settings' }, OFFSCREEN))
      .toEqual({ ok: false, error: 'unavailable' });
  });

  test('the snapshot cache evicts its oldest entry instead of growing for 30 minutes', async () => {
    const { routes } = routesFor();
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) {
      ids.push((await routes['dweb/self-prepare-offer']({ surfaces: ['settings'] })).snapshotId);
    }
    expect(await routes['dweb/self-read-surface'](
      { snapshotId: ids[0], surface: 'settings' }, OFFSCREEN,
    )).toEqual({ ok: false, error: 'unavailable' });
    expect((await routes['dweb/self-read-surface'](
      { snapshotId: ids.at(-1), surface: 'settings' }, OFFSCREEN,
    )).ok).toBe(true);
  });

  test('an unknown surface name is refused, never applied generically', async () => {
    const { routes, applied } = routesFor();
    expect(await routes['dweb/self-apply-surface'](
      { surface: 'permissionGrants', bytes: btoa('{"v":1}'), sourceDeviceDid: 'did:key:zA' }, OFFSCREEN,
    )).toEqual({ ok: false, error: 'unknown-surface' });
    expect(await routes['dweb/self-apply-surface'](
      { surface: '__proto__', bytes: btoa('{}'), sourceDeviceDid: 'did:key:zA' }, OFFSCREEN,
    )).toEqual({ ok: false, error: 'unknown-surface' });
    expect(applied).toEqual([]);
  });

  test('an applied surface reaches its applier and is audited with its provenance', async () => {
    const { routes, applied, audited } = routesFor();
    const reply = await routes['dweb/self-apply-surface']({
      surface: 'settings',
      bytes: btoa(JSON.stringify({ v: 1, settings: { theme: 'dark' } })),
      sourceDeviceDid: 'did:key:zSource',
    }, OFFSCREEN);
    expect(reply).toEqual({ ok: true, result: { written: 1 } });
    expect(applied[0].payload.settings.theme).toBe('dark');
    const entry = audited.find((e) => e.type === 'dweb_self_surface_applied');
    expect(entry.details).toMatchObject({ surface: 'settings', sourceDeviceDid: 'did:key:zSource' });
  });

  test('undecodable bytes fail that surface instead of throwing into the host', async () => {
    const { routes } = routesFor();
    expect(await routes['dweb/self-apply-surface'](
      { surface: 'settings', bytes: btoa('not json at all'), sourceDeviceDid: 'did:key:zA' }, OFFSCREEN,
    )).toEqual({ ok: false, error: 'undecodable-payload' });
    // An applier that throws is reported, not propagated.
    const { routes: throwing } = routesFor({
      surfaceAppliers: { settings: async () => { throw new Error('quota exceeded'); } },
    });
    expect(await throwing['dweb/self-apply-surface'](
      { surface: 'settings', bytes: btoa('{}'), sourceDeviceDid: 'did:key:zA' }, OFFSCREEN,
    )).toEqual({ ok: false, error: 'quota exceeded' });

    const partial: any = new Error('second row failed');
    partial.result = { written: 1, skipped: 0 };
    const { routes: partlyApplied } = routesFor({
      surfaceAppliers: { settings: async () => { throw partial; } },
    });
    expect(await partlyApplied['dweb/self-apply-surface'](
      { surface: 'settings', bytes: btoa('{}'), sourceDeviceDid: 'did:key:zA' }, OFFSCREEN,
    )).toEqual({ ok: false, error: 'second row failed', partial: { written: 1, skipped: 0 } });
  });

  test('surface apply failures preserve direct and partial-cause effect custody', async () => {
    const direct: any = Object.assign(new Error('App rollback incomplete'), {
      performed: true, outcomeKnown: false,
      outcomeKind: 'host-lost', retryable: false,
    });
    const { routes: directRoutes } = routesFor({
      surfaceAppliers: { settings: async () => { throw direct; } },
    });
    expect(await directRoutes['dweb/self-apply-surface'](
      { surface: 'settings', bytes: btoa('{}'), sourceDeviceDid: 'did:key:zA' }, OFFSCREEN,
    )).toMatchObject({
      ok: false, error: 'App rollback incomplete', performed: true,
      outcomeKnown: false, outcomeKind: 'host-lost', retryable: false,
    });

    const partial: any = new Error('second App failed', { cause: direct });
    partial.result = { installed: 1, skipped: 0 };
    const { routes: partialRoutes } = routesFor({
      surfaceAppliers: { settings: async () => { throw partial; } },
    });
    expect(await partialRoutes['dweb/self-apply-surface'](
      { surface: 'settings', bytes: btoa('{}'), sourceDeviceDid: 'did:key:zA' }, OFFSCREEN,
    )).toMatchObject({
      ok: false, error: 'second App failed', partial: { installed: 1, skipped: 0 },
      performed: true, outcomeKnown: false, outcomeKind: 'host-lost', retryable: false,
    });
  });

  test('a lost self-restore response remains unknown and nonretryable', async () => {
    const { routes } = routesFor({
      callBaseHost: async (type: string) => {
        if (type === 'dweb/base-host/self-start') return { ok: true, running: true };
        throw new Error('response lost');
      },
    });
    expect(await routes['dweb/self-restore']({
      deviceDid: 'did:key:zPeer', surfaces: ['apps'],
    })).toEqual({
      ok: false, error: 'response lost', performed: true,
      outcomeKnown: false, outcomeKind: 'transport-lost', retryable: false,
    });
  });

  test('every route is inert when the dweb is off', async () => {
    const { routes, baseHostCalls } = routesFor({ dwebReady: async () => false });
    for (const [name, msg] of [
      ['dweb/self-status', {}],
      ['dweb/self-prepare-offer', { surfaces: ['settings'] }],
      ['dweb/self-read-surface', { snapshotId: 'x', surface: 'settings' }],
      ['dweb/self-apply-surface', { surface: 'settings', bytes: 'e30=' }],
      ['dweb/self-restore', { deviceDid: 'did:key:zA' }],
    ] as const) {
      expect(await routes[name](msg as any, OFFSCREEN)).toEqual({ ok: false, error: 'dweb-disabled' });
    }
    expect(baseHostCalls).toEqual([]);
  });

  test('restore refuses a missing device did before reaching the mesh', async () => {
    const { routes, baseHostCalls } = routesFor();
    expect(await routes['dweb/self-restore']({})).toEqual({ ok: false, error: 'deviceDid-required' });
    expect(baseHostCalls).toEqual([]);
    await routes['dweb/self-restore']({ deviceDid: 'did:key:zA', surfaces: ['settings'] });
    expect(baseHostCalls.at(-1)).toEqual({
      type: 'dweb/base-host/self-restore',
      payload: { deviceDid: 'did:key:zA', surfaces: ['settings'] },
    });
  });

  test('rootless routes start the private host without requiring the public base', async () => {
    const { routes, baseHostCalls } = routesFor();
    expect(await routes['dweb/self-status']()).toEqual({
      ok: true, running: true, candidates: [{ deviceDid: 'did:key:zPeer' }], selfDevices: [],
    });
    expect(baseHostCalls).toEqual([
      { type: 'dweb/base-host/self-start', payload: {} },
      { type: 'dweb/base-host/self-status', payload: {} },
    ]);

    const { routes: inert } = routesFor({
      callBaseHost: async () => ({ ok: true, running: false, reason: 'not-enrolled' }),
    });
    expect(await inert['dweb/self-prepare-offer']({ surfaces: ['settings'] }))
      .toEqual({ ok: false, error: 'not-enrolled' });
  });
});
