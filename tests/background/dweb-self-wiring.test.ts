// The service-worker half of same-user device sync: the custody allowlist
// and the two relay routes the offscreen host reaches.
//
// These are the seams where the wiring can be wrong in a way no protocol
// test would catch: the offscreen document is the process that talks to the
// network, and these are the only two doors it has into the vault and the
// stores. Both must be closed to everyone else.

import { describe, test, expect } from 'bun:test';
import { makeDwebSelfCustody, SELF_CUSTODY_SECRET_NAMES } from '../../extension/background/dweb-self-custody.js';
import { makeDwebSelfRoutes } from '../../extension/background/routes/dweb-self.js';

const IDENTITY_SECRET = 'distributed/identity/v1';

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

const custodyFor = (vault: ReturnType<typeof fakeVault>, overrides = {}) => makeDwebSelfCustody({
  enabled: true, active: () => true, vault, identitySecretName: IDENTITY_SECRET, ...overrides,
} as any);

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
    expect(await custody.handle('self-set', { name, value: '{"v":1}' })).toEqual({ ok: true });
    expect(vault.map.get(name)).toBe('{"v":1}');
    expect(await custody.handle('self-set', { name, value: 'x'.repeat(300_000) }))
      .toEqual({ ok: false, error: 'value-too-large' });
    expect(await custody.handle('self-set', { name, value: 42 as any }))
      .toEqual({ ok: false, error: 'value-required' });

    vault.lock();
    expect(await custody.handle('self-get', { name })).toEqual({ ok: false, error: 'vault-locked' });
  });

  test('inert when the build or the setting says so', async () => {
    const vault = fakeVault({ 'distributed/self-records/v1': '{}' });
    const name = 'distributed/self-records/v1';
    expect(await custodyFor(vault, { enabled: false }).handle('self-get', { name }))
      .toEqual({ ok: false, error: 'dweb-disabled' });
    expect(await custodyFor(vault, { active: () => false }).handle('self-get', { name }))
      .toEqual({ ok: false, error: 'dweb-disabled' });
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
});
