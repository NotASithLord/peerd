import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONTRIBUTOR_PENDING_RECEIPTS_KEY, createPreviewContributorAuthority,
  createPreviewContributorRoutes,
} from '../../extension/background/kernel-preview-addon.js';
import { acceptContributorOffer } from '../../extension/offscreen/semantic-routes/contributor.js';
import {
  CONTRIBUTOR_CHANNEL_CALL, CONTRIBUTOR_CHANNEL_OFFER, CONTRIBUTOR_CHANNEL_PROTOCOL,
  CONTRIBUTOR_CHANNEL_RESULT, parseContributorOffer,
} from '../../extension/shared/contributor-channel.js';
import { emptyContributorLocalState } from '../../extension/peerd-runtime/observability/contributor-metrics.js';

const createLiveRoutes = createPreviewContributorRoutes;

const enabledRecord = () => ({
  version: 1,
  consent: {
    enabled: true, schemaVersion: 1, disclosureVersion: 1,
    generation: 'consent-generation-1',
  },
  aggregate: emptyContributorLocalState(),
});

const settlement = (operationKey = 'delivery-1', overrides: Record<string, any> = {}) => ({
  version: 1,
  consentGeneration: 'consent-generation-1', operationKey,
  feedbackContextKey: 'chat-1:tool-1',
  decision: { requested: 'tools', resolved: 'tools', fallback: 'none' },
  browser: 'chrome', extensionVersion: '0.6.0', channel: 'preview',
  provider: 'anthropic', modelFamily: 'claude-sonnet', durationMs: 42,
  tokens: 15, outcome: 'completed', failure: 'none', actions: ['page_action'],
  ...overrides,
});

const storage = (initial: any) => {
  const values = new Map<string, any>();
  if (initial != null) values.set('contributor_metrics.aggregate.v1', structuredClone(initial));
  return {
    kv: {
      get: async (key: string) => structuredClone(values.get(key) ?? null),
      set: async (key: string, next: any) => { values.set(key, structuredClone(next)); },
      delete: async (key: string) => { values.delete(key); },
    },
    value: () => structuredClone(values.get('contributor_metrics.aggregate.v1') ?? null),
    read: (key: string) => structuredClone(values.get(key) ?? null),
  };
};

const routesFor = (state: ReturnType<typeof storage>, sender: any, postMessage?: any,
    feedback: { sidepanel?: any; home?: any; validate?: (message: any) => Promise<any>;
      scheduleDrain?: (operation: () => void) => void; channelDeadlineMs?: number } = {}) => {
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
  });
  return { owner, routes: owner.routes,
    restore: () => { (globalThis as any).clients = prior; } };
};

describe('Preview Contributor Metrics private channel', () => {
  test('target addon is update plus one fixed contributor capability', () => {
    const addon = (globalThis as any)[Symbol.for('peerd.kernel.target-addon.v1')];
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
      expect(state.read(CONTRIBUTOR_PENDING_RECEIPTS_KEY)).toBeNull();
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
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(posted).toBe(1);
      expect(state.read(CONTRIBUTOR_PENDING_RECEIPTS_KEY)?.receipts).toHaveLength(1);
    } finally { live.restore(); }
  });

  test('refuses a forged sender before opening a lease or reading storage', async () => {
    let reads = 0;
    const sender = {};
    const owner = createLiveRoutes({
      kv: { get: async () => { reads += 1; }, set: async () => {}, delete: async () => {} },
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
      kv: { get: async () => null, set: async () => {}, delete: async () => {} },
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

  test('enables idempotently and disables the one atomic local record', async () => {
    const state = storage(null);
    const sender = {};
    const live = routesFor(state, sender);
    try {
      expect(await live.routes['contributor/enable']({ type: 'contributor/enable' }, sender))
        .toMatchObject({ ok: true, status: { enabled: true, rowCount: 0 } });
      const generation = state.value().consent.generation;
      expect(await live.routes['contributor/enable']({ type: 'contributor/enable' }, sender))
        .toMatchObject({ ok: true, status: { enabled: true } });
      expect(state.value().consent.generation).toBe(generation);
      expect(await live.owner.recordWebSettlement(settlement('disable-pending', {
        consentGeneration: generation,
      }))).toEqual({ ok: true, queued: true });
      expect(state.read(CONTRIBUTOR_PENDING_RECEIPTS_KEY)?.receipts).toHaveLength(1);
      expect(await live.routes['contributor/disable']({ type: 'contributor/disable' }, sender))
        .toMatchObject({ ok: true, status: { enabled: false, rowCount: 0 } });
      expect(state.value()).toBeNull();
      expect(state.read(CONTRIBUTOR_PENDING_RECEIPTS_KEY)).toBeNull();
    } finally { live.restore(); }
  });

  test('storage errors after a mutation request remain outcome-unknown', async () => {
    const authority = createPreviewContributorAuthority({
      kv: { get: async () => null, set: async () => { throw new Error('lost'); },
        delete: async () => {} },
    });
    expect(await authority.handle('semantic.contributor.enable', { expected: null }, {
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

  test('keeps an idempotent receipt across host loss and drains it on retry', async () => {
    const state = storage(enabledRecord());
    const sender = {};
    const lost = routesFor(state, sender, () => {}, {
      scheduleDrain: () => {}, channelDeadlineMs: 5,
    });
    try {
      await lost.owner.recordWebSettlement(settlement('delivery-host-loss'));
      expect(await lost.owner.drainPending()).toMatchObject({ ok: false });
      expect(await lost.owner.pending()).toHaveLength(1);
    } finally { lost.restore(); }

    const recovered = routesFor(state, sender, undefined, { scheduleDrain: () => {} });
    try {
      expect(await recovered.owner.drainPending()).toEqual({ ok: true, drained: 1 });
      expect(await recovered.owner.pending()).toEqual([]);
      expect(Object.values(state.value().aggregate.rows)[0]).toMatchObject({ actorTurns: 1 });
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
        provider: 'private-provider', modelFamily: 'private-model',
      }))).toMatchObject({ ok: false, code: 'contributor-pending-receipt-invalid' });
      expect(state.read(CONTRIBUTOR_PENDING_RECEIPTS_KEY)).toBeNull();
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
        operation: 'semantic.contributor.enable', payload: { expected: null },
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
    expect(vault).toContain('targetContributor?.recordWebSettlement?.(input)');
    expect(vault).toContain('targetContributor?.routes ?? {}');
    expect(vault).toContain('validateContributorFeedback(message)');
  });
});
