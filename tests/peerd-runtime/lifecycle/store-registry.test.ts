// The durable-surface registry (§11.1 independent per-store versions,
// §12 durability tiers) — registry invariants, the check/stamp pair
// (including the §11.5 downgrade refusal), and the transfer surface's
// §12 disclosure of omitted device-bound state.

import { describe, test, expect } from 'bun:test';
import {
  DURABILITY_TIERS, STORE_REGISTRY, VERSION_STAMP_KEY,
  storeEntry, portableStores, omittedDeviceBoundStores,
  checkStores, stampStores,
} from '../../../extension/peerd-runtime/lifecycle/store-registry.js';
import { buildExport, inspectImport, EXPORT_FORMAT, EXPORT_VERSION } from '/peerd-runtime/transfer/transfer.js';

/** An in-memory stand-in for the SW's kv adapter: the WHOLE stamp map. */
const stampIo = (initial?: Record<string, number>) => {
  let map = initial ? { ...initial } : undefined;
  const writes: Array<Record<string, number>> = [];
  return {
    get current() { return map; },
    writes,
    read: async () => (map ? { ...map } : undefined),
    write: async (next: Record<string, number>) => { map = { ...next }; writes.push({ ...next }); },
  };
};

describe('registry invariants', () => {
  test('names are unique and lowercase-hyphenated', () => {
    const names = STORE_REGISTRY.map((entry) => entry.store);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name).toMatch(/^[a-z]+(-[a-z]+)*$/);
  });

  test('every version is a positive integer', () => {
    for (const entry of STORE_REGISTRY) {
      expect(Number.isInteger(entry.version)).toBe(true);
      expect(entry.version).toBeGreaterThan(0);
    }
  });

  test('tiers are from the §12 vocabulary; nothing durable is ephemeral', () => {
    const tiers = new Set(Object.values(DURABILITY_TIERS));
    for (const entry of STORE_REGISTRY) {
      expect(tiers.has(entry.tier)).toBe(true);
      // EPHEMERAL exists so callers can LABEL non-durable state; a store
      // in this registry survives the process by definition.
      expect(entry.tier).not.toBe(DURABILITY_TIERS.EPHEMERAL);
      expect(typeof entry.portable).toBe('boolean');
    }
  });

  test('device-bound surfaces are never portable — dpop-keys is the archetype', () => {
    const dpop = storeEntry('dpop-keys');
    if (!dpop) throw new Error('dpop-keys must be registered');
    expect(dpop.deviceBound).toBe(true);
    expect(dpop.portable).toBe(false);
    for (const entry of STORE_REGISTRY) {
      if (entry.deviceBound) expect(entry.portable).toBe(false);
    }
    expect(omittedDeviceBoundStores()).toContain('dpop-keys');
    expect(portableStores().map((e) => e.store)).not.toContain('dpop-keys');
  });

  test('the registry is frozen and the stamp key is stable', () => {
    expect(Object.isFrozen(STORE_REGISTRY)).toBe(true);
    expect(Object.isFrozen(STORE_REGISTRY[0])).toBe(true);
    expect(VERSION_STAMP_KEY).toBe('peerd.lifecycle.storeVersions');
    expect(storeEntry('nope')).toBeUndefined();
  });
});

describe('checkStores', () => {
  test('an unstamped profile is firstRun and writable', async () => {
    const io = stampIo();
    const result = await checkStores(io);
    expect(result.ok).toBe(true);
    for (const check of result.stores) {
      expect(check.firstRun).toBe(true);
      expect(check.stamped).toBeUndefined();
      expect(check.mode).toBe('read-write');
      expect(check.versionClass).toBe('current');
    }
  });

  test('a current stamp is read-write and NOT firstRun', async () => {
    const io = stampIo(Object.fromEntries(STORE_REGISTRY.map((e) => [e.store, e.version])));
    const result = await checkStores(io);
    expect(result.ok).toBe(true);
    const sessions = result.stores.find((s) => s.store === 'sessions');
    expect(sessions?.mode).toBe('read-write');
    expect(sessions?.firstRun).toBeUndefined();
    expect(sessions?.stamped).toBe(storeEntry('sessions')!.version);
  });

  test('a NEWER stamp fails read-only with a diagnostic and sinks ok (§11.5)', async () => {
    const supported = storeEntry('memory')!.version;
    const io = stampIo({ memory: supported + 4 });
    const result = await checkStores(io);
    expect(result.ok).toBe(false);
    const memory = result.stores.find((s) => s.store === 'memory');
    expect(memory?.mode).toBe('read-only');
    expect(memory?.versionClass).toBe('newer');
    expect(memory?.diagnosticId).toBe(`store-memory-newer-v${supported + 4}`);
    expect(memory?.reason).toContain('newer than this peerd supports');
    // Independent versions (§11.1): the skew is memory's alone.
    expect(result.stores.find((s) => s.store === 'sessions')?.mode).toBe('read-write');
  });

  test('a malformed stamp fails closed too', async () => {
    const io = stampIo({ audit: 'v1' as unknown as number });
    const result = await checkStores(io);
    expect(result.ok).toBe(false);
    const audit = result.stores.find((s) => s.store === 'audit');
    expect(audit?.mode).toBe('read-only');
    expect(audit?.diagnosticId).toBe('store-audit-malformed-version');
    expect(audit?.firstRun).toBeUndefined(); // stamped, just unreadable
  });
});

