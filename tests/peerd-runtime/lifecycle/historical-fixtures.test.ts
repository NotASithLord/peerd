// Historical profile fixtures — the upgrade path, tested against the shapes
// REAL older peerd releases actually wrote (contract §11.3 "tested against
// real old fixtures", §16.7 "migrations are tested from real historical
// fixtures"). The bar this file defends: opening an old profile with today's
// build never silently resets it and never silently drops a field.
//
// ── PROVENANCE ────────────────────────────────────────────────────────────
// There are no version tags in this repo, so each fixture's shape was mined
// out of `git log` and labelled with the version that shipped it
// (`git log -p -- package.json`). Every claim below is a commit you can read.
//
//   fixtures/profile-v0.1.0.json   peerd 0.1.0 — bd7a135 (2026-06-21), the
//     flattened-history root; shape unchanged through 0.1.5 (caed35e).
//       · SessionKind was 'chat' | 'subagent' (bd7a135:sessions/types.js).
//       · No instanceId / actorType / backing (747ed0b), no spawnedTrusted
//         (0f280da), no grantedTools (509c946), no todos|prewalk (65bac25),
//         no review (419ecb6), no originState (1455923).
//       · `actTier` — the pre-collapse Codex-style Act tier. bd7a135:
//         docs/DECISIONS.md §18 promised it would be "read forever" and
//         normalized (full-auto→off, suggest AND auto-edit→on). Those docs
//         were deleted in 5b386dd (0.2.1). See the FINDING below.
//       · toolManifest.allow carries the names bd7a135's `research` preset
//         listed — do/get/check/list_tabs/read_article/call_api/web_search
//         and the inspect_* family. do/get/check + the browser-runner were
//         culled in 8d78709 (#133); inspect_* folded into one `inspect`.
//       · settings: bd7a135:packaging/default-settings.mjs keys, plus
//         `backgroundTabsEnabled` and `voiceVariant:'small'` — both named
//         as removed in today's packaging/default-settings.mjs.
//       · Sessions are in the pre-per-message-store v1 shape (inline
//         `messages`, no msgIndex/messagesV2). That split predates bd7a135,
//         so the shape is reconstructed from the v1→v2 header note and the
//         migrate() path sessions/store.js STILL runs on every get().
//
//   fixtures/profile-v0.2.2.json   peerd 0.2.2 — e66d6b9 (2026-07-04).
//       · 747ed0b added kind:'actor' + instanceId/actorType/backing.
//       · 0f280da (#134/#135) added spawnedTrusted.
//       · 509c946 (#138, the heap split) added grantedTools.
//       · 2818b13 (#141) widened actorType with 'dweb'.
//       · kind is STILL 'subagent' — 67d46d5 (#178) renamed it two days
//         later, in 0.2.6.
//
//   fixtures/profile-v0.2.8.json   peerd 0.2.8 — 9eeda20 (2026-07-19).
//       · 67d46d5 (#178) renamed 'subagent' → 'spawned'; old records keep
//         'subagent' forever (there is no rewrite pass).
//       · 65bac25 (#210) added session.todos + session.prewalk and the
//         prewalk* settings; 9f9d0bc (#219) added watchAgentTab.
//       · review (419ecb6) and originState (1455923) land later, in 0.3.0.
//
// All three carry `storeVersions: null`: the lifecycle store registry landed
// 2026-08-05 (3c5566d/70f6e42), AFTER 0.4.0 (86aaa0a) — so every real 0.x
// profile on disk today is UNSTAMPED, which checkStores must read as a fresh
// profile, never as a version skew.
//
// Each fixture also carries deliberately-planted `unknown*FromANewerBuild`
// fields: forward-compat data a future build wrote that today's build must
// carry through untouched.

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createSessionStore } from '/peerd-runtime/sessions/store.js';
import {
  normalizeMode, normalizeConfirmActions, confirmActionsFromRecord,
  PERMISSION_MODES, DEFAULT_PERMISSION_MODE,
} from '/peerd-runtime/permissions/index.js';
import { normalizeToolManifest } from '/peerd-runtime/tools/manifests.js';
import { compileUserHook } from '/peerd-runtime/tools/hooks/compile.js';
import { orderAlwaysLoaded, assembleAlwaysLoaded } from '/peerd-runtime/memory/memory.js';
import { inspectImport, EXPORT_FORMAT, EXPORT_VERSION } from '/peerd-runtime/transfer/transfer.js';
import { runMigration, guardStore } from '/peerd-runtime/lifecycle/store-version.js';
import { checkStores, storeEntry, STORE_REGISTRY } from '/peerd-runtime/lifecycle/store-registry.js';
import { CHANNEL_DEFAULTS } from '/shared/channel-config.js';

