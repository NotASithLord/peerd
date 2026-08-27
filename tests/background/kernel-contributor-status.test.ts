import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createPreviewContributorAuthority, createPreviewContributorRoutes,
} from '../../extension/background/kernel-preview-addon.js';
import { acceptContributorOffer } from '../../extension/offscreen/semantic-routes/contributor.js';
import {
  CONTRIBUTOR_CHANNEL_CALL, CONTRIBUTOR_CHANNEL_PROTOCOL,
  CONTRIBUTOR_CHANNEL_RESULT,
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

const storage = (initial: any) => {
  let value = initial;
  return {
    kv: {
      get: async () => structuredClone(value),
      set: async (_key: string, next: any) => { value = structuredClone(next); },
      delete: async () => { value = null; },
    },
    value: () => structuredClone(value),
  };
};

const routesFor = (state: ReturnType<typeof storage>, sender: any, postMessage?: any,
  feedback: { sidepanel?: any; home?: any; validate?: (message: any) => Promise<any> } = {}) => {
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
    const live = routesFor(state, sender);
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
      expect(await live.routes['contributor/disable']({ type: 'contributor/disable' }, sender))
        .toMatchObject({ ok: true, status: { enabled: false, rowCount: 0 } });
      expect(state.value()).toBeNull();
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
    });
    try {
      expect(await live.owner.arm()).toEqual({
        enabled: true, generation: 'consent-generation-1',
      });
      expect(await live.owner.recordWebSettlement({
        consentGeneration: 'consent-generation-1', operationKey: 'delivery-1',
        feedbackContextKey: 'chat-1:tool-1',
        decision: { requested: 'tools', resolved: 'tools', fallback: 'none' },
        browser: 'chrome', extensionVersion: '0.6.0', channel: 'preview',
        provider: 'anthropic', model: 'claude-sonnet-4-6', durationMs: 42,
        toolNames: ['snapshot'],
        assistantMessages: [{ stopReason: 'end_turn' }],
        stopped: false, result: 'done', usage: { inputTokens: 10, outputTokens: 5 },
      })).toEqual({ ok: true, recorded: true });

      const request = {
        type: 'contributor/feedback', sessionId: 'chat-1',
        messageId: 'answer-1', verdict: 'worked',
      };
      expect(await live.routes['contributor/feedback'](request, sidepanelSender))
        .toEqual({ ok: true, recorded: true, reason: null });
      expect(await live.routes['contributor/feedback'](request, sidepanelSender))
        .toEqual({ ok: true, recorded: false, reason: null });
      expect(Object.values(state.value().aggregate.rows)[0]).toMatchObject({
        actorTurns: 1, worked: 1, didntWork: 0,
      });
    } finally { live.restore(); }
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
