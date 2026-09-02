import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENSION_DIR } from '../../packaging/lib.ts';
import { createServiceWorkerChannels } from '../../extension/offscreen/supervisor-channels.js';
import { backgroundScriptUrl } from '../../extension/offscreen/sender-checks.js';
import {
  FEATURE_LEASE_CLIENT_PROBE,
  FEATURE_LEASE_CLIENT_PROOF,
  FEATURE_LEASE_HOST_PROTOCOL,
} from '../../extension/shared/feature-lease-protocol.js';

const source = (path: string) => readFileSync(join(EXTENSION_DIR, path), 'utf8');

describe('offscreen production feature-lease wiring', () => {
  test('proves exact lease ownership before a WindowClient receives a private capability', async () => {
    const lease = { scope: 'controller', leaseId: 'exact-client', hostEpoch: 'exact-host' };
    const channels = createServiceWorkerChannels({
      getFeatureLeaseHost: () => ({
        isActive: () => true,
        ownsLease: (scope: string, candidate: unknown) =>
          scope === 'controller' && candidate === lease,
      }),
      loadControllerBootstrap: async () => ({}),
    });
    const channel = new MessageChannel();
    const proof = new Promise<any>((resolve) => {
      channel.port1.onmessage = (event) => resolve(event.data);
      channel.port1.start();
    });
    channels.onMessage({
      isTrusted: true,
      source: { scriptURL: backgroundScriptUrl },
      data: {
        type: FEATURE_LEASE_CLIENT_PROBE,
        protocol: FEATURE_LEASE_HOST_PROTOCOL,
        probeId: 'feature-client-probe',
        lease,
      },
      ports: [channel.port2],
    } as unknown as MessageEvent);
    await expect(proof).resolves.toEqual({
      type: FEATURE_LEASE_CLIENT_PROOF,
      protocol: FEATURE_LEASE_HOST_PROTOCOL,
      probeId: 'feature-client-probe',
      hostEpoch: 'exact-host',
      owned: true,
    });
  });

  test('the offscreen shell has no unconditional generic keepalive', () => {
    const shell = source('offscreen/offscreen.js');
    const channels = source('offscreen/supervisor-channels.js');
    expect(shell).not.toContain("'sw-keepalive'");
    expect(shell).not.toContain("type: 'heartbeat'");
    expect(shell).toContain('FEATURE_LEASE_KEEPALIVE_PORT');
    expect(shell).not.toContain("message.startsWith('feature-lease/host-')");
    expect(shell).toContain('void ensureFeatureLeaseHost()');
    expect(shell).toContain("claimLease('dweb'");
    expect(channels).toContain("ownsLease?.('controller', lease) === true");
    expect(shell).toContain("claimLease('dom-host'");
    expect(channels).toContain("ownsLease?.('media-host', offer.lease) === true");
  });

  test('a revoked controller claim cannot escape a delayed bootstrap load', async () => {
    const oldLease = { scope: 'controller', leaseId: 'controller-old' };
    const nextLease = { scope: 'controller', leaseId: 'controller-next' };
    let current: unknown = oldLease;
    let loads = 0;
    let accepts = 0;
    let closes = 0;
    let release!: (module: any) => void;
    const loading = new Promise<any>((resolve) => { release = resolve; });
    const channels = createServiceWorkerChannels({
      getFeatureLeaseHost: () => ({
        isActive: () => current !== null,
        ownsLease: (scope: string, candidate: unknown) =>
          scope === 'controller' && candidate === current,
      }),
      loadControllerBootstrap: async () => {
        loads += 1;
        return loading;
      },
    });
    channels.onMessage({
      data: { type: 'peerd/controller-channel', lease: oldLease },
      ports: [{ close: () => { closes += 1; } }],
    } as unknown as MessageEvent);
    for (let attempt = 0; attempt < 5 && loads === 0; attempt += 1) await Promise.resolve();
    expect(loads).toBe(1);
    current = nextLease;
    release({ acceptControllerOffer: () => { accepts += 1; } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect({ accepts, closes }).toEqual({ accepts: 0, closes: 1 });
  });

  test('actor offers require their exact generation across a delayed host load', async () => {
    const oldLease = { scope: 'controller', leaseId: 'actor-old' };
    const nextLease = { scope: 'controller', leaseId: 'actor-next' };
    let current: unknown = nextLease;
    let loads = 0;
    let binds = 0;
    let closes = 0;
    let release!: (module: any) => void;
    const loading = new Promise<any>((resolve) => { release = resolve; });
    const channels = createServiceWorkerChannels({
      getFeatureLeaseHost: () => ({
        isActive: () => current !== null,
        ownsLease: (scope: string, candidate: unknown) =>
          scope === 'controller' && candidate === current,
      }),
      loadControllerBootstrap: async () => ({}),
      loadActorHost: async () => {
        loads += 1;
        return loading;
      },
    });
    const offer = (lease: unknown) => ({
      isTrusted: true,
      source: { scriptURL: backgroundScriptUrl },
      data: { type: 'peerd/actor-channel', protocol: 1, channelId: 'actor-channel-one', lease },
      ports: [{
        close: () => { closes += 1; },
        addEventListener: () => {},
      }],
    } as unknown as MessageEvent);

    channels.onMessage(offer(oldLease));
    await Promise.resolve();
    expect({ loads, binds, closes }).toEqual({ loads: 0, binds: 0, closes: 1 });

    current = oldLease;
    channels.onMessage(offer(oldLease));
    for (let attempt = 0; attempt < 5 && loads === 0; attempt += 1) await Promise.resolve();
    expect(loads).toBe(1);
    current = nextLease;
    release([
      { bindActorChannel: () => { binds += 1; } },
      { runActor: () => {}, abortActor: () => {} },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect({ binds, closes }).toEqual({ binds: 0, closes: 2 });
  });

  test('frozen controller and actor loads close cleanly and recover without late binding', async () => {
    const lease = { scope: 'controller', leaseId: 'controller-live' };
    let controllerLoads = 0;
    let actorLoads = 0;
    let controllerAccepts = 0;
    let actorBinds = 0;
    let resolveController!: (module: any) => void;
    let resolveActor!: (module: any) => void;
    const controllerModule = new Promise<any>((resolve) => { resolveController = resolve; });
    const actorModule = new Promise<any>((resolve) => { resolveActor = resolve; });
    const channels = createServiceWorkerChannels({
      getFeatureLeaseHost: () => ({
        isActive: () => true,
        ownsLease: (scope: string, candidate: unknown) =>
          scope === 'controller' && candidate === lease,
      }),
      moduleLoadTimeoutMs: 2,
      loadControllerBootstrap: () => {
        controllerLoads += 1;
        return controllerModule;
      },
      loadActorHost: () => {
        actorLoads += 1;
        return actorModule;
      },
    });
    const port = () => {
      const state = { closes: 0, messages: [] as any[] };
      return {
        state,
        value: {
          close: () => { state.closes += 1; },
          postMessage: (message: any) => { state.messages.push(message); },
          addEventListener: () => {},
        },
      };
    };
    const controllerOffer = (channelPort: any, channelId: string) => ({
      data: {
        type: 'peerd/controller-channel', protocol: 2, channelId,
        buildDigest: 'digest', kernelEpoch: 'kernel', lease,
      },
      ports: [channelPort],
    } as unknown as MessageEvent);
    const actorOffer = (channelPort: any, channelId: string) => ({
      isTrusted: true,
      source: { scriptURL: backgroundScriptUrl },
      data: { type: 'peerd/actor-channel', protocol: 1, channelId, lease },
      ports: [channelPort],
    } as unknown as MessageEvent);

    const frozenController = port();
    const frozenActor = port();
    channels.onMessage(controllerOffer(frozenController.value, 'controller-frozen'));
    channels.onMessage(actorOffer(frozenActor.value, 'actor-frozen'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(frozenController.state.messages).toEqual([expect.objectContaining({
      type: 'controller/unavailable', code: 'controller-host-load-failed',
    })]);
    expect(frozenController.state.closes).toBe(1);
    expect(frozenActor.state.closes).toBe(1);

    resolveController({ acceptControllerOffer: () => { controllerAccepts += 1; } });
    resolveActor([
      { bindActorChannel: () => { actorBinds += 1; } },
      { runActor: () => {}, abortActor: () => {} },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect({ controllerAccepts, actorBinds }).toEqual({ controllerAccepts: 0, actorBinds: 0 });

    const recoveredController = port();
    const recoveredActor = port();
    channels.onMessage(controllerOffer(recoveredController.value, 'controller-recovered'));
    channels.onMessage(actorOffer(recoveredActor.value, 'actor-recovered'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect({ controllerLoads, actorLoads }).toEqual({ controllerLoads: 1, actorLoads: 1 });
    expect({ controllerAccepts, actorBinds }).toEqual({ controllerAccepts: 1, actorBinds: 1 });
    expect({
      controllerCloses: recoveredController.state.closes,
      actorCloses: recoveredActor.state.closes,
    }).toEqual({ controllerCloses: 0, actorCloses: 0 });
  });

  test('vault authority checks exact custody again before Worker creation', () => {
    const oldLease = { scope: 'vault-authority', leaseId: 'vault-old' };
    const nextLease = { scope: 'vault-authority', leaseId: 'vault-next' };
    let current: unknown = nextLease;
    let checks = 0;
    let workers = 0;
    let closes = 0;
    const channels = createServiceWorkerChannels({
      getFeatureLeaseHost: () => ({
        isActive: () => current !== null,
        ownsLease: (scope: string, candidate: unknown) => {
          checks += 1;
          const owned = scope === 'vault-authority'
            && (candidate as any)?.leaseId === (current as any)?.leaseId;
          if (owned && checks === 1) current = nextLease;
          return owned;
        },
      }),
      loadControllerBootstrap: async () => ({}),
      createVaultAuthorityWorker: () => {
        workers += 1;
        return {} as Worker;
      },
    });
    const offer = (lease: unknown) => ({
      isTrusted: true,
      source: { scriptURL: backgroundScriptUrl },
      data: {
        type: 'peerd/vault-authority-channel', protocol: 1,
        channelId: 'vault-channel-one', lease,
      },
      ports: [{ close: () => { closes += 1; }, postMessage: () => {} }],
    } as unknown as MessageEvent);

    channels.onMessage(offer(oldLease));
    expect({ workers, closes }).toEqual({ workers: 0, closes: 1 });

    current = oldLease;
    checks = 0;
    channels.onMessage(offer(oldLease));
    expect(checks).toBe(2);
    expect({ workers, closes }).toEqual({ workers: 0, closes: 2 });
  });

  test('the production kernel adapter imports only the tiny shared protocol', () => {
    const runtime = source('background/feature-lease-runtime.js');
    expect(runtime).toContain("../shared/feature-lease-protocol.js");
    expect(runtime).not.toContain("../offscreen/feature-lease-host.js");
    expect(source('shared/feature-lease-protocol.js')).not.toMatch(/\b(?:browser|chrome)\./);
  });

  test('voice media is accepted only from human UI and teardown revokes the durable hold', () => {
    const custody = source('background/kernel-voice-custody.js');
    const provenance = source('background/vault-kernel-core.js');
    expect(provenance).toContain("add(['voice/init', 'voice/listen', 'voice/stop'");
    expect(provenance).toContain('voiceUi);');
    expect(custody).toContain('VOICE_CHANNEL_OFFER');
    expect(custody).toContain("revoke('media-host', 'feature-disabled')");
  });

  test('loading the dweb host cannot open custody or network without a lease', () => {
    const dweb = source('offscreen/dweb-base.js');
    expect(dweb).not.toMatch(/^connectCustodyPort\(\);$/m);
    expect(dweb).toContain('let custodyIntended = false');
    expect(dweb).toContain('export const startDwebFeatureLease');
    expect(dweb).toContain('export const adoptDwebFeatureLease');
    expect(dweb).toContain('export const stopDwebFeatureLease');
    expect(dweb).toContain("type: 'dweb/base-host/generation'");
    expect(dweb).toContain('reseedNotifier.notify({');
    expect(dweb).toContain('reseedNotifier.cancel();');
    expect(dweb).not.toContain('reseedReady');
    expect(dweb).not.toContain('awaitReseedPass');
    expect(dweb).toContain('activeFeatureHostEpoch = null;');
    expect(dweb).toContain('runDwebReseedPublication({');
    expect(dweb).toContain('latestReseedAttempts.get(msg.appId) === reseedAttemptId');
    expect(dweb).toContain('contentOwnership.transfer(');
    expect(dweb).toContain('msg.expectedHostEpoch !== activeFeatureHostEpoch');
    expect(dweb).toContain('msg.expectedMeshGeneration !== meshGeneration');
    expect(dweb).toContain('clients: new Map()');
    expect(dweb).toContain("op === 'join-ack'");
    expect(dweb).toContain("error: 'dweb-host-generation-changed'");
  });

  test('App host-generation events accept only the exact offscreen sender', () => {
    const appTab = source('engine-tabs/app-tab/app-tab.js');
    expect(appTab).toContain("browser.runtime.getURL('offscreen/offscreen.html')");
    expect(appTab).toContain('sender?.url !== offscreenUrl');
    expect(appTab).toContain("msg?.type === 'dweb/base-host/generation'");
  });

  test('scope teardown has explicit controller, job, repository, model, media, and dweb fences', () => {
    const shell = source('offscreen/offscreen.js');
    expect(shell).toContain('releaseControllerHost?.()');
    expect(shell).toContain('abortRepositoryHostCalls()');
    expect(shell).toContain('abortAllJobs()');
    expect(shell).toContain('teardownLocalModel()');
    expect(shell).toContain('stopVoiceHost()');
    expect(shell).toContain('stopDwebFeatureLease()');
  });
});