// ── fixture loading ───────────────────────────────────────────────────────

type Rec = Record<string, any>;

type Fixture = {
  _provenance: { peerdVersion: string, shapeCommit: string, shapeDate: string, notes: string[] },
  storeVersions: Record<string, number> | null,
  settings: Rec,
  sessions: Rec[],
  sessionMessages: Rec[],
  hooks: Rec[],
  memory: { version: number, exportedAt: number, docs: Rec[] },
  exportEnvelope: Rec,
};

const FIXTURE_NAMES = ['profile-v0.1.0', 'profile-v0.2.2', 'profile-v0.2.8'] as const;

/** Raw bytes too: the no-loss checks below are anchored on the file's own text. */
const readFixture = (name: string): { text: string, data: Fixture } => {
  const text = readFileSync(join(import.meta.dir, 'fixtures', `${name}.json`), 'utf8');
  return { text, data: JSON.parse(text) as Fixture };
};

const FIXTURES = FIXTURE_NAMES.map((name) => ({ name, ...readFixture(name) }));

// The session store's OWN internals — the only keys `present()` is allowed to
// remove from a record on the way out (msgIndex/messagesV2 are the v2 storage
// shape; `messages` is re-attached as the assembled array). Everything else
// disappearing would be silent data loss.
const DECLARED_STORE_DROPS = new Set(['msgIndex', 'messagesV2', 'messages']);

// A keyPath-aware in-memory IDB, same shape as the real egress wrapper
// (sessions keyed by sessionId, session_messages by id) — matches the fake in
// tests/peerd-runtime/sessions/per-message-store.test.ts.
const makeIdb = (fixture: Fixture) => {
  const stores = new Map<string, Map<string, any>>();
  const tbl = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name)!;
  };
  for (const record of fixture.sessions) tbl('sessions').set(record.sessionId, structuredClone(record));
  for (const row of fixture.sessionMessages) tbl('session_messages').set(row.id, structuredClone(row));
  return {
    _tbl: tbl,
    get: async (store: string, key: string) => tbl(store).get(key),
    getMany: async (store: string, keys: string[]) => (keys ?? []).map((k) => tbl(store).get(k)),
    put: async (store: string, val: any) => { tbl(store).set(val.id ?? val.sessionId, val); },
    getAll: async (store: string) => [...tbl(store).values()],
  };
};

const openStore = (fixture: Fixture) => {
  const idb = makeIdb(fixture);
  return { idb, store: createSessionStore({ idb, now: () => 1_770_000_000_000, makeId: () => 'new-id' }) };
};

// ── 1. old session records load through today's store ─────────────────────

