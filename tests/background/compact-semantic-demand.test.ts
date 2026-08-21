import { describe, expect, test } from 'bun:test';
import { bindControllerChannel } from '../../extension/offscreen/controller-shell.js';
import {
  callSemanticDemandOnce,
  createKernelSemanticDemand,
} from '../../extension/background/kernel-semantic-demand.js';
import { CONTROLLER_BUILD_DIGEST } from '../../extension/shared/build-config.js';

const IDENTITY = Object.freeze({
  schema: 1 as const,
  buildId: `0.7.3:${CONTROLLER_BUILD_DIGEST}`,
  bootId: 'boot-compact-semantic',
  kernelEpoch: 'kernel-compact-semantic',
});
const payload = (route = 'agent/send', message: Record<string, unknown> = {}) => ({
  protocol: 1,
  route,
  message: { type: route, ...message },
});
const authority = (route = 'agent/send', replayClass: 'A' | 'E' = 'E',
  senderClass = 'sidepanel') => ({
  ownerId: 'peerd-authority-kernel',
  sessionId: null,
  instanceId: null,
  origin: null,
  target: `semantic:${route}:${senderClass}`,
  replayClass,
});

const bindHost = (
  invoke: (capability: string, value: unknown, options: any) => Promise<any> | any,
) => ({
  postMessage: (offer: any, ports: MessagePort[]) => bindControllerChannel({
    port: ports[0],
    channelId: offer.channelId,
    buildDigest: offer.buildDigest,
    kernelEpoch: offer.kernelEpoch,
    kernelIdentity: offer.kernelIdentity,
    hostEpoch: 'host-production-demand',
    offeredCaps: offer.capabilities,
    supportedCaps: ['semantic.dispatch'],
    loadController: async () => ({ call: invoke }),
  }),
});

