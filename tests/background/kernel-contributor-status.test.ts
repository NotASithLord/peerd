import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONTRIBUTOR_ACTIVE_CONSENT_KEY, CONTRIBUTOR_PENDING_RECEIPTS_KEY,
  CONTRIBUTOR_PENDING_DROP_PREFIX, CONTRIBUTOR_PENDING_RECEIPT_PREFIX,
  CONTRIBUTOR_STATE_PREFIX,
  createPreviewContributorAuthority,
  createPreviewContributorRoutes, previewTargetAddon,
} from '../../extension/background/kernel-preview-addon.js';
import {
  acceptContributorOffer, dispatchContributorSemanticRoute,
} from '../../extension/offscreen/semantic-routes/contributor.js';
import {
  CONTRIBUTOR_CHANNEL_CALL, CONTRIBUTOR_CHANNEL_OFFER, CONTRIBUTOR_CHANNEL_PROTOCOL,
  CONTRIBUTOR_CHANNEL_RESULT, parseContributorOffer,
} from '../../extension/shared/contributor-channel.js';
import { emptyContributorLocalState } from '../../extension/peerd-runtime/observability/contributor-metrics.js';
import {
  makeKernelFirefoxContributor,
} from '../../extension/background/kernel-firefox-contributor-addon.js';

const createLiveRoutes = createPreviewContributorRoutes;

const enabledRecord = (generation = 'consent-generation-1') => ({
  version: 1,
  consent: {
    enabled: true, schemaVersion: 1, disclosureVersion: 1,
    generation,
  },
  aggregate: emptyContributorLocalState(),
});

const settlement = (operationKey = 'delivery-1', overrides: Record<string, any> = {}) => ({
  version: 1,
  consentGeneration: 'consent-generation-1', operationKey,
  feedbackContextKey: 'chat-1:tool-1',
  decision: { requested: 'tools', resolved: 'tools', fallback: 'none' },
  browser: 'chrome', extensionVersion: '0.6.0', channel: 'preview',
  providerCode: 0, modelFamilyCode: 1, durationMs: 42,
  tokens: 15, outcome: 'completed', failure: 'none', actions: ['page_action'],
  ...overrides,
});

const storage = (initial: any) => {
  const values = new Map<string, any>();
  if (initial != null) {
    values.set('contributor_metrics.aggregate.v1', structuredClone(initial));
    values.set(CONTRIBUTOR_ACTIVE_CONSENT_KEY, {
      version: 1, generation: initial.consent.generation,
    });
  }
  return {
    kv: {
      get: async (key: string) => structuredClone(values.get(key) ?? null),
      set: async (key: string, next: any) => { values.set(key, structuredClone(next)); },
      delete: async (key: string) => { values.delete(key); },
      list: async (prefix: string) => Object.fromEntries([...values.entries()]
        .filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)])),
    },
    value: () => {
      const snapshots = [...values.entries()]
        .filter(([key]) => key.startsWith('contributor_metrics.state.v2.'))
        .sort((left, right) => right[1].revision - left[1].revision);
      if (snapshots.length > 0) {
        return snapshots[0][1].state === 'active'
          ? structuredClone(snapshots[0][1].record) : null;
      }
      return structuredClone(values.get('contributor_metrics.aggregate.v1') ?? null);
    },
    read: (key: string) => structuredClone(values.get(key) ?? null),
    listed: (prefix: string) => Object.fromEntries([...values.entries()]
      .filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, structuredClone(value)])),
  };
};

const routesFor = (state: ReturnType<typeof storage>, sender: any, postMessage?: any,
    feedback: { sidepanel?: any; home?: any; validate?: (message: any) => Promise<any>;
      scheduleDrain?: (operation: () => void) => void; channelDeadlineMs?: number;
      storageDeadlineMs?: number } = {}) => {
  const offscreenUrl = 'chrome-extension://id/offscreen/offscreen.html';
  const lease = { scope: 'controller', leaseId: 'contributor-lease' };
  const target = {
    url: offscreenUrl,
    postMessage: postMessage ?? ((offer: any, ports: MessagePort[]) => {
      acceptContributorOffer({ data: offer, ports }, {
        ownsLease: (candidate: any) => candidate === lease,
      });
    }),
  };
  const prior = (globalThis as any).clients;
  (globalThis as any).clients = { matchAll: async () => [target] };
  const owner = createLiveRoutes({
    kv: state.kv, optionsUi: (candidate: any) => candidate === sender,
    sidepanelUi: (candidate: any) => candidate === feedback.sidepanel,
    homeUi: (candidate: any) => candidate === feedback.home,
    validateFeedback: feedback.validate ?? (async () => ({ ok: false })),
    offscreenUrl,
    featureHost: { runtime: { runWithLease: async (_scope: string, operation: any) =>
      operation(lease) } },
    scheduleDrain: feedback.scheduleDrain,
    channelDeadlineMs: feedback.channelDeadlineMs,
    storageDeadlineMs: feedback.storageDeadlineMs,
  });
  return { owner, routes: owner.routes,
    restore: () => { (globalThis as any).clients = prior; } };
};

const directRoutesFor = (state: ReturnType<typeof storage>, sender: any,
    storageDeadlineMs = 5) => createPreviewContributorRoutes({
  kv: state.kv,
  optionsUi: (candidate: any) => candidate === sender,
  sidepanelUi: () => false,
  homeUi: () => false,
  validateFeedback: async () => ({ ok: false }),
  offscreenUrl: null,
  featureHost: null,
  dispatchSemanticRoute: dispatchContributorSemanticRoute,
  scheduleDrain: () => {},
  storageDeadlineMs,
});

