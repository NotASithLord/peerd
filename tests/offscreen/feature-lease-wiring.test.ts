import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENSION_DIR } from '../../packaging/lib.ts';
import { createVault } from '../../extension/peerd-egress/vault/vault.js';

const source = (path: string) => readFileSync(join(EXTENSION_DIR, path), 'utf8');

const installVoiceRelay = ({
  acquire,
  revoke,
  sendHost,
}: {
  acquire: () => Promise<void>;
  revoke: () => Promise<void>;
  sendHost: (message: any) => Promise<any>;
}) => {
  const worker = source('background/service-worker.js');
  const start = worker.indexOf('const VOICE_COMMANDS = new Set([');
  const end = worker.indexOf('// Tab tracker wiring.', start);
  if (start < 0 || end < 0) throw new Error('voice-relay-source-boundary-missing');
  let listener: ((message: any, sender: any, respond: (reply: any) => void) => boolean) | null = null;
  const onMessage = {
    addListener(value: typeof listener) { listener = value; },
  };
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
      onMessage,
      sendMessage: async (message: any) => {
        calls.push(`host:${message.type}`);
        return sendHost(message);
      },
    },
  };
  const evaluate = new Function(
    'coldEvent',
    'browser',
    'featureLeases',
    'acquireFeatureLease',
    'isActualSidepanelSender',
    'isActualOptionsSender',
    `${worker.slice(start, end)}\nreturn { teardownVoiceFeature };`,
  );
  const api = evaluate(
    (_name: string, event: any) => event,
    browser,
    featureLeases,
    acquireFeatureLease,
    () => true,
    () => false,
  );
  if (!listener) throw new Error('voice-relay-listener-not-installed');
  const dispatch = (message: any) => new Promise<any>((resolve) => {
    expect(listener?.(message, { url: 'sidepanel' }, resolve)).toBe(true);
  });
  return {
    calls,
    dispatch,
    disableVoice: () => api.teardownVoiceFeature(),
    active: () => active,
  };
};

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { promise, resolve };
};

describe('offscreen production feature-lease wiring', () => {
  test('the offscreen shell has no unconditional generic keepalive', () => {
    const shell = source('offscreen/offscreen.js');
    expect(shell).not.toContain("'sw-keepalive'");
    expect(shell).not.toContain("type: 'heartbeat'");
    expect(shell).toContain('FEATURE_LEASE_KEEPALIVE_PORT');
    expect(shell).toContain("feature-lease/host-");
    expect(shell).toContain("rejectWithoutLease('dweb'");
    expect(source('offscreen/supervisor-channels.js'))
      .toContain("ownsLease?.('controller', lease) === true");
    expect(shell).toContain("rejectWithoutLease('dom-host'");
    expect(shell).toContain("rejectWithoutLease('media-host'");
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
    expect(worker).toContain('createProductionFeatureLeaseRuntime({');
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
    expect(worker).toContain('...(offscreenAvailable ? {\n    withControllerLease:');
    expect(worker).toContain("withControllerLease: (operation) => withFeatureLease(");
    expect(worker).toMatch(
      /withHost:\s*\([^\n]*operation\)\s*=>\s*withFeatureLease\(\s*'controller'/,
    );
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
    const worker = source('background/service-worker.js');
    expect(worker).toContain('isActualSidepanelSender(sender)');
    expect(worker).toContain('isActualOptionsSender(sender)');
    expect(worker).toContain('__peerdVoiceRelay: voiceRelayToken');
    expect(worker).toContain("msg.type === 'voice/teardown'");
    expect(worker).toContain("featureLeases.revoke('media-host', 'feature-disabled')");
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
