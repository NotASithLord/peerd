import { describe, expect, test } from 'bun:test';
import {
  createPreviewSemanticAuthority,
} from '../../extension/background/kernel-update-addon.js';
import { bindControllerChannel } from '../../extension/offscreen/controller-shell.js';
import { CONTROLLER_BUILD_DIGEST } from '../../extension/shared/build-config.js';
import { dispatchContributorSemanticRoute } from '../../extension/offscreen/semantic-routes/contributor.js';
import { emptyContributorLocalState } from '../../extension/peerd-runtime/observability/contributor-metrics.js';
import { createSemanticDemandQuota } from '../../extension/shared/semantic-demand-policy.js';

const createLivePreviewRoutes = (globalThis as any)[
  Symbol.for('peerd.kernel.target-addon.v1')
].semantic;

const enabledRecord = () => ({
  version: 1,
  consent: {
    enabled: true, schemaVersion: 1, disclosureVersion: 1,
    generation: 'consent-generation-1',
  },
  aggregate: emptyContributorLocalState(),
});

const harness = (stored: any) => {
  let value = stored;
  const authority = createPreviewSemanticAuthority({
    kv: {
      get: async (key: string) => key === 'contributor_metrics.aggregate.v1' ? value : null,
      set: async (_key: string, next: any) => { value = structuredClone(next); },
      delete: async () => { value = null; },
    },
    optionsDemandRoute: (replayClass: string) => ({ replayClass }),
  });
  const call = (target = 'semantic:contributor/status:options') =>
    (operation: string, payload: unknown) => authority.handle(operation, payload, {
      authority: { target }, signal: { aborted: false }, deadlineAt: Date.now() + 1_000,
    });
  return { authority, call, stored: () => structuredClone(value) };
};