describe('live native-kernel semantic demand', () => {
  test('one-shot transport binds reverse authority and unwraps the semantic result', async () => {
    const kernelCalls: any[] = [];
    const target = bindHost(async (_capability, _value, options) => {
      const body = await options.kernelCall('semantic.toolbox.get-body', { name: 'known' });
      return {
        ok: true,
        outcomeKnown: true,
        semanticResult: { ok: true, body: body.value },
      };
    });
    await expect(callSemanticDemandOnce({
      target,
      identity: IDENTITY,
      payload: payload('toolbox/read'),
      authority: authority('toolbox/read', 'A', 'first-party'),
      kernelCall: async (operation, value, context) => {
        kernelCalls.push({ operation, value, target: context.authority.target });
        return { ok: true, outcomeKnown: true, value: 'export default 1' };
      },
      timeoutMs: 1_000,
    })).resolves.toEqual({
      ok: true,
      body: 'export default 1',
      outcomeKnown: true,
      phase: 'settled',
    });
    expect(kernelCalls).toEqual([{
      operation: 'semantic.toolbox.get-body',
      value: { name: 'known' },
      target: 'semantic:toolbox/read:first-party',
    }]);
  });

  test('admission is cold, Class A replays once, and Class E never replays', async () => {
    const surface = { surface: 'options' };
    const forged = { surface: 'forged' };
    const calls: Array<{ route: string, replayClass: string, timeoutMs: number }> = [];
    const gateway = createKernelSemanticDemand({
      routes: {
        'provider/status': {
          senderClass: 'first-party', replayClass: 'A',
          acceptsSender: (sender) => sender === surface,
        },
        'contacts/set': {
          senderClass: 'first-party', replayClass: 'E',
          acceptsSender: (sender) => sender === surface,
        },
      },
      clientOptions: {
        callDemand: async (value: any, options: any) => {
          calls.push({ route: value.route, replayClass: options.authority.replayClass,
            timeoutMs: options.timeoutMs });
          if (value.route === 'provider/status' && calls.length === 2) {
            return { ok: true, providers: [] };
          }
          return { ok: false, code: 'semantic-demand-channel-lost', outcomeKnown: false };
        },
      },
    });
    await expect(gateway.dispatch('provider/status', {
      type: 'provider/status',
    }, forged)).resolves.toMatchObject({
      ok: false, code: 'semantic-demand-admission-denied', outcomeKnown: true,
    });
    expect(calls).toEqual([]);
    await expect(gateway.dispatch('provider/status', {
      type: 'provider/status',
    }, surface)).resolves.toEqual({ ok: true, providers: [] });
    await expect(gateway.dispatch('contacts/set', {
      type: 'contacts/set', did: 'did:key:zpeer',
    }, surface)).resolves.toMatchObject({
      ok: false, code: 'semantic-demand-channel-lost', outcomeKnown: false,
    });
    expect(calls.map(({ route, replayClass }) => ({ route, replayClass }))).toEqual([
      { route: 'provider/status', replayClass: 'A' },
      { route: 'provider/status', replayClass: 'A' },
      { route: 'contacts/set', replayClass: 'E' },
    ]);
  });

  test('Class A retry consumes one outer deadline instead of restarting it', async () => {
    const surface = { surface: 'options' };
    const budgets: number[] = [];
    let clock = 1_000;
    const gateway = createKernelSemanticDemand({
      routes: {
        'provider/status': {
          senderClass: 'first-party', replayClass: 'A',
          acceptsSender: (sender) => sender === surface,
        },
      },
      clientOptions: {
        callDemand: async (_value: any, options: any) => {
          budgets.push(options.timeoutMs);
          clock += 7_000;
          return budgets.length === 1
            ? { ok: false, code: 'semantic-demand-channel-lost', outcomeKnown: false }
            : { ok: true, providers: [] };
        },
      },
      timeoutMs: 12_000,
      now: () => clock,
    });
    await expect(gateway.dispatch('provider/status', {
      type: 'provider/status',
    }, surface)).resolves.toEqual({ ok: true, providers: [] });
    expect(budgets).toEqual([12_000, 5_000]);
  });

  test('Chrome requires one exact host and rejects oversize before opening custody', async () => {
    const surface = { surface: 'sidepanel' };
    const offscreenUrl = 'chrome-extension://id/offscreen/offscreen.html';
    let offers = 0;
    const target = {
      url: offscreenUrl,
      ...bindHost(async (_capability, value) => ({
        ok: true,
        outcomeKnown: true,
        semanticResult: { ok: true, route: (value as any).route },
      })),
    };
    const gateway = (windows: any[]) => createKernelSemanticDemand({
      routes: {
        'agent/send': {
          senderClass: 'sidepanel', replayClass: 'E',
          acceptsSender: (sender) => sender === surface,
        },
      },
      clientOptions: {
        firefoxDirect: false,
        kernelIdentity: IDENTITY,
        offscreenUrl,
        listWindowClients: async () => windows.map((window) => ({
          ...window,
          postMessage: (...args: any[]) => {
            offers += 1;
            return window.postMessage(...args);
          },
        })),
        withControllerLease: async (operation: () => Promise<any>) => operation(),
      },
    });
    await expect(gateway([target]).dispatch('agent/send', {
      type: 'agent/send', text: 'hello',
    }, surface)).resolves.toMatchObject({
      ok: true, route: 'agent/send', outcomeKnown: true,
    });
    expect(offers).toBe(1);
    await expect(gateway([target, target]).dispatch('agent/send', {
      type: 'agent/send', text: 'hello',
    }, surface)).resolves.toMatchObject({
      ok: false, code: 'semantic-demand-startup-failed', outcomeKnown: true,
    });
    expect(offers).toBe(1);
    await expect(gateway([target]).dispatch('agent/send', {
      type: 'agent/send', padding: 'x'.repeat(300_000),
    }, surface)).resolves.toMatchObject({
      ok: false, code: 'semantic-demand-startup-failed', outcomeKnown: true,
    });
    expect(offers).toBe(1);
  });

  test('Firefox uses the direct one-shot lane with the same Class A/E policy', async () => {
    const surface = { surface: 'home' };
    const calls: string[] = [];
    let leases = 0;
    const gateway = createKernelSemanticDemand({
      routes: {
        'contacts/list': {
          senderClass: 'first-party', replayClass: 'A',
          acceptsSender: (sender) => sender === surface,
        },
        'contacts/set': {
          senderClass: 'first-party', replayClass: 'E',
          acceptsSender: (sender) => sender === surface,
        },
      },
      clientOptions: {
        firefoxDirect: true,
        withControllerLease: async () => { leases += 1; },
        callDirect: async (value: any, options: any) => {
          calls.push(`${value.route}:${options.authority.replayClass}`);
          if (value.route === 'contacts/list' && calls.length === 2) {
            return { ok: true, contacts: [] };
          }
          return { ok: false, code: 'controller-firefox-semantic-lifetime-lost',
            outcomeKnown: value.route === 'contacts/list' };
        },
      },
    });
    await expect(gateway.dispatch('contacts/list', {
      type: 'contacts/list',
    }, surface)).resolves.toEqual({ ok: true, contacts: [] });
    await expect(gateway.dispatch('contacts/set', {
      type: 'contacts/set', did: 'did:key:zpeer',
    }, surface)).resolves.toMatchObject({
      ok: false, code: 'controller-firefox-semantic-lifetime-lost', outcomeKnown: false,
    });
    expect(calls).toEqual(['contacts/list:A', 'contacts/list:A', 'contacts/set:E']);
    expect(leases).toBe(0);
  });

  test('pre-commit abort is known-safe and never emits commit', async () => {
    const controller = new AbortController();
    const messages: string[] = [];
    const result = callSemanticDemandOnce({
      target: {
        postMessage: (offer: any, ports: MessagePort[]) => {
          const port = ports[0];
          port.onmessage = (event) => {
            messages.push(event.data.type);
            if (event.data.type === 'kernel/open') controller.abort();
          };
          port.start();
          port.postMessage({ protocol: 2, channelId: offer.channelId,
            buildDigest: offer.buildDigest, kernelEpoch: offer.kernelEpoch,
            hostEpoch: 'host-precommit-abort', sequence: 1,
            type: 'controller/ready', capabilities: ['semantic.dispatch'] });
        },
      },
      identity: IDENTITY,
      payload: payload(),
      authority: authority(),
      kernelCall: async () => ({ ok: false, outcomeKnown: true }),
      timeoutMs: 1_000,
      signal: controller.signal,
    });
    await expect(result).resolves.toMatchObject({
      ok: false, code: 'semantic-demand-aborted', outcomeKnown: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages).not.toContain('kernel/commit');
  });

  test('channel loss after commit preserves unknown Class-E custody', async () => {
    const result = callSemanticDemandOnce({
      target: {
        postMessage: (offer: any, ports: MessagePort[]) => {
          const port = ports[0];
          let sequence = 0;
          const post = (message: any) => port.postMessage({
            protocol: 2, channelId: offer.channelId, buildDigest: offer.buildDigest,
            kernelEpoch: offer.kernelEpoch, hostEpoch: 'host-postcommit-loss',
            sequence: ++sequence, ...message,
          });
          port.onmessage = (event) => {
            const message = event.data;
            if (message.type === 'kernel/open') {
              post({ type: 'controller/accepted', requestId: message.requestId,
                grantId: message.grantId });
            } else if (message.type === 'kernel/commit') {
              sequence += 1;
              post({ type: 'controller/committed', requestId: message.requestId,
                grantId: message.grantId });
            }
          };
          port.start();
          post({ type: 'controller/ready', capabilities: ['semantic.dispatch'] });
        },
      },
      identity: IDENTITY,
      payload: payload(),
      authority: authority(),
      kernelCall: async () => ({ ok: false, outcomeKnown: true }),
      timeoutMs: 1_000,
    });
    await expect(result).resolves.toMatchObject({
      ok: false, code: 'semantic-demand-channel-lost', outcomeKnown: false,
    });
  });
});