describe('Preview Contributor Metrics private channel', () => {
  test('target addon is update plus one fixed contributor capability', () => {
    const addon = previewTargetAddon;
    expect(addon).toMatchObject({
      target: 'preview-chrome', update: expect.any(Function),
      dwebCustody: expect.any(Function), contributor: expect.any(Function),
    });
    expect(Object.keys(addon).sort()).toEqual(['contributor', 'dwebCustody', 'target', 'update']);
  });

  test('returns canonical status without exposing consent or aggregate custody', async () => {
    const state = storage(enabledRecord());
    const sender = {};
    const live = routesFor(state, sender, undefined, { scheduleDrain: () => {} });
    try {
      const result = await live.routes['contributor/status']({ type: 'contributor/status' }, sender);
      expect(result).toEqual({
        ok: true,
        status: {
          enabled: true, schemaVersion: 1, disclosureVersion: 1,
          bytes: expect.any(String), rowCount: 0, diagnostic: null,
        },
      });
      expect(JSON.stringify(result)).not.toContain('consent-generation-1');
      expect(JSON.stringify(result)).not.toContain('aggregate');
    } finally { live.restore(); }
  });

  test('arms from the exact kernel record without acquiring the semantic host', async () => {
    const state = storage(enabledRecord());
    const sender = {};
    let posted = 0;
    const live = routesFor(state, sender, () => { posted += 1; }, { scheduleDrain: () => {} });
    try {
      expect(await live.owner.arm()).toEqual({
        enabled: true, generation: 'consent-generation-1',
      });
      expect(posted).toBe(0);
    } finally { live.restore(); }
  });

  test('disabled Contributor Metrics stays inert without acquiring the semantic host', async () => {
    const state = storage(null);
    const sender = {};
    let posted = 0;
    const live = routesFor(state, sender, () => { posted += 1; }, { scheduleDrain: () => {} });
    try {
      expect(await live.owner.arm()).toEqual({ enabled: false, generation: null });
      expect(posted).toBe(0);
      expect(state.listed(CONTRIBUTOR_PENDING_RECEIPT_PREFIX)).toEqual({});
    } finally { live.restore(); }
  });

  test('a stale consent generation cannot enter the durable receipt outbox', async () => {
    const state = storage(enabledRecord());
    const sender = {};
    const live = routesFor(state, sender, undefined, { scheduleDrain: () => {} });
    try {
      expect(await live.owner.recordWebSettlement(settlement('stale-consent', {
        consentGeneration: 'consent-generation-old',
      }))).toEqual({ ok: true, queued: false, reason: 'disabled' });
      expect(state.read(CONTRIBUTOR_PENDING_RECEIPTS_KEY)).toBeNull();
    } finally { live.restore(); }
  });

  test('hashes identifiers before the first durable receipt write', async () => {
    const state = storage(enabledRecord());
    const sender = {};
    const live = routesFor(state, sender, undefined, { scheduleDrain: () => {} });
    try {
      expect(await live.owner.recordWebSettlement(settlement('raw-operation-id', {
        feedbackContextKey: 'raw-session-id:raw-tool-id',
      }))).toEqual({ ok: true, queued: true });
      const persisted = JSON.stringify(state.listed(CONTRIBUTOR_PENDING_RECEIPT_PREFIX));
      expect(persisted).not.toContain('raw-operation-id');
      expect(persisted).not.toContain('raw-session-id');
      expect(persisted).not.toContain('raw-tool-id');
      expect(persisted).toContain('operation:');
      expect(persisted).toContain('context:');
    } finally { live.restore(); }
  });

  test('revocation hides stale receipts and resumes interrupted physical cleanup', async () => {
    const state = storage(enabledRecord());
    const sender = {};
    const originalDelete = state.kv.delete;
    let failPendingDelete = true;
    state.kv.delete = async (key: string) => {
      if (key.startsWith(CONTRIBUTOR_PENDING_RECEIPT_PREFIX) && failPendingDelete) {
        throw new Error('interrupted cleanup');
      }
      return originalDelete(key);
    };
    const live = routesFor(state, sender, undefined, { scheduleDrain: () => {} });
    try {
      await live.owner.recordWebSettlement(settlement('receipt-before-revoke'));
      expect(await live.routes['contributor/disable']({ type: 'contributor/disable' }, sender))
        .toMatchObject({ ok: true, status: { enabled: false } });
      expect(state.value()).toBeNull();
      expect(Object.keys(state.listed(CONTRIBUTOR_PENDING_RECEIPT_PREFIX))).toHaveLength(1);
      expect(await live.owner.pending()).toEqual([]);
      expect(Object.keys(state.listed(CONTRIBUTOR_PENDING_RECEIPT_PREFIX))).toHaveLength(1);
      failPendingDelete = false;
      expect(await live.owner.pending()).toEqual([]);
      expect(state.listed(CONTRIBUTOR_PENDING_RECEIPT_PREFIX)).toEqual({});
    } finally { live.restore(); }
  });

  test('a hung storage operation is bounded and cannot poison later settlements', async () => {
    const state = storage(enabledRecord());
    const sender = {};
    const originalGet = state.kv.get;
    let hangAggregateRead = true;
    state.kv.get = async (key: string) => {
      if (key === 'contributor_metrics.aggregate.v1' && hangAggregateRead) {
        hangAggregateRead = false;
        return new Promise(() => {});
      }
      return originalGet(key);
    };
    const live = routesFor(state, sender, undefined, {
      scheduleDrain: () => {}, storageDeadlineMs: 5,
    });
    try {
      expect(await live.owner.recordWebSettlement(settlement('hung-first')))
        .toMatchObject({ ok: false, code: 'contributor-settlement-timeout' });
      await new Promise((resolve) => setTimeout(resolve, 8));
      expect(await live.owner.recordWebSettlement(settlement('recovered-second')))
        .toEqual({ ok: true, queued: true });
      expect(await live.owner.pending()).toHaveLength(1);
    } finally { live.restore(); }
  });

  test('a timed-out enable cannot overwrite a later acknowledged generation', async () => {
    const values = new Map<string, any>();
    let releaseLateWrite: () => void = () => {};
    const lateWrite = new Promise<void>((resolve) => { releaseLateWrite = resolve; });
    let holdFirstStateWrite = true;
    const kv = {
      get: async (key: string) => structuredClone(values.get(key) ?? null),
      set: async (key: string, value: any) => {
        if (key.startsWith(CONTRIBUTOR_STATE_PREFIX) && holdFirstStateWrite) {
          holdFirstStateWrite = false;
          await lateWrite;
        }
        values.set(key, structuredClone(value));
      },
      delete: async (key: string) => { values.delete(key); },
      list: async (prefix: string) => Object.fromEntries([...values.entries()]
        .filter(([key]) => key.startsWith(prefix))),
    };
    const authority = createPreviewContributorAuthority({
      kv, storageDeadlineMs: 5, now: () => 100, makeId: () => crypto.randomUUID(),
    });
    const target = { authority: { target: 'semantic:contributor/enable:options' },
      signal: { aborted: false }, deadlineAt: Date.now() + 100 };
    expect(await authority.handle('semantic.contributor.enable', {
      expected: null, value: enabledRecord('late-consent'),
    }, target))
      .toMatchObject({ ok: false, outcomeKnown: false });
    expect(await authority.handle('semantic.contributor.enable', {
      expected: null, value: enabledRecord('acknowledged-consent'),
    }, target))
      .toMatchObject({ ok: true, outcomeKnown: true });
    const acknowledged = await authority.arm();
    expect(acknowledged.enabled).toBe(true);
    releaseLateWrite();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await authority.arm()).toEqual(acknowledged);
  });

  test('an unseen pre-crash enable cannot win after a restarted owner acknowledges consent', async () => {
    const values = new Map<string, any>();
    let releaseLateWrite: () => void = () => {};
    const lateWrite = new Promise<void>((resolve) => { releaseLateWrite = resolve; });
    let holdFirstStateWrite = true;
    const kv = {
      get: async (key: string) => structuredClone(values.get(key) ?? null),
      set: async (key: string, value: any) => {
        if (key.startsWith(CONTRIBUTOR_STATE_PREFIX) && holdFirstStateWrite) {
          holdFirstStateWrite = false;
          await lateWrite;
        }
        values.set(key, structuredClone(value));
      },
      delete: async (key: string) => { values.delete(key); },
      list: async (prefix: string) => Object.fromEntries([...values.entries()]
        .filter(([key]) => key.startsWith(prefix))),
    };
    const target = { authority: { target: 'semantic:contributor/enable:options' },
      signal: { aborted: false }, deadlineAt: Date.now() + 100 };
    const beforeCrash = createPreviewContributorAuthority({
      kv, storageDeadlineMs: 5, now: () => 100, makeId: () => crypto.randomUUID(),
    });
    expect(await beforeCrash.handle('semantic.contributor.enable', {
      expected: null, value: enabledRecord('pre-crash-consent'),
    }, target))
      .toMatchObject({ ok: false, outcomeKnown: false });
    const restarted = createPreviewContributorAuthority({
      kv, storageDeadlineMs: 5, now: () => 200, makeId: () => crypto.randomUUID(),
    });
    expect(await restarted.handle('semantic.contributor.enable', {
      expected: null, value: enabledRecord('restarted-consent'),
    }, target))
      .toMatchObject({ ok: true, outcomeKnown: true });
    const acknowledged = await restarted.arm();
    releaseLateWrite();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await restarted.arm()).toEqual(acknowledged);
  });

  test('timed-out revocation and late cleanup cannot delete a re-enabled generation', async () => {
    const state = storage(enabledRecord());
    const values = state.listed('');
    const backing = new Map<string, any>(Object.entries(values));
    let releaseRevocation: () => void = () => {};
    const lateRevocation = new Promise<void>((resolve) => { releaseRevocation = resolve; });
    let holdRevocation = false;
    const deleted: string[] = [];
    const kv = {
      get: async (key: string) => structuredClone(backing.get(key) ?? null),
      set: async (key: string, value: any) => {
        if (key.startsWith(CONTRIBUTOR_STATE_PREFIX) && value?.state === 'revoked'
            && holdRevocation) {
          holdRevocation = false;
          await lateRevocation;
        }
        backing.set(key, structuredClone(value));
      },
      delete: async (key: string) => { deleted.push(key); backing.delete(key); },
      list: async (prefix: string) => Object.fromEntries([...backing.entries()]
        .filter(([key]) => key.startsWith(prefix))),
    };
    const authority = createPreviewContributorAuthority({
      kv, storageDeadlineMs: 5, now: () => 300, makeId: () => crypto.randomUUID(),
    });
    holdRevocation = true;
    const disableTarget = { authority: { target: 'semantic:contributor/disable:options' },
      signal: { aborted: false }, deadlineAt: Date.now() + 100 };
    expect(await authority.handle('semantic.contributor.clear', {}, disableTarget))
      .toMatchObject({ ok: false, outcomeKnown: false });
    const enableTarget = { authority: { target: 'semantic:contributor/enable:options' },
      signal: { aborted: false }, deadlineAt: Date.now() + 100 };
    expect(await authority.handle('semantic.contributor.enable', {
      expected: null, value: enabledRecord('re-enabled-consent'),
    }, enableTarget))
      .toMatchObject({ ok: true, outcomeKnown: true });
    const acknowledged = await authority.arm();
    releaseRevocation();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await authority.arm()).toEqual(acknowledged);
    const currentKey = Object.entries(await kv.list(CONTRIBUTOR_STATE_PREFIX))
      .sort((left, right) => right[1].revision - left[1].revision)[0][0];
    expect(deleted).not.toContain(currentKey);
  });

  test('production enable timeout then re-enable ignores the late write', async () => {
    const state = storage(null);
    const sender = {};
    const originalSet = state.kv.set;
    let releaseLateWrite: () => void = () => {};
    const lateWrite = new Promise<void>((resolve) => { releaseLateWrite = resolve; });
    let holdFirstStateWrite = true;
    state.kv.set = async (key: string, value: any) => {
      if (key.startsWith(CONTRIBUTOR_STATE_PREFIX) && holdFirstStateWrite) {
        holdFirstStateWrite = false;
        await lateWrite;
      }
      await originalSet(key, value);
    };
    const owner = directRoutesFor(state, sender);
    expect(await owner.routes['contributor/enable']({ type: 'contributor/enable' }, sender))
      .toMatchObject({ ok: false, outcomeKnown: false });
    expect(await owner.routes['contributor/enable']({ type: 'contributor/enable' }, sender))
      .toMatchObject({ ok: true, status: { enabled: true } });
    const acknowledged = await owner.arm();
    releaseLateWrite();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await owner.arm()).toEqual(acknowledged);
  });

  test('production enable timeout survives restart, re-enable, and the late write', async () => {
    const state = storage(null);
    const sender = {};
    const originalSet = state.kv.set;
    let releaseLateWrite: () => void = () => {};
    const lateWrite = new Promise<void>((resolve) => { releaseLateWrite = resolve; });
    let holdFirstStateWrite = true;
    state.kv.set = async (key: string, value: any) => {
      if (key.startsWith(CONTRIBUTOR_STATE_PREFIX) && holdFirstStateWrite) {
        holdFirstStateWrite = false;
        await lateWrite;
      }
      await originalSet(key, value);
    };
    const beforeRestart = directRoutesFor(state, sender);
    expect(await beforeRestart.routes['contributor/enable']({
      type: 'contributor/enable',
    }, sender)).toMatchObject({ ok: false, outcomeKnown: false });
    const restarted = directRoutesFor(state, sender);
    expect(await restarted.routes['contributor/enable']({ type: 'contributor/enable' }, sender))
      .toMatchObject({ ok: true, status: { enabled: true } });
    const acknowledged = await restarted.arm();
    releaseLateWrite();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await restarted.arm()).toEqual(acknowledged);
  });

  test('production disable timeout then re-enable ignores the late revocation', async () => {
    const state = storage(null);
    const sender = {};
    const owner = directRoutesFor(state, sender);
    expect(await owner.routes['contributor/enable']({ type: 'contributor/enable' }, sender))
      .toMatchObject({ ok: true });
    const originalSet = state.kv.set;
    let releaseLateRevocation: () => void = () => {};
    const lateRevocation = new Promise<void>((resolve) => { releaseLateRevocation = resolve; });
    let holdRevocation = true;
    state.kv.set = async (key: string, value: any) => {
      if (key.startsWith(CONTRIBUTOR_STATE_PREFIX) && value?.state === 'revoked'
          && holdRevocation) {
        holdRevocation = false;
        await lateRevocation;
      }
      await originalSet(key, value);
    };
    expect(await owner.routes['contributor/disable']({ type: 'contributor/disable' }, sender))
      .toMatchObject({ ok: false, outcomeKnown: false });
    expect(await owner.routes['contributor/enable']({ type: 'contributor/enable' }, sender))
      .toMatchObject({ ok: true, status: { enabled: true } });
    const acknowledged = await owner.arm();
    releaseLateRevocation();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await owner.arm()).toEqual(acknowledged);
  });

  test('production disable timeout survives restart, re-enable, and late cleanup', async () => {
    const state = storage(null);
    const sender = {};
    const beforeRestart = directRoutesFor(state, sender);
    expect(await beforeRestart.routes['contributor/enable']({
      type: 'contributor/enable',
    }, sender)).toMatchObject({ ok: true });
    const originalSet = state.kv.set;
    let releaseLateRevocation: () => void = () => {};
    const lateRevocation = new Promise<void>((resolve) => { releaseLateRevocation = resolve; });
    let holdRevocation = true;
    state.kv.set = async (key: string, value: any) => {
      if (key.startsWith(CONTRIBUTOR_STATE_PREFIX) && value?.state === 'revoked'
          && holdRevocation) {
        holdRevocation = false;
        await lateRevocation;
      }
      await originalSet(key, value);
    };
    expect(await beforeRestart.routes['contributor/disable']({
      type: 'contributor/disable',
    }, sender)).toMatchObject({ ok: false, outcomeKnown: false });
    const restarted = directRoutesFor(state, sender);
    expect(await restarted.routes['contributor/enable']({ type: 'contributor/enable' }, sender))
      .toMatchObject({ ok: true, status: { enabled: true } });
    const acknowledged = await restarted.arm();
    releaseLateRevocation();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await restarted.arm()).toEqual(acknowledged);
  });

  test('late snapshot cleanup never deletes a newer acknowledged generation', async () => {
    const state = storage(null);
    const sender = {};
    const owner = directRoutesFor(state, sender);
    expect(await owner.routes['contributor/enable']({ type: 'contributor/enable' }, sender))
      .toMatchObject({ ok: true });
    const oldKey = Object.keys(state.listed(CONTRIBUTOR_STATE_PREFIX))[0];
    const originalDelete = state.kv.delete;
    let releaseLateDelete: () => void = () => {};
    const lateDelete = new Promise<void>((resolve) => { releaseLateDelete = resolve; });
    let holdOldDelete = true;
    const deleted: string[] = [];
    state.kv.delete = async (key: string) => {
      if (key === oldKey && holdOldDelete) {
        holdOldDelete = false;
        await lateDelete;
      }
      deleted.push(key);
      await originalDelete(key);
    };
    expect(await owner.routes['contributor/disable']({ type: 'contributor/disable' }, sender))
      .toMatchObject({ ok: true, status: { enabled: false } });
    expect(await owner.routes['contributor/enable']({ type: 'contributor/enable' }, sender))
      .toMatchObject({ ok: true, status: { enabled: true } });
    const acknowledged = await owner.arm();
    const currentKey = Object.entries(state.listed(CONTRIBUTOR_STATE_PREFIX))
      .sort((left, right) => right[1].revision - left[1].revision)[0][0];
    releaseLateDelete();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(deleted).not.toContain(currentKey);
    expect(await owner.arm()).toEqual(acknowledged);
  });

  test('revocation recovers an oversized malformed journal without trusting its revision', async () => {
    const state = storage(null);
    for (let index = 0; index < 129; index += 1) {
      await state.kv.set(`${CONTRIBUTOR_STATE_PREFIX}corrupt-${index}`, {
        version: 2,
        revision: index === 128 ? Number.MAX_SAFE_INTEGER : index + 1,
        state: 'active',
        record: { raw: 'not-a-contributor-record' },
      });
    }
    const authority = createPreviewContributorAuthority({ kv: state.kv });
    expect(await authority.handle('semantic.contributor.clear', {}, {
      authority: { target: 'semantic:contributor/disable:options' },
      signal: { aborted: false }, deadlineAt: Date.now() + 1_000,
    })).toMatchObject({ ok: true, outcomeKnown: true });
    expect(await authority.arm()).toEqual({ enabled: false, generation: null });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const snapshots = state.listed(CONTRIBUTOR_STATE_PREFIX);
    expect(Object.keys(snapshots)).toHaveLength(1);
    expect(Object.values(snapshots)[0]).toMatchObject({ state: 'revoked', record: null });
  });

  test('revocation writes its durable marker before any recovery read or cleanup', async () => {
    const state = storage(enabledRecord());
    const operations: string[] = [];
    const authority = createPreviewContributorAuthority({
      kv: {
        get: async (key: string) => { operations.push(`get:${key}`); return state.kv.get(key); },
        set: async (key: string, value: any) => {
          operations.push(`set:${key}`); await state.kv.set(key, value);
        },
        delete: async (key: string) => {
          operations.push(`delete:${key}`); await state.kv.delete(key);
        },
        list: async (prefix: string) => {
          operations.push(`list:${prefix}`); return state.kv.list(prefix);
        },
      },
    });
    expect(await authority.handle('semantic.contributor.clear', {}, {
      authority: { target: 'semantic:contributor/disable:options' },
      signal: { aborted: false }, deadlineAt: Date.now() + 1_000,
    })).toMatchObject({ ok: true, outcomeKnown: true });
    expect(operations[0]).toStartWith(`set:${CONTRIBUTOR_STATE_PREFIX}`);
  });

  test('revocation repairs its marker above a durable revision after clock rollback', async () => {
    const state = storage(null);
    await state.kv.set(`${CONTRIBUTOR_STATE_PREFIX}future-active`, {
      version: 2, revision: 5_000_000_000_000_000,
      state: 'active', record: enabledRecord(),
    });
    const authority = createPreviewContributorAuthority({
      kv: state.kv, now: () => 100,
    });
    expect(await authority.handle('semantic.contributor.clear', {}, {
      authority: { target: 'semantic:contributor/disable:options' },
      signal: { aborted: false }, deadlineAt: Date.now() + 1_000,
    })).toMatchObject({ ok: true, outcomeKnown: true });
    expect(await authority.arm()).toEqual({ enabled: false, generation: null });
    const revisions = Object.values(state.listed(CONTRIBUTOR_STATE_PREFIX))
      .map((snapshot: any) => snapshot.revision);
    expect(Math.max(...revisions)).toBe(5_000_000_000_000_001);
  });

  test('terminal settlement awaits only the durable receipt when the host is hung', async () => {
    const state = storage(enabledRecord());
    const sender = {};
    let posted = 0;
    const live = routesFor(state, sender, () => { posted += 1; }, { channelDeadlineMs: 5 });
    try {
      const result = await Promise.race([
        live.owner.recordWebSettlement(settlement()),
        new Promise((resolve) => setTimeout(() => resolve('slow'), 25)),
      ]);
      expect(result).toEqual({ ok: true, queued: true });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(posted).toBe(2);
      expect(state.listed(CONTRIBUTOR_PENDING_RECEIPT_PREFIX)).toEqual({});
    } finally { live.restore(); }
  });

  test('a timed-out receipt append survives restart without losing or doubling settlement', async () => {
    const state = storage(enabledRecord());
    const sender = {};
    const originalSet = state.kv.set;
    let releaseLateReceipt: () => void = () => {};
    const lateReceipt = new Promise<void>((resolve) => { releaseLateReceipt = resolve; });
    let holdFirstReceipt = true;
    state.kv.set = async (key: string, value: any) => {
      if (key.startsWith(CONTRIBUTOR_PENDING_RECEIPT_PREFIX) && holdFirstReceipt) {
        holdFirstReceipt = false;
        await lateReceipt;
      }
      await originalSet(key, value);
    };
    const beforeRestart = directRoutesFor(state, sender);
    expect(await beforeRestart.recordWebSettlement(settlement('late-terminal')))
      .toMatchObject({ ok: false, outcomeKnown: false });
    const restarted = directRoutesFor(state, sender);
    expect(await restarted.recordWebSettlement(settlement('late-terminal')))
      .toEqual({ ok: true, queued: true });
    releaseLateReceipt();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await restarted.drainPending()).toEqual({ ok: true, drained: 1 });
    expect(Object.values(state.value().aggregate.rows)[0]).toMatchObject({ actorTurns: 1 });
    expect(await restarted.pending()).toEqual([]);
  });

  test('a late failure write cannot resurrect a dropped poison receipt', async () => {
    const state = storage(enabledRecord());
    const authority = createPreviewContributorAuthority({
      kv: state.kv, storageDeadlineMs: 5,
    });
    expect(await authority.appendPending(settlement('poison-race')))
      .toEqual({ ok: true, queued: true });
    const receipt = Object.values(state.listed(CONTRIBUTOR_PENDING_RECEIPT_PREFIX))[0];
    const originalSet = state.kv.set;
    let releaseLateFailure: () => void = () => {};
    const lateFailure = new Promise<void>((resolve) => { releaseLateFailure = resolve; });
    let holdFirstFailure = true;
    state.kv.set = async (key: string, value: any) => {
      if (key.startsWith(CONTRIBUTOR_PENDING_RECEIPT_PREFIX) && value?.attempts === 1
          && holdFirstFailure) {
        holdFirstFailure = false;
        await lateFailure;
      }
      await originalSet(key, value);
    };
    await expect(authority.notePendingFailure(receipt.operationToken))
      .rejects.toThrow('contributor-storage-timeout');
    expect(await authority.notePendingFailure(receipt.operationToken))
      .toEqual({ found: true, dropped: false });
    expect(await authority.notePendingFailure(receipt.operationToken))
      .toEqual({ found: true, dropped: true });
    releaseLateFailure();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(Object.keys(state.listed(CONTRIBUTOR_PENDING_DROP_PREFIX))).toHaveLength(1);
    expect(await authority.pending()).toEqual([]);
    expect(await authority.appendPending(settlement('healthy-after-poison')))
      .toEqual({ ok: true, queued: true });
    expect((await authority.pending()).map((item: any) => item.durationMs)).toEqual([42]);
  });

  test('pending receipts keep FIFO order when browser storage enumerates keys in reverse', async () => {
    const state = storage(enabledRecord());
    const authority = createPreviewContributorAuthority({ kv: state.kv, now: () => 100 });
    expect(await authority.appendPending(settlement('fifo-first', { durationMs: 1 })))
      .toMatchObject({ ok: true, queued: true });
    expect(await authority.appendPending(settlement('fifo-second', { durationMs: 2 })))
      .toMatchObject({ ok: true, queued: true });
    const originalList = state.kv.list;
    state.kv.list = async (prefix: string) => Object.fromEntries(
      Object.entries(await originalList(prefix)).reverse(),
    );
    expect((await authority.pending()).map((item: any) => item.durationMs)).toEqual([1, 2]);
  });

  test('refuses a forged sender before opening a lease or reading storage', async () => {
    let reads = 0;
    const sender = {};
    const owner = createLiveRoutes({
      kv: { get: async () => { reads += 1; }, set: async () => {}, delete: async () => {},
        list: async () => { reads += 1; return {}; } },
      optionsUi: (candidate: any) => candidate === sender,
      sidepanelUi: () => false, homeUi: () => false,
      validateFeedback: async () => ({ ok: false }),
      offscreenUrl: 'chrome-extension://id/offscreen/offscreen.html',
      featureHost: { runtime: { runWithLease: async () => { throw new Error('must not run'); } } },
    });
    expect(await owner.routes['contributor/status']({ type: 'contributor/status' }, {}))
      .toEqual({ ok: false, code: 'contributor-channel-admission-denied', outcomeKnown: true });
    expect(reads).toBe(0);
  });

  test('refuses forged feedback before recovery validation or host acquisition', async () => {
    let guarded = 0;
    let leased = 0;
    const owner = createLiveRoutes({
      kv: { get: async () => null, set: async () => {}, delete: async () => {},
        list: async () => ({}) },
      optionsUi: () => false, sidepanelUi: () => false, homeUi: () => false,
      validateFeedback: async () => { guarded += 1; return { ok: true, messages: [] }; },
      offscreenUrl: 'chrome-extension://id/offscreen/offscreen.html',
      featureHost: { runtime: { runWithLease: async () => { leased += 1; } } },
    });
    expect(await owner.routes['contributor/feedback']({
      type: 'contributor/feedback', sessionId: 'chat', messageId: 'answer', verdict: 'worked',
    }, {})).toMatchObject({ ok: false, error: 'trusted-chat-sender-required' });
    expect({ guarded, leased }).toEqual({ guarded: 0, leased: 0 });
  });

  test('explicit re-enable rotates consent and revocation commits before cleanup', async () => {
    const state = storage(null);
    const sender = {};
    const live = routesFor(state, sender);
    try {
      expect(await live.routes['contributor/enable']({ type: 'contributor/enable' }, sender))
        .toMatchObject({ ok: true, status: { enabled: true, rowCount: 0 } });
      const generation = state.value().consent.generation;
      expect(await live.routes['contributor/enable']({ type: 'contributor/enable' }, sender))
        .toMatchObject({ ok: true, status: { enabled: true } });
      expect(state.value().consent.generation).not.toBe(generation);
      const activeGeneration = state.value().consent.generation;
      expect(await live.owner.recordWebSettlement(settlement('disable-pending', {
        consentGeneration: activeGeneration,
      }))).toEqual({ ok: true, queued: true });
      expect(Object.keys(state.listed(CONTRIBUTOR_PENDING_RECEIPT_PREFIX))).toHaveLength(1);
      expect(await live.routes['contributor/disable']({ type: 'contributor/disable' }, sender))
        .toMatchObject({ ok: true, status: { enabled: false, rowCount: 0 } });
      expect(state.value()).toBeNull();
      expect(state.listed(CONTRIBUTOR_PENDING_RECEIPT_PREFIX)).toEqual({});
    } finally { live.restore(); }
  });

  test('storage errors after a mutation request remain outcome-unknown', async () => {
    const authority = createPreviewContributorAuthority({
      kv: { get: async () => null, set: async () => { throw new Error('lost'); },
        delete: async () => {}, list: async () => ({}) },
    });
    expect(await authority.handle('semantic.contributor.enable', {
      expected: null, value: enabledRecord('failed-consent'),
    }, {
      authority: { target: 'semantic:contributor/enable:options' },
      signal: { aborted: false }, deadlineAt: Date.now() + 100,
    })).toMatchObject({ ok: false, outcomeKnown: false });
  });

  test('records one live Web-actor cohort and applies idempotent terminal feedback', async () => {
    const state = storage(enabledRecord());
    const optionsSender = {};
    const sidepanelSender = {};
    const messages = [
      { role: 'user', id: 'human-1', content: 'present', synthetic: false },
      { role: 'assistant', id: 'call-1', content: 'present', toolUses: [
        { id: 'tool-1', name: 'message_actor', input: { await: true } },
      ] },
      { role: 'assistant', id: 'answer-1', content: 'present', toolUses: [],
        stopReason: 'end_turn' },
    ];
    const live = routesFor(state, optionsSender, undefined, {
      sidepanel: sidepanelSender,
      validate: async () => ({ ok: true, messages }),
      scheduleDrain: () => {},
    });
    try {
      expect(await live.owner.arm()).toEqual({
        enabled: true, generation: 'consent-generation-1',
      });
      expect(await live.owner.recordWebSettlement(settlement()))
        .toEqual({ ok: true, queued: true });
      expect(state.value().aggregate.rows).toEqual({});

      const request = {
        type: 'contributor/feedback', sessionId: 'chat-1',
        messageId: 'answer-1', verdict: 'worked',
      };
      expect(await live.routes['contributor/feedback'](request, sidepanelSender))
        .toEqual({ ok: true, recorded: true, reason: null });
      expect(await live.owner.pending()).toEqual([]);
      expect(await live.routes['contributor/feedback'](request, sidepanelSender))
        .toEqual({ ok: true, recorded: false, reason: null });
      expect(Object.values(state.value().aggregate.rows)[0]).toMatchObject({
        actorTurns: 1, worked: 1, didntWork: 0,
      });
    } finally { live.restore(); }
  });

  test('replays a pending settlement after owner restart and dedupes its operation key', async () => {
    const state = storage(enabledRecord());
    const sender = {};
    const first = routesFor(state, sender, undefined, { scheduleDrain: () => {} });
    try {
      expect(await first.owner.recordWebSettlement(settlement('delivery-replay')))
        .toEqual({ ok: true, queued: true });
      expect(await first.owner.recordWebSettlement(settlement('delivery-replay')))
        .toEqual({ ok: true, queued: false, reason: 'duplicate' });
    } finally { first.restore(); }

    const restarted = routesFor(state, sender, undefined, { scheduleDrain: () => {} });
    try {
      expect(await restarted.owner.drainPending()).toEqual({ ok: true, drained: 1 });
      expect(await restarted.owner.pending()).toEqual([]);
      expect(Object.values(state.value().aggregate.rows)[0]).toMatchObject({ actorTurns: 1 });
    } finally { restarted.restore(); }
  });

  test('drops a deterministic poison receipt after two attempts and advances FIFO', async () => {
    const state = storage(enabledRecord());
    const sender = {};
    const attempts: number[] = [];
    const owner = createPreviewContributorRoutes({
      kv: state.kv, optionsUi: (candidate: any) => candidate === sender,
      sidepanelUi: () => false, homeUi: () => false,
      validateFeedback: async () => ({ ok: false }),
      offscreenUrl: null, featureHost: null, scheduleDrain: () => {},
      dispatchSemanticRoute: async (route: string, message: any, options: any) => {
        if (route === 'contributor/settlement') attempts.push(message.durationMs);
        if (route === 'contributor/settlement' && message.durationMs === 1) {
          return { ok: false, error: 'deterministic poison', outcomeKnown: true };
        }
        return dispatchContributorSemanticRoute(route, message, options);
      },
    });
    await owner.recordWebSettlement(settlement('poison', { durationMs: 1 }));
    await owner.recordWebSettlement(settlement('healthy', { durationMs: 2 }));
    expect(await owner.drainPending()).toEqual({ ok: true, drained: 2 });
    expect(attempts).toEqual([1, 1, 2]);
    expect(await owner.pending()).toEqual([]);
    expect(Object.values(state.value().aggregate.rows)[0]).toMatchObject({ actorTurns: 1 });
  });

  test('Firefox preview uses the same contributor route and settlement owner', async () => {
    const state = storage(null);
    const sender = {};
    const owner = makeKernelFirefoxContributor()({
      kv: state.kv, optionsUi: (candidate: any) => candidate === sender,
      sidepanelUi: () => false, homeUi: () => false,
      validateFeedback: async () => ({ ok: false }), scheduleDrain: () => {},
    });
    expect(await owner.arm()).toEqual({ enabled: false, generation: null });
    expect(await owner.routes['contributor/enable']({ type: 'contributor/enable' }, sender))
      .toMatchObject({ ok: true, status: { enabled: true } });
    const generation = state.value().consent.generation;
    expect(await owner.recordWebSettlement(settlement('firefox-delivery', {
      consentGeneration: generation, browser: 'firefox',
    }))).toEqual({ ok: true, queued: true });
    expect(await owner.drainPending()).toEqual({ ok: true, drained: 1 });
    expect(Object.values(state.value().aggregate.rows)[0]).toMatchObject({
      actorTurns: 1, browser: 'firefox',
    });
  });

  test('drops a deterministically unreachable host receipt after bounded retries', async () => {
    const state = storage(enabledRecord());
    const sender = {};
    const lost = routesFor(state, sender, () => {}, {
      scheduleDrain: () => {}, channelDeadlineMs: 5,
    });
    try {
      await lost.owner.recordWebSettlement(settlement('delivery-host-loss'));
      expect(await lost.owner.drainPending()).toEqual({ ok: true, drained: 1 });
      expect(await lost.owner.pending()).toEqual([]);
    } finally { lost.restore(); }

    const recovered = routesFor(state, sender, undefined, { scheduleDrain: () => {} });
    try {
      expect(await recovered.owner.drainPending()).toEqual({ ok: true, drained: 0 });
      expect(await recovered.owner.pending()).toEqual([]);
      expect(state.value().aggregate.rows).toEqual({});
    } finally { recovered.restore(); }
  });

  test('refuses oversized pending facts before storage or host work', async () => {
    const state = storage(enabledRecord());
    const sender = {};
    const live = routesFor(state, sender, undefined, { scheduleDrain: () => {} });
    try {
      expect(await live.owner.recordWebSettlement(settlement('x'.repeat(201))))
        .toMatchObject({ ok: false, code: 'contributor-pending-receipt-invalid' });
      expect(await live.owner.recordWebSettlement(settlement('too-many-actions', {
        actions: Array.from({ length: 129 }, () => 'page_action'),
      }))).toMatchObject({ ok: false, code: 'contributor-pending-receipt-invalid' });
      expect(await live.owner.recordWebSettlement(settlement('raw-cohort', {
        providerCode: 999, modelFamilyCode: 999,
      }))).toMatchObject({ ok: false, code: 'contributor-pending-receipt-invalid' });
      expect(state.listed(CONTRIBUTOR_PENDING_RECEIPT_PREFIX)).toEqual({});
    } finally { live.restore(); }
  });

  test('bounds the private channel offer and has no semantic arm route', () => {
    const base = {
      type: CONTRIBUTOR_CHANNEL_OFFER, protocol: CONTRIBUTOR_CHANNEL_PROTOCOL,
      channelId: 'channel-1', lease: {}, message: {},
    };
    expect(parseContributorOffer({ ...base, route: 'contributor/arm' })).toBeNull();
    expect(parseContributorOffer({
      ...base, route: 'contributor/feedback', message: { value: 'x'.repeat(600_000) },
    })).toBeNull();
    expect(parseContributorOffer({
      ...base, route: 'contributor/feedback', message: { value: new Array(10_001) },
    })).toBeNull();
  });

  test('loss after the exact write request cannot be replayed as known-safe', async () => {
    const state = storage(null);
    const sender = {};
    const live = routesFor(state, sender, (offer: any, ports: MessagePort[]) => {
      const port = ports[0];
      port.start();
      port.postMessage({
        type: CONTRIBUTOR_CHANNEL_CALL, protocol: CONTRIBUTOR_CHANNEL_PROTOCOL,
        channelId: offer.channelId, requestId: 'write-1',
        operation: 'semantic.contributor.enable', payload: {
          expected: null, value: enabledRecord('lost-channel-consent'),
        },
      });
      port.onmessage = () => port.postMessage({
        type: CONTRIBUTOR_CHANNEL_RESULT, protocol: 999,
        channelId: offer.channelId, result: { ok: true },
      });
    });
    try {
      expect(await live.routes['contributor/enable']({ type: 'contributor/enable' }, sender))
        .toMatchObject({ ok: false, outcomeKnown: false, retryable: false });
      expect(state.value()).toMatchObject({ consent: { enabled: true } });
    } finally { live.restore(); }
  });

  test('the production actor and vault owners wire the same preview-only capability', () => {
    const background = join(import.meta.dir, '../../extension/background');
    const actor = readFileSync(join(background, 'kernel-turn-authority-adapter.js'), 'utf8');
    const vault = readFileSync(join(background, 'vault-kernel.js'), 'utf8');
    expect(actor).toContain('deps.contributor?.arm');
    expect(actor).toContain('deps.contributor.recordWebSettlement');
    expect(vault).toContain('targetContributor.recordWebSettlement(input)');
    expect(vault).toContain('targetContributor?.routes ?? {}');
    expect(vault).toContain('validateContributorFeedback(message)');
  });
});