describe.each(FIXTURES)('$name — session records survive today\'s store', ({ data }) => {
  test('every record loads, in the old shape, without throwing', async () => {
    const { store } = openStore(data);
    const listed = await store.list();
    expect(listed).toHaveLength(data.sessions.length);
    for (const original of data.sessions) {
      const loaded = await store.get(original.sessionId);
      expect(loaded).toBeDefined();
      expect(Array.isArray(loaded!.messages)).toBe(true);
    }
  });

  test('no field is silently discarded — every original key survives except the store\'s declared internals', async () => {
    const { store } = openStore(data);
    for (const original of data.sessions) {
      const loaded = (await store.get(original.sessionId)) as Rec;
      for (const [key, value] of Object.entries(original)) {
        if (DECLARED_STORE_DROPS.has(key)) continue;
        expect(loaded).toHaveProperty(key);
        expect(loaded[key]).toEqual(value);
      }
    }
  });

  test('planted forward-compat fields survive get() AND list()', async () => {
    const { store } = openStore(data);
    const planted = data.sessions.filter((s) =>
      Object.keys(s).some((k) => k.startsWith('unknown') || k.startsWith('future')));
    expect(planted.length).toBeGreaterThan(0); // the fixture must actually plant some
    const listed = await store.list();
    for (const original of planted) {
      const unknownKeys = Object.keys(original).filter((k) => k.startsWith('unknown') || k.startsWith('future'));
      const fromGet = (await store.get(original.sessionId)) as Rec;
      const fromList = listed.find((s: Rec) => s.sessionId === original.sessionId) as Rec;
      for (const key of unknownKeys) {
        expect(fromGet[key]).toEqual(original[key]);
        expect(fromList[key]).toEqual(original[key]);
      }
    }
  });

  test('kind/depth are DEFAULTED, never overwritten — a legacy kind value is preserved verbatim', async () => {
    const { store } = openStore(data);
    for (const original of data.sessions) {
      const loaded = (await store.get(original.sessionId)) as Rec;
      expect(loaded.kind).toBe(original.kind ?? 'chat');
      expect(loaded.depth).toBe(original.depth ?? 0);
    }
  });

  test('a mutating write (update) carries the unknown fields forward', async () => {
    const { store, idb } = openStore(data);
    const target = data.sessions[0]!;
    await store.update(target.sessionId, { model: 'claude-opus-5' });
    const raw = idb._tbl('sessions').get(target.sessionId);
    for (const [key, value] of Object.entries(target)) {
      if (DECLARED_STORE_DROPS.has(key) || key === 'model') continue;
      expect(raw).toHaveProperty(key);
      expect(raw[key]).toEqual(value);
    }
  });
});

describe('profile-v0.1.0 — the pre-per-message-store (v1 inline) shape', () => {
  const fixture = FIXTURES[0]!.data;

  test('the fixture really is v1-shaped (this is what makes the migration test real)', () => {
    for (const record of fixture.sessions) {
      expect(record.messagesV2).toBeUndefined();
      expect(record.msgIndex).toBeUndefined();
      expect(Array.isArray(record.messages)).toBe(true);
    }
  });

  test('get() externalizes the inline messages, in order, losing nothing', async () => {
    const { store, idb } = openStore(fixture);
    for (const original of fixture.sessions) {
      const loaded = (await store.get(original.sessionId)) as Rec;
      expect(loaded.messages).toEqual(original.messages);
      // The record on disk is now v2; the bodies moved to session_messages.
      const raw = idb._tbl('sessions').get(original.sessionId);
      expect(raw.messagesV2).toBe(true);
      expect(raw.msgIndex).toHaveLength(original.messages.length);
      expect('messages' in raw).toBe(false);
      for (const [seq, id] of raw.msgIndex.entries()) {
        expect(idb._tbl('session_messages').get(id).message).toEqual(original.messages[seq]);
      }
    }
  });

  test('the migration is idempotent — a second read is a no-op with identical output', async () => {
    const { store } = openStore(fixture);
    const first = await store.get(fixture.sessions[0]!.sessionId);
    const second = await store.get(fixture.sessions[0]!.sessionId);
    expect(second).toEqual(first);
  });

  test('list() reads the v1 shape WITHOUT migrating (opening the chat list writes nothing)', async () => {
    const { store, idb } = openStore(fixture);
    const listed = await store.list();
    expect(listed).toHaveLength(fixture.sessions.length);
    for (const record of fixture.sessions) {
      expect(idb._tbl('sessions').get(record.sessionId).messagesV2).toBeUndefined();
    }
    expect(idb._tbl('session_messages').size).toBe(0);
  });
});

// ── 2. permission fields off a historical record ───────────────────────────

