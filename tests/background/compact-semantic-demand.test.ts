import { describe, expect, test } from 'bun:test';
import { bindControllerChannel } from '../../extension/offscreen/controller-shell.js';
import { callSemanticDemandOnce } from '../../extension/background/kernel-controller-call.js';
import { CONTROLLER_BUILD_DIGEST } from '../../extension/shared/build-config.js';

const IDENTITY = Object.freeze({
  schema: 1 as const, buildId: `0.7.3:${CONTROLLER_BUILD_DIGEST}`,
  bootId: 'boot-compact-semantic', kernelEpoch: 'kernel-compact-semantic',
});
const payload = (route = 'agent/send', message: Record<string, unknown> = {}) => ({
  protocol: 1, route, message: { type: route, ...message },
});
const authority = (route = 'agent/send', replayClass: 'A' | 'E' = 'E',
  senderClass = 'sidepanel') => ({
  ownerId: 'peerd-authority-kernel', sessionId: null, instanceId: null, origin: null,
  target: `semantic:${route}:${senderClass}`, replayClass,
});
const bindHost = (
  invoke: (capability: string, value: unknown, options: any) => Promise<any> | any,
) => ({
  postMessage: (offer: any, ports: MessagePort[]) => bindControllerChannel({
    port: ports[0], channelId: offer.channelId, buildDigest: offer.buildDigest,
    kernelEpoch: offer.kernelEpoch, kernelIdentity: offer.kernelIdentity,
    hostEpoch: 'host-production-demand', offeredCaps: offer.capabilities,
    supportedCaps: ['semantic.dispatch'], loadController: async () => ({ call: invoke }),
  }),
});

describe('live native-kernel semantic demand', () => {
  test('binds reverse authority and unwraps the semantic result', async () => {
    const kernelCalls: any[] = [];
    const target = bindHost(async (_capability, _value, options) => {
      const body = await options.kernelCall('semantic.toolbox.get-body', { name: 'known' });
      return { ok: true, outcomeKnown: true,
        semanticResult: { ok: true, body: body.value } };
    });
    await expect(callSemanticDemandOnce({
      target, identity: IDENTITY, payload: payload('toolbox/read'),
      authority: authority('toolbox/read', 'A', 'first-party'),
      kernelCall: async (operation, value, context) => {
        kernelCalls.push({ operation, value, target: context.authority.target });
        return { ok: true, outcomeKnown: true, value: 'export default 1' };
      }, timeoutMs: 1_000,
    })).resolves.toEqual({
      ok: true, body: 'export default 1', outcomeKnown: true, phase: 'settled',
    });
    expect(kernelCalls).toEqual([{
      operation: 'semantic.toolbox.get-body', value: { name: 'known' },
      target: 'semantic:toolbox/read:first-party',
    }]);
  });

  test('rejects oversize before offering controller custody', async () => {
    let offers = 0;
    await expect(callSemanticDemandOnce({
      target: { postMessage: () => { offers += 1; } }, identity: IDENTITY,
      payload: payload('agent/send', { padding: 'x'.repeat(300_000) }),
      authority: authority(), kernelCall: async () => ({}), timeoutMs: 1_000,
    })).resolves.toMatchObject({
      ok: false, code: 'semantic-demand-startup-failed', outcomeKnown: true,
    });
    expect(offers).toBe(0);
  });

  test('pre-commit abort is known-safe and never emits commit', async () => {
    const controller = new AbortController();
    const messages: string[] = [];
    const result = callSemanticDemandOnce({
      target: { postMessage: (offer: any, ports: MessagePort[]) => {
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
      } },
      identity: IDENTITY, payload: payload(), authority: authority(),
      kernelCall: async () => ({ ok: false, outcomeKnown: true }),
      timeoutMs: 1_000, signal: controller.signal,
    });
    await expect(result).resolves.toMatchObject({
      ok: false, code: 'semantic-demand-aborted', outcomeKnown: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages).not.toContain('kernel/commit');
  });

  test('channel loss after commit preserves unknown Class-E custody', async () => {
    const result = callSemanticDemandOnce({
      target: { postMessage: (offer: any, ports: MessagePort[]) => {
        const port = ports[0];
        let sequence = 0;
        const post = (message: any) => port.postMessage({
          protocol: 2, channelId: offer.channelId, buildDigest: offer.buildDigest,
          kernelEpoch: offer.kernelEpoch, hostEpoch: 'host-postcommit-loss',
          sequence: ++sequence, ...message,
        });
        port.onmessage = (event) => {
          const message = event.data;
          if (message.type === 'kernel/open') post({ type: 'controller/accepted',
            requestId: message.requestId, grantId: message.grantId });
          else if (message.type === 'kernel/commit') {
            sequence += 1;
            post({ type: 'controller/committed', requestId: message.requestId,
              grantId: message.grantId });
          }
        };
        port.start();
        post({ type: 'controller/ready', capabilities: ['semantic.dispatch'] });
      } },
      identity: IDENTITY, payload: payload(), authority: authority(),
      kernelCall: async () => ({ ok: false, outcomeKnown: true }), timeoutMs: 1_000,
    });
    await expect(result).resolves.toMatchObject({
      ok: false, code: 'semantic-demand-channel-lost', outcomeKnown: false,
    });
  });

  test('forged non-semantic reverse operations never reach kernel authority', async () => {
    let handled = 0;
    let denied: any = null;
    const target = { postMessage: (offer: any, ports: MessagePort[]) => {
      const port = ports[0];
      let sequence = 0;
      let requestId = '';
      let grantId = '';
      const send = (message: any) => port.postMessage({
        protocol: 2, channelId: offer.channelId, buildDigest: offer.buildDigest,
        kernelEpoch: offer.kernelEpoch, hostEpoch: 'host-forged-semantic',
        sequence: ++sequence, ...message,
      });
      port.onmessage = (event) => {
        const message = event.data;
        if (message.type === 'kernel/open') {
          requestId = message.requestId; grantId = message.grantId;
          send({ type: 'controller/accepted', requestId, grantId });
        } else if (message.type === 'kernel/commit') {
          send({ type: 'controller/committed', requestId, grantId });
          send({ type: 'controller/kernel-call', requestId, grantId,
            rpcId: 'forged-rpc', operation: 'turn.vault.export-secret', payload: {} });
        } else if (message.type === 'kernel/kernel-result') {
          denied = message.result;
          send({ type: 'controller/settled', requestId, grantId,
            result: { ok: true, outcomeKnown: true, semanticResult: { ok: true } } });
        }
      };
      port.start();
      send({ type: 'controller/ready', capabilities: ['semantic.dispatch'] });
    } };
    await expect(callSemanticDemandOnce({
      target, identity: IDENTITY, payload: payload(), authority: authority(),
      kernelCall: async () => { handled += 1; return { ok: true, outcomeKnown: true }; },
      timeoutMs: 1_000,
    })).resolves.toMatchObject({ ok: true, outcomeKnown: true });
    expect(denied).toEqual({
      ok: false, code: 'kernel-operation-denied', outcomeKnown: true,
    });
    expect(handled).toBe(0);
  });
});