describe('demand-loaded Contributor Metrics status', () => {
  test('Preview contributes through one target addon contract', async () => {
    const addon = (globalThis as any)[Symbol.for('peerd.kernel.target-addon.v1')];
    expect(addon).toMatchObject({
      target: 'preview-chrome', update: expect.any(Function), semantic: expect.any(Function),
    });
    expect(Object.keys(addon).sort()).toEqual(['semantic', 'target', 'update']);
    const kernel = await Bun.file(new URL(
      '../../extension/background/vault-kernel.js', import.meta.url,
    )).text();
    expect(kernel).toContain("Symbol.for('peerd.kernel.target-addon.v1')");
    expect(kernel).not.toContain('peerd.kernel.preview-semantic.v1');
    expect(kernel).not.toContain('peerd.kernel.update.v1');
  });

  test('uses one exact Options-bound read and returns only the canonical status projection', async () => {
    const record = enabledRecord();
    const { call } = harness(record);
    const result = await dispatchContributorSemanticRoute('contributor/status', {}, {
      kernelCall: call(),
    });
    expect(result).toEqual({
      ok: true,
      status: {
        enabled: true, schemaVersion: 1, disclosureVersion: 1,
        bytes: expect.any(String), rowCount: 0, diagnostic: null,
      },
    });
    expect(JSON.stringify(result)).not.toContain(record.consent.generation);
    expect(JSON.stringify(result)).not.toContain('aggregate');
  });

  test('refuses a forged sender target before reading contributor storage', async () => {
    let reads = 0;
    const authority = createPreviewSemanticAuthority({
      kv: { get: async () => { reads += 1; return enabledRecord(); },
        set: async () => {}, delete: async () => {} },
      optionsDemandRoute: (replayClass: string) => ({ replayClass }),
    });
    expect(await authority.handle('semantic.contributor.read', {}, {
      authority: { target: 'semantic:contributor/status:first-party' },
      signal: { aborted: false }, deadlineAt: Date.now() + 1_000,
    })).toBeNull();
    expect(reads).toBe(0);
  });

  test('the controller grant admits exactly one status read', () => {
    const quota = createSemanticDemandQuota({ route: 'contributor/status' });
    expect(quota.admit('semantic.contributor.read', {})).toMatchObject({ ok: true });
    expect(quota.admit('semantic.contributor.read', {})).toMatchObject({ ok: false });
    expect(quota.admit('semantic.contributor.write', {})).toMatchObject({ ok: false });
  });

  test('enables and clears the one local record through exact Class-E operations', async () => {
    const state = harness(null);
    const enabled = await dispatchContributorSemanticRoute('contributor/enable', {}, {
      kernelCall: state.call('semantic:contributor/enable:options'),
    });
    expect(enabled).toMatchObject({ ok: true, status: { enabled: true, rowCount: 0 } });
    expect(state.stored()).toMatchObject({
      version: 1,
      consent: { enabled: true, schemaVersion: 1, disclosureVersion: 1 },
      aggregate: { version: 1, rows: {}, dedupe: [] },
    });
    expect(JSON.stringify(enabled)).not.toContain(state.stored().consent.generation);

    const disabled = await dispatchContributorSemanticRoute('contributor/disable', {}, {
      kernelCall: state.call('semantic:contributor/disable:options'),
    });
    expect(disabled).toMatchObject({ ok: true, status: { enabled: false, rowCount: 0 } });
    expect(state.stored()).toBeNull();
  });

  test('a stale enable cannot overwrite a newer consent record', async () => {
    const state = harness(null);
    const call = state.call('semantic:contributor/enable:options');
    expect(await call('semantic.contributor.enable', { expected: null }))
      .toMatchObject({ ok: true, value: { ok: true } });
    const generation = state.stored().consent.generation;
    expect(await call('semantic.contributor.enable', { expected: null }))
      .toEqual({ ok: true, outcomeKnown: true,
        value: { ok: false, error: 'contributor-state-changed' } });
    expect(state.stored().consent.generation).toBe(generation);
  });

  test('mutation grants refuse sibling operations and preserve unknown custody', async () => {
    const enable = createSemanticDemandQuota({ route: 'contributor/enable' });
    expect(enable.admit('semantic.contributor.enable-read', {})).toMatchObject({ ok: true });
    expect(enable.admit('semantic.contributor.enable', { expected: null }))
      .toMatchObject({ ok: true });
    expect(enable.admit('semantic.contributor.clear', {})).toMatchObject({ ok: false });

    const authority = createPreviewSemanticAuthority({
      kv: { get: async () => null, set: async () => { throw new Error('receipt-lost'); },
        delete: async () => {} },
      optionsDemandRoute: (replayClass: string) => ({ replayClass }),
    });
    expect(await authority.handle('semantic.contributor.enable', { expected: null }, {
      authority: { target: 'semantic:contributor/enable:options' },
      signal: { aborted: false }, deadlineAt: Date.now() + 1_000,
    })).toMatchObject({ ok: false, outcomeKnown: false });
  });

  test('live Preview routes admit Options, retry Class A once, and never replay Class E', async () => {
    const surface = { id: 'options' };
    const offscreenUrl = 'chrome-extension://id/offscreen/offscreen.html';
    const identity = {
      schema: 1 as const, buildId: `0.7.3:${CONTROLLER_BUILD_DIGEST}`,
      bootId: 'boot-preview-routes', kernelEpoch: 'kernel-preview-routes',
    };
    const good = {
      url: offscreenUrl,
      postMessage: (offer: any, ports: MessagePort[]) => bindControllerChannel({
        port: ports[0], channelId: offer.channelId, buildDigest: offer.buildDigest,
        kernelEpoch: offer.kernelEpoch, kernelIdentity: offer.kernelIdentity,
        hostEpoch: 'host-preview-routes', offeredCaps: offer.capabilities,
        supportedCaps: ['semantic.dispatch'],
        loadController: async () => ({
          call: async (_capability: string, value: any, options: any) => ({
            ok: true, outcomeKnown: true,
            semanticResult: await dispatchContributorSemanticRoute(
              value.route, value.message, { kernelCall: options.kernelCall },
            ),
          }),
        }),
      }),
    };
    const lost = {
      url: offscreenUrl,
      postMessage: (offer: any, ports: MessagePort[]) => {
        const port = ports[0];
        let sequence = 0;
        const send = (message: any) => port.postMessage({
          protocol: 2, channelId: offer.channelId, buildDigest: offer.buildDigest,
          kernelEpoch: offer.kernelEpoch, hostEpoch: 'host-preview-loss',
          sequence: ++sequence, ...message,
        });
        port.onmessage = (event) => {
          const message = event.data;
          if (message.type === 'kernel/open') send({ type: 'controller/accepted',
            requestId: message.requestId, grantId: message.grantId });
          else if (message.type === 'kernel/commit') {
            sequence += 1;
            send({ type: 'controller/committed', requestId: message.requestId,
              grantId: message.grantId });
          }
        };
        port.start();
        send({ type: 'controller/ready', capabilities: ['semantic.dispatch'] });
      },
    };
    let matches = 0;
    const priorClients = (globalThis as any).clients;
    (globalThis as any).clients = {
      matchAll: async () => (++matches === 1 ? [lost] : [good]),
    };
    try {
      const routes = createLivePreviewRoutes({
        kv: { get: async () => enabledRecord(), set: async () => {}, delete: async () => {} },
        optionsUi: (sender: unknown) => sender === surface,
        kernelIdentity: identity, offscreenUrl,
        featureHost: { runtime: { runWithLease: async (_scope: string,
          operation: () => Promise<any>) => operation() } },
      });
      await expect(routes['contributor/status']({
        type: 'contributor/status',
      }, {})).resolves.toMatchObject({
        ok: false, code: 'semantic-demand-admission-denied', outcomeKnown: true,
      });
      expect(matches).toBe(0);
      await expect(routes['contributor/status']({
        type: 'contributor/status',
      }, surface)).resolves.toMatchObject({ ok: true, status: { enabled: true } });
      expect(matches).toBe(2);
      matches = 0;
      await expect(routes['contributor/enable']({
        type: 'contributor/enable',
      }, surface)).resolves.toMatchObject({
        ok: false, code: 'semantic-demand-channel-lost', outcomeKnown: false,
      });
      expect(matches).toBe(1);
    } finally {
      (globalThis as any).clients = priorClients;
    }
  });
});