describe('permissions — legacy records normalize instead of throwing', () => {
  const legacy = FIXTURES[0]!.data.sessions[0]!;

  test('the v0.1.0 record\'s permissionMode still reads as Act', () => {
    expect(legacy.permissionMode).toBe('act');
    expect(normalizeMode(legacy.permissionMode)).toBe(PERMISSION_MODES.ACT);
  });

  test('the removed Codex tiers coerce to the read-only floor, never throw', () => {
    for (const tier of ['suggest', 'auto-edit', 'full-auto']) {
      expect(normalizeMode(tier)).toBe(DEFAULT_PERMISSION_MODE);
    }
    expect(normalizeMode(undefined)).toBe(DEFAULT_PERMISSION_MODE);
  });

  test('confirmActions: only an explicit false turns confirmation off', () => {
    expect(normalizeConfirmActions(undefined)).toBe(true);
    expect(normalizeConfirmActions('full-auto')).toBe(true);
    expect(normalizeConfirmActions(false)).toBe(false);
    // The v0.1.0 research chat DID persist the boolean; it round-trips.
    const withBoolean = FIXTURES[0]!.data.sessions[2]!;
    expect(confirmActionsFromRecord(withBoolean)).toBe(true);
  });

  // FINDING (characterization, not endorsement). bd7a135:docs/DECISIONS.md §18
  // said legacy `actTier` records would be "read forever" and normalized
  // conservatively — "a migration must never widen authority", so suggest AND
  // auto-edit were to map to confirm-ON. Today's confirmActionsFromRecord reads
  // only `confirmActions`, so an actTier-only record yields undefined and the
  // SW's resolution chain (service-worker.js resolvePermission:
  // `confirmActionsFromRecord(session) ?? cachedConfirm ?? false`) lands on
  // confirm-OFF — a WIDENING of a 'suggest' user's authority. The FIELD is not
  // lost (asserted below); its MEANING is. Pinned here so the behavior can't
  // drift again unnoticed, and so restoring §18 is a visible, deliberate change.
  test('actTier: the field survives AND its §18 semantics hold — suggest confirms, never widened', async () => {
    // RESTORED: the FINDING this test originally pinned (an actTier-only
    // record falling through to confirm-OFF — a silent authority widening)
    // is fixed in confirmActionsFromRecord: 'suggest'/'auto-edit' → ON,
    // only 'full-auto' → OFF, unknown tiers fail safe to ON.
    expect(legacy.actTier).toBe('suggest');
    expect(confirmActionsFromRecord(legacy)).toBe(true);
    expect(confirmActionsFromRecord({ actTier: 'auto-edit' })).toBe(true);
    expect(confirmActionsFromRecord({ actTier: 'full-auto' })).toBe(false);
    expect(confirmActionsFromRecord({ actTier: 'mystery-tier' })).toBe(true);
    // An explicit boolean still outranks the legacy tier.
    expect(confirmActionsFromRecord({ confirmActions: false, actTier: 'suggest' })).toBe(false);

    // No data loss: the field is still on the record after a full store cycle.
    const { store } = openStore(FIXTURES[0]!.data);
    const loaded = (await store.get(legacy.sessionId)) as Rec;
    expect(loaded.actTier).toBe('suggest');
  });
});

// ── 3. a v0.1.0 tool manifest naming culled tools ─────────────────────────

describe('tool manifests — culled tool names are kept, not scrubbed', () => {
  const research = FIXTURES[0]!.data.sessions[2]!;

  test('normalizeToolManifest preserves every historical name verbatim', () => {
    const normalized = normalizeToolManifest(research.toolManifest);
    expect(normalized).not.toBeNull();
    expect(normalized!.preset).toBe('research');
    expect(normalized!.allow).toEqual(research.toolManifest.allow);
    // The names culled in 8d78709 (#133) and the inspect consolidation are
    // still there — a manifest NARROWS at dispatch; it is not a registry.
    for (const gone of ['do', 'get', 'check', 'list_tabs', 'web_search', 'inspect_storage']) {
      expect(normalized!.allow).toContain(gone);
    }
  });

  test('the manifest object round-trips through the store untouched', async () => {
    const { store } = openStore(FIXTURES[0]!.data);
    const loaded = (await store.get(research.sessionId)) as Rec;
    expect(loaded.toolManifest).toEqual(research.toolManifest);
  });
});

// ── 4. old hook + memory records ──────────────────────────────────────────

describe.each(FIXTURES)('$name — hooks and memory docs', ({ data }) => {
  test('every hook record compiles and keeps its unknown fields on _record', () => {
    for (const record of data.hooks) {
      const compiled = compileUserHook(record as any);
      expect(compiled.id).toBe(record.id);
      expect(compiled.enabled).toBe(record.enabled !== false);
      expect(compiled._record).toEqual(record as any);
      expect((compiled._record as Rec).unknownHookFieldFromANewerBuild).toBe('keep-me');
    }
  });

  test('memory docs assemble without throwing and keep their unknown fields', () => {
    const ordered = orderAlwaysLoaded(data.memory.docs as any);
    expect(ordered.length).toBeGreaterThan(0);
    const assembled = assembleAlwaysLoaded(ordered, {});
    expect(assembled.text.length).toBeGreaterThan(0);
    expect(assembled.truncated).toBe(false);
    // orderAlwaysLoaded filters by scope kind; it must not REWRITE a doc.
    const user = ordered.find((d: Rec) => d.id === 'user') as Rec;
    expect(user.unknownDocFieldFromANewerBuild).toBe(7);
  });
});

