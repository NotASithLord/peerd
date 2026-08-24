import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENSION_DIR } from '../../packaging/lib.ts';
import { createVault } from '../../extension/peerd-egress/vault/vault.js';
import {
  makeUiForwarder, makeVoiceControlPlane,
} from '../../extension/background/service-worker-control-plane.js';
import { createServiceWorkerChannels } from '../../extension/offscreen/supervisor-channels.js';
import { backgroundScriptUrl } from '../../extension/offscreen/sender-checks.js';

const source = (path: string) => readFileSync(join(EXTENSION_DIR, path), 'utf8');

const installVoiceRelay = ({
  acquire,
  revoke,
  sendHost,
  hostTimeoutMs,
}: {
  acquire: () => Promise<void>;
  revoke: () => Promise<void>;
  sendHost: (message: any) => Promise<any>;
  hostTimeoutMs?: number;
}) => {
  let active = false;
  const calls: string[] = [];
  const featureLeases = {
    snapshot: () => ({
      leases: { 'media-host': { status: active ? 'active' : 'idle' } },
    }),
    revoke: async () => {
      calls.push('revoke');
      await revoke();
      active = false;
    },
  };
  const acquireFeatureLease = async () => {
    calls.push('acquire');
    await acquire();
    active = true;
  };
  const browser = {
    runtime: {
      sendMessage: async (message: any) => {
        calls.push(`host:${message.type}`);
        return sendHost(message);
      },
    },
  };
  const api = makeVoiceControlPlane({
    browser,
    featureLeases,
    acquire: acquireFeatureLease,
    isSidepanelSender: () => true,
    isOptionsSender: () => false,
    hostTimeoutMs,
  });
  const dispatch = (message: any) => new Promise<any>((resolve) => {
    expect(api.onMessage(message, { url: 'sidepanel' }, resolve)).toBe(true);
  });
  return {
    calls,
    dispatch,
    disableVoice: () => api.teardown(),
    active: () => active,
  };
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
};