describe('stampStores', () => {
  test('stamps every unstamped surface at this build\'s version', async () => {
    const io = stampIo();
    const stamped = await stampStores(io);
    expect(stamped).toEqual(STORE_REGISTRY.map((e) => e.store));
    expect(io.current).toEqual(Object.fromEntries(STORE_REGISTRY.map((e) => [e.store, e.version])));
    // ...and the freshly stamped profile now checks out as current.
    const after = await checkStores(io);
    expect(after.ok).toBe(true);
    expect(after.stores.every((s) => s.firstRun === undefined)).toBe(true);
  });

  test('never lowers a NEWER stamp — that is the downgrade refusal', async () => {
    const io = stampIo({ sessions: storeEntry('sessions')!.version + 7 });
    const stamped = await stampStores(io);
    expect(stamped).not.toContain('sessions');
    expect(io.current?.sessions).toBe(storeEntry('sessions')!.version + 7);
  });

  test('never raises an OLDER stamp — stamping is a migration\'s final act', async () => {
    const io = stampIo({ hooks: 0 });
    const stamped = await stampStores(io);
    expect(stamped).not.toContain('hooks');
    expect(io.current?.hooks).toBe(0);
    // A malformed stamp is left for diagnosis rather than clobbered.
    const malformed = stampIo({ audit: 'nope' as unknown as number });
    await stampStores(malformed);
    expect(malformed.current?.audit).toBe('nope' as unknown as number);
  });

  test('idempotent on rerun: same list, no second write', async () => {
    const io = stampIo();
    const first = await stampStores(io);
    const second = await stampStores(io);
    expect(second).toEqual(first);
    expect(io.writes.length).toBe(1);
  });
});

describe('transfer carries the §12 durability labels', () => {
  const exportArgs = {
    channel: 'preview' as const,
    storedSettings: { devMode: true },
    providerEndpoints: null,
    secrets: { anthropic: 'sk-1' },
    passphrase: 'a long passphrase',
    memory: { version: 1, docs: [{ id: 'user', body: 'x', updatedAt: 5 }] },
    hooks: [{ id: 'h1', event: 'pre-tool-use' }],
    skills: [{ id: 's1', name: 'review' }],
  };

  test('buildExport names the omitted device-bound surfaces and labels included sections', async () => {
    const payload = await buildExport(exportArgs);
    expect(payload.version).toBe(EXPORT_VERSION); // purely additive
    expect(payload.durability.omittedDeviceBound).toContain('dpop-keys');
    expect(payload.durability.omittedDeviceBound).toEqual(omittedDeviceBoundStores());
    expect(payload.durability.tiers).toEqual({
      vault: DURABILITY_TIERS.PROFILE,
      memory: DURABILITY_TIERS.PORTABLE,
      skills: DURABILITY_TIERS.PORTABLE,
      hooks: DURABILITY_TIERS.PORTABLE,
    });
  });

  test('absent sections are not labelled', async () => {
    const payload = await buildExport({
      ...exportArgs, secrets: {}, passphrase: '', memory: null, hooks: [], skills: [],
    });
    expect(payload.durability.tiers).toEqual({});
    expect(payload.durability.omittedDeviceBound).toContain('dpop-keys');
  });

  test('inspectImport surfaces the block, with a notice', async () => {
    const payload = await buildExport(exportArgs);
    const res = inspectImport({ payload, channel: 'preview', knownSettingKeys: ['devMode'] });
    if (!res.ok || !res.summary) throw new Error('expected ok summary'); // narrow the union for TS
    expect(res.summary.omittedDeviceBound).toContain('dpop-keys');
    expect(res.summary.durabilityTiers.memory).toBe(DURABILITY_TIERS.PORTABLE);
    expect(res.summary.notices.some((n: string) => n.includes('Device-bound state'))).toBe(true);
  });

  test('a LEGACY payload without the block still imports cleanly', () => {
    const legacy = {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: '2026-06-11T00:00:00.000Z',
      channel: 'preview',
      settings: { devMode: true },
      providerEndpoints: null,
      secrets: null,
      memory: null,
      hooks: [],
      skills: [],
    };
    const res = inspectImport({ payload: legacy, channel: 'preview', knownSettingKeys: ['devMode'] });
    expect(res.ok).toBe(true);
    if (!res.summary) throw new Error('expected ok summary');
    // Absent means UNLABELLED, never "nothing was omitted" — so no notice.
    expect(res.summary.durabilityTiers).toEqual({});
    expect(res.summary.omittedDeviceBound).toEqual([]);
    expect(res.summary.notices).toEqual([]);
  });
});