// ── 5. the old transfer export envelope ───────────────────────────────────

const KNOWN_SETTING_KEYS = Object.keys(CHANNEL_DEFAULTS);

describe.each(FIXTURES)('$name — the export envelope this release wrote', ({ data }) => {
  const envelope = () => data.exportEnvelope;

  test('the format/version this build still speaks', () => {
    expect(envelope().format).toBe(EXPORT_FORMAT);
    expect(envelope().version).toBe(EXPORT_VERSION);
  });

  test('inspectImport accepts it and the summary is sane', () => {
    const result = inspectImport({
      payload: envelope(), channel: 'preview', knownSettingKeys: KNOWN_SETTING_KEYS,
    });
    expect(result.ok).toBe(true);
    // narrow inspectImport's union for TS — expect() does not (same idiom as
    // tests/peerd-runtime/transfer/transfer.test.ts).
    if (!result.summary) throw new Error(`expected ok result: ${result.error}`);
    const { summary } = result;
    expect(summary.exportedAt).toBe(envelope().exportedAt);
    expect(summary.sourceChannel).toBe(envelope().channel);
    expect(summary.memoryDocs).toBe(envelope().memory.docs.length);
    expect(summary.hooks).toBe(envelope().hooks.length);
    expect(summary.skills).toHaveLength(envelope().skills.length);
    for (const notice of summary.notices) expect(typeof notice).toBe('string');
  });

  test('every settings key is ACCOUNTED FOR — kept or declared dropped, never silently gone', () => {
    const result = inspectImport({
      payload: envelope(), channel: 'preview', knownSettingKeys: KNOWN_SETTING_KEYS,
    });
    if (!result.summary) throw new Error(`expected ok result: ${result.error}`);
    const accounted = [...result.summary.settingsKeys, ...result.summary.settingsDropped].sort();
    expect(accounted).toEqual(Object.keys(envelope().settings).sort());
    // A drop is only legitimate if the user is TOLD about it.
    if (result.summary.settingsDropped.length > 0) {
      expect(result.summary.notices.some((n) => n.includes('not recognized by this build'))).toBe(true);
      for (const key of result.summary.settingsDropped) {
        expect(result.summary.notices.join(' ')).toContain(key);
      }
    }
  });

  test('§12 durability labels are absent, which means "unlabelled" — not "nothing was omitted"', () => {
    // The durability block landed in 70f6e42 (2026-08-05); none of these files
    // carry it. Absent must read as empty defaults with NO omission notice.
    expect(envelope().durability).toBeUndefined();
    const result = inspectImport({
      payload: envelope(), channel: 'preview', knownSettingKeys: KNOWN_SETTING_KEYS,
    });
    if (!result.summary) throw new Error(`expected ok result: ${result.error}`);
    expect(result.summary.durabilityTiers).toEqual({});
    expect(result.summary.omittedDeviceBound).toEqual([]);
    expect(result.summary.notices.some((n) => n.includes('Device-bound state'))).toBe(false);
  });

  test('the authority-redirecting sections are named loudly (R6)', () => {
    const result = inspectImport({
      payload: envelope(), channel: 'preview', knownSettingKeys: KNOWN_SETTING_KEYS,
    });
    if (!result.summary) throw new Error(`expected ok result: ${result.error}`);
    const expectedUrls = (envelope().providerEndpoints?.endpoints ?? []).map((e: Rec) => e.url);
    expect(result.summary.endpointUrls).toEqual(expectedUrls);
    expect(result.summary.hookIds).toEqual(envelope().hooks.map((h: Rec) => h.id));
  });
});