describe('offscreen production feature-lease wiring', () => {
  test('voice events accept only their exact owning contexts', () => {
    const delivered: string[] = [];
    const forward = makeUiForwarder({
      isOffscreenSender: (sender: any) => sender?.owner === 'offscreen',
      isMicSender: (sender: any) => sender?.owner === 'mic',
      deliver: (message: any) => { delivered.push(message.type); },
    });
    for (const type of ['voice/chunk', 'voice/auto-stop', 'voice/error']) {
      forward({ type }, { owner: 'sibling' });
      forward({ type }, { owner: 'offscreen' });
    }
    forward({ type: 'voice/permission-result' }, { owner: 'offscreen' });
    forward({ type: 'voice/permission-result' }, { owner: 'mic' });
    expect(delivered).toEqual([
      'voice/chunk', 'voice/auto-stop', 'voice/error', 'voice/permission-result',
    ]);
  });

  test('the offscreen shell has no unconditional generic keepalive', () => {
    const shell = source('offscreen/offscreen.js');
    expect(shell).not.toContain("'sw-keepalive'");
    expect(shell).not.toContain("type: 'heartbeat'");
    expect(shell).toContain('FEATURE_LEASE_KEEPALIVE_PORT');
    expect(shell).toContain("feature-lease/host-");
    expect(shell).toContain("claimLease('dweb'");
    expect(source('offscreen/supervisor-channels.js'))
      .toContain("ownsLease?.('controller', lease) === true");
    expect(shell).toContain("claimLease('dom-host'");
    expect(shell).toContain("claimLease('media-host'");
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

  test('the live worker owns lease authority and has no unconditional offscreen boot', () => {
    const worker = source('background/service-worker.js');
    const keepalive = source('background/feature-lease-keepalive.js');
    const control = source('background/service-worker-control-plane.js');
    expect(worker).toContain('createFeatureLeaseControlPlane({');
    expect(control).toContain('createProductionFeatureLeaseRuntime({');
    expect(worker).toContain('FEATURE_LEASE_KEEPALIVE_PORT');
    expect(worker).toContain('attachFeatureLeaseKeepalive({');
    expect(keepalive).toContain("type: 'feature-lease/heartbeat-ack'");
    expect(worker).toContain('featureLeases.resume({ dwebEnabled: resumeDwebEnabled })');
    expect(worker.indexOf('await settingsReady;'))
      .toBeLessThan(worker.indexOf('featureLeases.resume({ dwebEnabled: resumeDwebEnabled })'));
    expect(keepalive).toContain('featureLeases.handleHostLoss(lostHostEpoch)');
    expect(keepalive).toContain("['starting', 'active', 'unknown'].includes(state?.status)");
    expect(keepalive.indexOf('if (!current) return;'))
      .toBeLessThan(keepalive.indexOf('authenticatedHostEpoch = message.hostEpoch;'));
    expect(worker).toContain("featureLeases.runTransition('initialize'");
    expect(worker).toContain("featureLeases.runTransition('unlock'");
    expect(worker).toContain('await featureLeases.lock()');
    expect(worker).not.toContain("'sw-keepalive'");
    expect(worker).not.toContain('keepalivePorts');
    expect(worker).not.toMatch(/void ensureOffscreen\(\);\s*\/\/ Best-effort boot/i);
  });

  test('every rich Chrome feature enters through a named bounded or durable lease', () => {
    const worker = source('background/service-worker.js');
    expect(worker).toContain('withControllerLease: (/** @type {()=>any} */ operation) => withFeatureLease(');
    expect(worker).toContain('firefoxDirect: !offscreenAvailable');
    expect(worker).toContain('withDirectLifetime: (/** @type {()=>any} */ operation');
    expect(worker).toContain('withHost: (/** @type {(lease:any)=>Promise<any>} */ operation) => withFeatureLease(');
    expect(worker).toContain("const withHost = (operation) => withFeatureLease(\n  'model-host'");
    expect(worker).toContain("const acquireResidentHost = () => acquireFeatureLease(\n  'model-host'");
    expect(worker).not.toMatch(/withFeatureLease\(\s*'controller',[\s\S]{0,180}local-model\/host\//);
    expect(worker).toContain("runOnChannel: actorChannelClient ? (job, options) => withFeatureLease(");
    expect(worker).toContain("'dom-host', () => browser.runtime.sendMessage(message)");
    expect(worker).toContain("acquireFeatureLease('media-host'");
    expect(worker).toContain("acquireFeatureLease('dweb'");
    expect(worker).toContain("featureLeases.disable('dweb')");
  });

  test('voice media is accepted only from human UI and teardown revokes the durable hold', () => {
    const voice = source('background/service-worker-control-plane.js');
    expect(voice).toContain('deps.isSidepanelSender(sender)');
    expect(voice).toContain('deps.isOptionsSender(sender)');
    expect(voice).toContain('__peerdVoiceRelay: relayToken');
    expect(voice).toContain("msg.type === 'voice/teardown'");
    expect(voice).toContain("deps.featureLeases.revoke('media-host', 'feature-disabled')");
  });

  test('voice teardown queues behind a pending init and then revokes the activated media lease', async () => {
    const initGate = deferred();
    const relay = installVoiceRelay({
      acquire: () => initGate.promise,
      revoke: async () => {},
      sendHost: async () => ({ ok: true }),
    });

    const initializing = relay.dispatch({ type: 'voice/init', engine: 'moonshine' });
    const tearingDown = relay.dispatch({ type: 'voice/teardown' });
    await Promise.resolve();
    await Promise.resolve();
    expect(relay.calls).toEqual(['acquire']);

    initGate.resolve();
    expect(await initializing).toEqual({ ok: true });
    expect(await tearingDown).toEqual({ ok: true });
    expect(relay.calls).toEqual([
      'acquire', 'host:voice/init', 'host:voice/teardown', 'revoke',
    ]);
    expect(relay.active()).toBe(false);
  });

  test('a resolved failed voice start revokes its newly acquired durable media lease', async () => {
    const relay = installVoiceRelay({
      acquire: async () => {},
      revoke: async () => {},
      sendHost: async () => ({ ok: false, error: 'not-initialized' }),
    });

    expect(await relay.dispatch({ type: 'voice/listen', targetId: 'composer' })).toEqual({
      ok: false,
      error: 'not-initialized',
    });
    expect(relay.calls).toEqual(['acquire', 'host:voice/listen', 'revoke']);
    expect(relay.active()).toBe(false);
  });

  test('a stuck voice relay releases teardown and admits a clean restart', async () => {
    let starts = 0;
    const relay = installVoiceRelay({
      acquire: async () => {},
      revoke: async () => {},
      hostTimeoutMs: 5,
      sendHost: async (message) => {
        if (message.type === 'voice/init' && starts++ === 0) return new Promise(() => {});
        return { ok: true };
      },
    });

    const initializing = relay.dispatch({ type: 'voice/init', engine: 'moonshine' });
    const tearingDown = relay.dispatch({ type: 'voice/teardown' });
    expect(await initializing).toEqual({ ok: false, error: 'voice-host-timeout' });
    expect(await tearingDown).toEqual({ ok: true, inactive: true });
    expect(relay.active()).toBe(false);
    expect(await relay.dispatch({ type: 'voice/init', engine: 'moonshine' }))
      .toEqual({ ok: true });
    expect(relay.active()).toBe(true);
  });

  test('a non-UI voice-OFF transition tears down and revokes the initialized media feature', async () => {
    const relay = installVoiceRelay({
      acquire: async () => {},
      revoke: async () => {},
      sendHost: async () => ({ ok: true }),
    });
    expect(await relay.dispatch({ type: 'voice/init', engine: 'moonshine' })).toEqual({ ok: true });
    expect(relay.active()).toBe(true);

    expect(await relay.disableVoice()).toEqual({ ok: true });
    expect(relay.calls).toEqual([
      'acquire', 'host:voice/init', 'host:voice/teardown', 'revoke',
    ]);
    expect(relay.active()).toBe(false);
    expect(source('background/service-worker.js')).toContain(
      'if (patch?.voiceEnabled === false) await teardownVoiceFeature();',
    );
  });

  test('a fake-timer idle lock enters the exact live authority teardown once', async () => {
    const worker = source('background/service-worker.js');
    const lifecycleStart = worker.indexOf('/** @type {Promise<void>|null} */\nlet vaultLockLifecycle');
    const lifecycleEnd = worker.indexOf('// Complete the tiny publish', lifecycleStart);
    const subscriptionStart = worker.indexOf('vault.subscribe((event) => {');
    const subscriptionEnd = worker.indexOf('// 5. Agent turn driver', subscriptionStart);
    if ([lifecycleStart, lifecycleEnd, subscriptionStart, subscriptionEnd].some((at) => at < 0)) {
      throw new Error('vault-lock-lifecycle-source-boundary-missing');
    }

    let timer: (() => void) | null = null;
    const session = new Map<string, any>([[
      'vault.unlocked.v1',
      { dk: btoa(String.fromCharCode(...new Uint8Array(32))), unlockedAt: 1 },
    ]]);
    const vault = createVault({
      kv: {
        get: async () => undefined,
        set: async () => {},
        delete: async () => {},
        list: async () => ({}),
        clear: async () => {},
      },
      sessionCache: {
        sessionGet: async (key: string) => session.get(key),
        sessionSet: async (key: string, value: any) => { session.set(key, value); },
        sessionDelete: async (key: string) => { session.delete(key); },
      },
      autoLockMs: 1_000,
      now: () => 1,
      setTimer: (callback: () => void) => { timer = callback; return 1; },
      clearTimer: () => { timer = null; },
    });
    let statePushes = 0;
    let controllerCloses = 0;
    let authorityLocks = 0;
    let networkStops = 0;
    let publicationInvalidations = 0;
    const install = new Function(
      'vault',
      'pushState',
      'semanticController',
      'featureLeases',
      'onBaseNetworkStopped',
      'invalidateDwebPublications',
      `${worker.slice(lifecycleStart, lifecycleEnd)}\n${worker.slice(subscriptionStart, subscriptionEnd)}`,
    );
    install(
      vault,
      () => { statePushes += 1; },
      { close: () => { controllerCloses += 1; } },
      { lock: async () => { authorityLocks += 1; } },
      () => { networkStops += 1; },
      () => { publicationInvalidations += 1; },
    );

    expect(await vault.attemptResume()).toBe(true);
    expect(vault.isLocked()).toBe(false);
    const fire = timer as unknown as (() => void) | null;
    if (!fire) throw new Error('vault-auto-lock-timer-not-armed');
    fire();
    for (let i = 0; i < 8 && networkStops === 0; i += 1) await Promise.resolve();

    expect(vault.isLocked()).toBe(true);
    expect(vault.lockReason()).toBe('idle');
    expect(authorityLocks).toBe(1);
    expect(controllerCloses).toBe(1);
    expect(networkStops).toBe(1);
    expect(publicationInvalidations).toBe(1);
    expect(statePushes).toBe(2); // resumed + timer-fired lock
  });

  test('loading the dweb host cannot open custody or network without a lease', () => {
    const dweb = source('offscreen/dweb-base.js');
    expect(dweb).not.toMatch(/^connectCustodyPort\(\);$/m);
    expect(dweb).toContain('let custodyIntended = false');
    expect(dweb).toContain('export const startDwebFeatureLease');
    expect(dweb).toContain('export const adoptDwebFeatureLease');
    expect(dweb).toContain('export const stopDwebFeatureLease');
    expect(dweb).toContain("type: 'dweb/base-host/generation'");
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
    expect(shell).toContain('retireControllerHost?.()');
    expect(shell).toContain('abortRepositoryHostCalls()');
    expect(shell).toContain('abortAllJobs()');
    expect(shell).toContain('teardownLocalModel()');
    expect(shell).toContain('releaseMicTracks()');
    expect(shell).toContain('stopDwebFeatureLease()');
  });
});