describe('the v0.2.2 preview export landing on a store build', () => {
  const envelope = FIXTURES[1]!.data.exportEnvelope;

  test('the dweb section is dropped WITH the §10 notice, never silently', () => {
    const result = inspectImport({
      payload: envelope, channel: 'store', knownSettingKeys: KNOWN_SETTING_KEYS,
    });
    if (!result.summary) throw new Error(`expected ok result: ${result.error}`);
    expect(result.summary.dwebPresent).toBe(true);
    expect(result.summary.dwebDropped).toBe(true);
    expect(result.summary.notices).toContain(
      'Dweb state in this export is not supported in the store package and was skipped.');
  });

  test('inspectImport does not mutate the payload it inspects', () => {
    const before = JSON.stringify(envelope);
    inspectImport({ payload: envelope, channel: 'store', knownSettingKeys: KNOWN_SETTING_KEYS });
    expect(JSON.stringify(envelope)).toBe(before);
  });
});

// ── 6. the migration driver over a whole historical profile ───────────────

const identityStep = (from: number, to: number) => ({
  from, to, migrate: (d: Record<string, unknown>) => ({ ...d }),
});

describe.each(FIXTURES)('$name — runMigration over the whole profile', ({ data, text }) => {
  test('a no-op step chain preserves the profile byte-for-byte', () => {
    const result = runMigration({
      store: 'sessions',
      data: JSON.parse(text) as Record<string, unknown>,
      fromVersion: 1, toVersion: 3,
      steps: [identityStep(1, 2), identityStep(2, 3)],
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.version).toBe(3);
    expect(result.completedSteps).toEqual([2, 3]);
    // Byte-anchored: re-serializing the migrated profile reproduces the file.
    expect(JSON.stringify(result.data)).toBe(JSON.stringify(JSON.parse(text)));
  });

  test('every planted forward-compat field is still there after the chain', () => {
    const result = runMigration({
      store: 'sessions',
      data: JSON.parse(text) as Record<string, unknown>,
      fromVersion: 1, toVersion: 2, steps: [identityStep(1, 2)],
    });
    if (!result.ok) throw new Error(result.reason);
    const migrated = result.data as unknown as Fixture;
    expect((migrated.settings as Rec).unknownSettingFromANewerBuild)
      .toEqual((data.settings as Rec).unknownSettingFromANewerBuild);
    expect((migrated.exportEnvelope as Rec).unknownEnvelopeSectionFromANewerBuild)
      .toEqual((data.exportEnvelope as Rec).unknownEnvelopeSectionFromANewerBuild);
    expect(migrated.sessions[0]!.unknownRecordFieldFromANewerBuild)
      .toEqual(data.sessions[0]!.unknownRecordFieldFromANewerBuild);
  });

  test('a step that DROPS an undeclared planted field is refused, original retained', () => {
    const original = JSON.parse(text) as Record<string, unknown>;
    const result = runMigration({
      store: 'sessions',
      data: original,
      fromVersion: 1, toVersion: 2,
      steps: [{
        from: 1, to: 2,
        // A plausible-looking "clean up the file container" step that quietly
        // eats a section it did not declare. This must fail the run.
        migrate: ({ _provenance, ...rest }: Record<string, unknown>) => rest,
      }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnosticId).toBe('migrate-sessions-step-v1-dropped-_provenance');
    expect(result.failedStep).toEqual({ from: 1, to: 2 });
    // The original is handed back untouched, byte-for-byte.
    expect(JSON.stringify(result.data)).toBe(JSON.stringify(JSON.parse(text)));
  });

  test('the same drop, DECLARED, is allowed — the guard is about silence, not about dropping', () => {
    const result = runMigration({
      store: 'sessions',
      data: JSON.parse(text) as Record<string, unknown>,
      fromVersion: 1, toVersion: 2,
      steps: [{
        from: 1, to: 2, drops: ['_provenance'],
        migrate: ({ _provenance, ...rest }: Record<string, unknown>) => rest,
      }],
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.data._provenance).toBeUndefined();
    expect(result.data.sessions).toEqual(data.sessions as unknown as Record<string, unknown>[]);
  });

  test('a throwing step leaves the profile exactly as found', () => {
    const result = runMigration({
      store: 'sessions',
      data: JSON.parse(text) as Record<string, unknown>,
      fromVersion: 1, toVersion: 2,
      steps: [{ from: 1, to: 2, migrate: () => { throw new Error('interrupted'); } }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnosticId).toBe('migrate-sessions-step-v1-threw');
    expect(JSON.stringify(result.data)).toBe(JSON.stringify(JSON.parse(text)));
  });
});

// ── 7. how the guard classifies a real 0.x profile ────────────────────────

describe.each(FIXTURES)('$name — store-version classification', ({ data }) => {
  test('the fixture is unstamped, because the registry postdates every 0.x release', () => {
    expect(data.storeVersions).toBeNull();
  });

  test('unstamped reads as firstRun + read-write for every surface — never a skew, never a reset', async () => {
    const check = await checkStores({ read: async () => undefined });
    expect(check.ok).toBe(true);
    expect(check.stores).toHaveLength(STORE_REGISTRY.length);
    for (const entry of check.stores) {
      expect(entry.firstRun).toBe(true);
      expect(entry.stamped).toBeUndefined();
      expect(entry.mode).toBe('read-write');
      expect(entry.versionClass).toBe('current');
      expect(entry.diagnosticId).toBeUndefined();
    }
  });
});

describe('guardStore over a stamped profile', () => {
  const sessions = storeEntry('sessions')!;

  test('an OLDER stamp asks for a migration', () => {
    const guard = guardStore({
      store: sessions.store, found: sessions.version - 1, supported: sessions.version,
    });
    expect(guard.mode).toBe('migrate');
    expect(guard.versionClass).toBe('migratable');
  });

  test('a NEWER stamp fails read-only with a diagnostic — the §11.5 downgrade refusal', () => {
    const guard = guardStore({
      store: sessions.store, found: sessions.version + 1, supported: sessions.version,
    });
    expect(guard.mode).toBe('read-only');
    expect(guard.versionClass).toBe('newer');
    expect(guard.diagnosticId).toBe(`store-${sessions.store}-newer-v${sessions.version + 1}`);
  });

  test('checkStores routes an older stamp to migrate and keeps the rest read-write', async () => {
    const check = await checkStores({
      read: async () => ({ [sessions.store]: sessions.version - 1 }),
    });
    expect(check.ok).toBe(true);
    const found = check.stores.find((s) => s.store === sessions.store)!;
    expect(found.mode).toBe('migrate');
    expect(found.firstRun).toBeUndefined();
    for (const other of check.stores.filter((s) => s.store !== sessions.store)) {
      expect(other.mode).toBe('read-write');
      expect(other.firstRun).toBe(true);
    }
  });

  test('checkStores refuses the WHOLE profile when any surface is newer', async () => {
    const check = await checkStores({
      read: async () => ({ [sessions.store]: sessions.version + 5 }),
    });
    expect(check.ok).toBe(false);
    expect(check.stores.find((s) => s.store === sessions.store)!.mode).toBe('read-only');
  });
});

// ── 8. the byte-anchored no-loss sweep ────────────────────────────────────

describe.each(FIXTURES)('$name — byte-anchored no-loss sweep', ({ data, text }) => {
  test('a JSON round-trip of the fixture is lossless', () => {
    expect(JSON.parse(JSON.stringify(data))).toEqual(JSON.parse(text));
  });

  test('every top-level key of every session record is accounted for after the store path', async () => {
    const { store } = openStore(data);
    const listed = await store.list();
    for (const original of data.sessions) {
      const loaded = listed.find((s: Rec) => s.sessionId === original.sessionId) as Rec;
      const originalKeys = Object.keys(original);
      const survivors = new Set(Object.keys(loaded));
      const lost = originalKeys.filter((k) => !survivors.has(k) && !DECLARED_STORE_DROPS.has(k));
      expect(lost).toEqual([]);
      // The assembled shape always exposes `messages`, whichever storage
      // shape the record was in.
      expect(survivors.has('messages')).toBe(true);
    }
  });

  test('every message body survives the store path', async () => {
    const { store } = openStore(data);
    const expected = new Map<string, Rec[]>();
    for (const record of data.sessions) {
      expected.set(record.sessionId, Array.isArray(record.messages)
        ? record.messages
        : (record.msgIndex ?? []).map((id: string) =>
          data.sessionMessages.find((row) => row.id === id)!.message));
    }
    for (const [sessionId, messages] of expected) {
      const loaded = (await store.get(sessionId)) as Rec;
      expect(loaded.messages).toEqual(messages);
    }
  });
});
