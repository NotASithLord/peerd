import { describe, expect, test } from 'bun:test';
import { makeVaultRoutes } from '../../extension/background/routes/vault.js';
import {
  makeKernelRouteProvenance,
  makeVaultKernelMessageHandler,
  makeIndexedVaultRoutes,
  makeVaultKernelRoutes,
  prepareVaultKernel,
  resolveVaultAutoLockMs,
  resolveKernelPermission,
  VAULT_KERNEL_ROUTE_NAMES,
  buildVaultKernelState,
  projectVaultGateState,
} from '../../extension/background/vault-kernel-core.js';
import { normalizeSettingsPatch } from '../../extension/background/settings-patch.js';
import { normalizeVaultAutoLockPatch } from '../../extension/background/settings-patch.js';
import { purgeVaultBlob } from '../../extension/peerd-egress/vault/purge.js';
import { createVault } from '../../extension/peerd-egress/vault/vault.js';
import {
  PrfNotEnrolledError,
  PrfUnlockFailedError,
  RecoveryPassphraseNotSetError,
  VaultAlreadyInitializedError,
  VaultLockedError,
  VaultNotInitializedError,
  WrongPassphraseError,
} from '../../extension/peerd-egress/vault/errors.js';
import { base64ToBytes, bytesToBase64 } from '../../extension/shared/util.js';

const PASS = 'correct-horse-battery-staple';
const PRF = new Uint8Array(32).fill(0x51);
const CREDENTIAL = new Uint8Array([1, 2, 3, 4]);
const SALT = new Uint8Array(32).fill(0x72);

const getVaultGateStatus = async (vault: any) => {
  const [prf, hasRecovery] = await Promise.all([
    vault.prfStatus(), vault.hasRecoveryPassphrase(),
  ]);
  return {
    initialized: prf.enrolled || hasRecovery,
    prfEnrolled: prf.enrolled,
    hasRecovery,
  };
};

const fakeArgon2 = async ({ passphrase, salt, memKiB, iters, parallelism }: any) => {
  const head = new TextEncoder().encode(`${passphrase}|${memKiB}|${iters}|${parallelism}|`);
  const input = new Uint8Array(head.length + salt.length);
  input.set(head);
  input.set(salt, head.length);
  return new Uint8Array(await crypto.subtle.digest('SHA-256', input));
};

const makeKv = () => {
  const store = new Map<string, any>();
  return {
    store,
    get: async (key: string) => store.get(key),
    set: async (key: string, value: any) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
    list: async (prefix = '') => Object.fromEntries(
      [...store].filter(([key]) => key.startsWith(prefix)),
    ),
    clear: async () => { store.clear(); },
  };
};

const makeSession = () => {
  const store = new Map<string, any>();
  return {
    store,
    sessionGet: async (key: string) => store.get(key),
    sessionSet: async (key: string, value: any) => { store.set(key, value); },
    sessionDelete: async (key: string) => { store.delete(key); },
  };
};

const errors = {
  VaultAlreadyInitializedError,
  WrongPassphraseError,
  VaultNotInitializedError,
  RecoveryPassphraseNotSetError,
  PrfNotEnrolledError,
  PrfUnlockFailedError,
  VaultLockedError,
};

const deferredVaultEffects = {
  onInitialized: async () => {},
  onUnlocked: async () => {},
  onLocked: async () => {},
};

const makeLane = (
  kind: 'legacy'|'kernel',
  vaultOver: Record<string, any> = {},
  depsOver: Record<string, any> = {},
) => {
  const kv = makeKv();
  const sessionCache = makeSession();
  const vault = createVault({
    kv,
    sessionCache,
    argon2: fakeArgon2,
    autoLockMs: 0,
    ...vaultOver,
  });
  const audit: any[] = [];
  const pushes: any[] = [];
  const deps = {
    vault,
    auditLog: { append: async (entry: any) => { audit.push(entry); } },
    kv,
    idb: undefined,
    base64ToBytes,
    purgeVaultBlob,
    sessionCache,
    pushState: () => { pushes.push('state'); },
    ...deferredVaultEffects,
    ...errors,
    ...depsOver,
  };
  const routes = kind === 'kernel'
    ? makeVaultKernelRoutes({ ready: Promise.resolve(), deps })
    : makeVaultRoutes(deps);
  return { routes, vault, kv, sessionCache, audit, pushes };
};

const twin = () => ({ legacy: makeLane('legacy'), kernel: makeLane('kernel') });
const both = async (
  lanes: ReturnType<typeof twin>,
  route: string,
  message: Record<string, any> = {},
) => {
  const legacy = await lanes.legacy.routes[route](message);
  const kernel = await lanes.kernel.routes[route](message);
  expect(kernel).toEqual(legacy);
  return kernel;
};

describe('vault authority kernel differential parity', () => {
  test('selects every vault lifecycle route and no confirmation/semantic route', () => {
    const lane = makeLane('kernel');
    expect(Object.keys(lane.routes)).toEqual([...VAULT_KERNEL_ROUTE_NAMES]);
    expect(lane.routes['confirm/answer']).toBeUndefined();
    expect(lane.routes['agent/send']).toBeUndefined();
  });

  test('explicit kernel custody hooks replace only the deferred lifecycle seams', async () => {
    const calls: string[] = [];
    const lane = makeLane('kernel', {}, {
      onInitialized: async () => { calls.push('initialize'); },
      onUnlocked: async (reason: string) => { calls.push(reason); },
      onLocked: async () => { calls.push('lock'); },
    });
    expect(await lane.routes['vault/initialize']({ passphrase: 'correct horse battery' }))
      .toEqual({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await lane.routes['vault/lock']()).toEqual({ ok: true });
    expect(await lane.routes['vault/unlock']({ passphrase: 'correct horse battery' }))
      .toEqual({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual(['initialize', 'lock', 'unlock']);
  });

  test('passphrase first install, manual lock, errors, and unlock match legacy', async () => {
    const lanes = twin();
    await both(lanes, 'vault/initialize', { passphrase: PASS });
    expect(lanes.kernel.audit).toEqual(lanes.legacy.audit);
    expect(await getVaultGateStatus(lanes.kernel.vault))
      .toEqual(await getVaultGateStatus(lanes.legacy.vault));
    await both(lanes, 'vault/lock');
    expect(lanes.kernel.vault.lockReason()).toBe('manual');
    expect(lanes.kernel.pushes).toEqual(lanes.legacy.pushes);
    await both(lanes, 'vault/unlock', { passphrase: 'wrong-passphrase' });
    await both(lanes, 'vault/unlock', { passphrase: PASS });
    expect(lanes.kernel.vault.isLocked()).toBe(false);
    expect(lanes.kernel.audit).toEqual(lanes.legacy.audit);
  });

  test('passkey-only first install, PRF status, lock, and unlock match legacy', async () => {
    const lanes = twin();
    const enrollment = {
      credentialId: bytesToBase64(CREDENTIAL),
      prfSalt: bytesToBase64(SALT),
      prfOutput: bytesToBase64(PRF),
      transports: ['internal'],
    };
    await both(lanes, 'vault/initializeWithPasskey', enrollment);
    await both(lanes, 'vault/prfStatus');
    expect(lanes.kernel.audit).toEqual(lanes.legacy.audit);
    expect(await getVaultGateStatus(lanes.kernel.vault)).toEqual({
      initialized: true, prfEnrolled: true, hasRecovery: false,
    });
    await both(lanes, 'vault/lock');
    await both(lanes, 'vault/unlockPrf', { prfOutput: bytesToBase64(new Uint8Array(32)) });
    await both(lanes, 'vault/unlockPrf', { prfOutput: bytesToBase64(PRF) });
    expect(lanes.kernel.vault.isLocked()).toBe(false);
    expect(lanes.kernel.audit).toEqual(lanes.legacy.audit);
  });

  test('recovery, enroll, and disable operations retain exact legacy results/audit', async () => {
    const lanes = twin();
    await both(lanes, 'vault/initializeWithPasskey', {
      credentialId: bytesToBase64(CREDENTIAL),
      prfSalt: bytesToBase64(SALT),
      prfOutput: bytesToBase64(PRF),
    });
    await both(lanes, 'vault/setRecoveryPassphrase', { passphrase: PASS });
    await both(lanes, 'vault/disablePrf');
    expect(await getVaultGateStatus(lanes.kernel.vault)).toEqual({
      initialized: true, prfEnrolled: false, hasRecovery: true,
    });
    await both(lanes, 'vault/enrollPrf', {
      credentialId: bytesToBase64(CREDENTIAL),
      prfSalt: bytesToBase64(SALT),
      prfOutput: bytesToBase64(PRF),
    });
    expect(lanes.kernel.audit).toEqual(lanes.legacy.audit);
  });

  test('failed passkey initialization locks and purges the exact partial token', async () => {
    class HardwareFailure extends Error {}
    const calls = { legacy: { lock: 0, purge: 0 }, kernel: { lock: 0, purge: 0 } };
    const make = (kind: 'legacy'|'kernel') => {
      const deps = {
        vault: {
          initializeWithPrfOnly: async () => { throw new HardwareFailure('hardware'); },
          lock: () => { calls[kind].lock += 1; },
        },
        auditLog: { append: async () => {} },
        kv: {}, idb: {}, base64ToBytes,
        purgeVaultBlob: async () => { calls[kind].purge += 1; },
        sessionCache: {}, pushState: () => {}, ...deferredVaultEffects, ...errors,
      };
      return kind === 'kernel'
        ? makeVaultKernelRoutes({ ready: Promise.resolve(), deps })
        : makeVaultRoutes(deps);
    };
    const message = { credentialId: 'AQ==', prfSalt: 'Ag==', prfOutput: 'Aw==' };
    await expect(make('legacy')['vault/initializeWithPasskey'](message)).rejects.toThrow('hardware');
    await expect(make('kernel')['vault/initializeWithPasskey'](message)).rejects.toThrow('hardware');
    expect(calls.kernel).toEqual(calls.legacy);
    expect(calls.kernel).toEqual({ lock: 1, purge: 1 });
  });
});

describe('vault authority kernel boot and UI contract', () => {
  test('provenance rejects engine vault calls while keeping first-party reads', async () => {
    const routeSenders: any[] = [];
    const routes = {
      'state/get': async (_message: any, sender: any) => {
        routeSenders.push(sender);
        return { ok: true, state: 'minimal' };
      },
      'session/get': async () => ({ ok: true, session: 'chat' }),
      'settings/update': async () => ({ ok: true }),
      'vault/lock': async () => ({ ok: true }),
      'vault/unlock': async () => { throw new Error('typed failure'); },
      'vault/initializeWithPasskey': async () => {
        throw Object.assign(new Error('raw private channel detail'), {
          code: 'vault-authority-timeout', outcomeKnown: false,
        });
      },
    };
    const handler = makeVaultKernelMessageHandler({
      routes,
      trusted: (sender: any) => sender?.firstParty === true,
      humanUi: (sender: any) => sender?.surface === 'sidepanel' || sender?.surface === 'home',
    });
    const invoke = (message: any, sender: any) => new Promise((resolve) => {
      const keepAlive = handler(message, sender, resolve);
      if (!keepAlive) queueMicrotask(() => resolve({ keepAlive }));
    });

    expect(await invoke({ type: 'state/get' }, { firstParty: true, surface: 'engine' }))
      .toEqual({ ok: true, state: 'minimal' });
    expect(routeSenders).toEqual([{ firstParty: true, surface: 'engine' }]);
    const sessionHandler = makeVaultKernelMessageHandler({
      routes,
      trusted: (sender: any) => sender?.firstParty === true,
      humanUi: (sender: any) => sender?.surface === 'sidepanel' || sender?.surface === 'home',
      humanRoutes: new Set(['session/get']),
    });
    const readSession = (sender: any) => new Promise((resolve) => {
      sessionHandler({ type: 'session/get' }, sender, resolve);
    });
    expect(await readSession({ firstParty: true, surface: 'engine' }))
      .toEqual({ ok: false, error: 'vault-route-unauthorized-sender' });
    expect(await readSession({ firstParty: true, surface: 'sidepanel' }))
      .toEqual({ ok: true, session: 'chat' });
    expect(await invoke({ type: 'vault/lock' }, { firstParty: true, surface: 'engine' }))
      .toEqual({ ok: false, error: 'vault-route-unauthorized-sender' });
    expect(await invoke(
      { type: 'settings/update', patch: { vaultAutoLockMs: 0 } },
      { firstParty: true, surface: 'engine' },
    )).toEqual({ ok: false, error: 'vault-route-unauthorized-sender' });
    expect(await invoke({ type: 'vault/lock' }, { firstParty: false, surface: 'sidepanel' }))
      .toEqual({ ok: false, error: 'untrusted-sender' });
    expect(await invoke({ type: 'vault/lock' }, { firstParty: true, surface: 'home' }))
      .toEqual({ ok: true });
    expect(await invoke({ type: 'vault/unlock' }, { firstParty: true, surface: 'home' }))
      .toEqual({ ok: false, error: 'typed failure' });
    expect(await invoke(
      { type: 'vault/initializeWithPasskey' },
      { firstParty: true, surface: 'sidepanel' },
    )).toEqual({
      ok: false,
      error: 'Peerd could not confirm whether the requested change finished. Refresh to reconcile before trying again.',
      code: 'vault-authority-timeout',
      outcomeKnown: false,
      outcomeKind: 'unknown',
      retryable: false,
    });
  });

  test('authorized route replies are generation-bound and a retired binder fails closed', async () => {
    const identity = {
      schema: 1,
      build: `0.7.0:${'a'.repeat(64)}`,
      bootId: 'boot-handler-aa',
      kernelEpoch: 'kernel-handler-a',
    };
    let retired = false;
    const handler = makeVaultKernelMessageHandler({
      routes: { 'state/get': async () => ({ ok: true, state: { kernel: identity } }) },
      trusted: () => true,
      humanUi: () => true,
      bindReply: async (reply: any) => {
        if (retired) throw new Error('kernel-generation-retired');
        return { ...reply, ...identity };
      },
    });
    const invoke = () => new Promise((resolve) => {
      expect(handler({ type: 'state/get' }, { firstParty: true }, resolve)).toBe(true);
    });
    expect(await invoke()).toEqual({ ok: true, state: { kernel: identity }, ...identity });
    retired = true;
    expect(await invoke()).toEqual({
      ok: false,
      error: 'Peerd could not confirm whether the requested change finished. Refresh to reconcile before trying again.',
      code: 'kernel-generation-retired',
      outcomeKnown: false,
      outcomeKind: 'transport-lost',
      retryable: false,
    });
  });

  test('route provenance admits Options and App owners without widening chat routes', async () => {
    const calls: string[] = [];
    const routes = {
      'git-cred/list': async () => { calls.push('git'); return { ok: true }; },
      'provider/setKey': async () => { calls.push('provider'); return { ok: true }; },
      'provider/status': async () => { calls.push('provider-status'); return { ok: true }; },
      'provider/test': async () => { calls.push('provider-test'); return { ok: true }; },
      'models/options': async () => { calls.push('models'); return { ok: true }; },
      'openrouter/models': async () => { calls.push('openrouter-models'); return { ok: true }; },
      'local-model/catalog': async () => { calls.push('local-models'); return { ok: true }; },
      'memory/write': async () => { calls.push('memory-write'); return { ok: true }; },
      'settings/update': async () => { calls.push('settings'); return { ok: true }; },
      'session/get': async () => { calls.push('session'); return { ok: true }; },
      'session/setModel': async () => { calls.push('set-model'); return { ok: true }; },
      'app/editor/read': async () => { calls.push('editor'); return { ok: true }; },
      'app/editor-write': async () => { calls.push('editor-alias'); return { ok: true }; },
      'apps/import-git': async () => { calls.push('import-git'); return { ok: true }; },
      'onboarding/complete': async () => { calls.push('onboarding'); return { ok: true }; },
      'permission/set': async () => { calls.push('permission'); return { ok: true }; },
      'agent/send': async () => { calls.push('agent-send'); return { ok: true }; },
      'contacts/list': async () => { calls.push('contacts'); return { ok: true }; },
      'skills/list': async () => { calls.push('skills'); return { ok: true }; },
      'hooks/list': async () => { calls.push('hooks'); return { ok: true }; },
      'memory/init': async () => { calls.push('memory-init'); return { ok: true }; },
      'agent/stop': async () => { calls.push('agent-stop'); return { ok: true }; },
      'actor/spawn': async () => { calls.push('actor-spawn'); return { ok: true }; },
      'session/archive': async () => { calls.push('session-archive'); return { ok: true }; },
      'session/reset': async () => { calls.push('session-reset'); return { ok: true }; },
      'session/switch': async () => { calls.push('session-switch'); return { ok: true }; },
      'session/debugBundle': async () => { calls.push('debug'); return { ok: true }; },
      'debug/originLock': async () => { calls.push('origin-lock'); return { ok: true }; },
      'actor-isolation/retry': async () => { calls.push('isolation'); return { ok: true }; },
    };
    const routeProvenance = makeKernelRouteProvenance({
      humanUi: (sender: any) => sender?.surface === 'sidepanel' || sender?.surface === 'home',
      homeUi: (sender: any) => sender?.surface === 'home',
      sidepanelUi: (sender: any) => sender?.surface === 'sidepanel',
      evalUi: (sender: any) => sender?.surface === 'eval',
      activityStopUi: (sender: any, message: any) =>
        sender?.surface === 'active-page' && message?.activity === 'live',
      actorSpawnUi: (sender: any) => sender?.surface === 'notebook' || sender?.surface === 'offscreen',
      optionsUi: (sender: any) => sender?.surface === 'options',
      appUi: (sender: any, appId: string) => sender?.surface === 'app' && sender?.appId === appId,
      voiceUi: (sender: any) => sender?.surface === 'sidepanel' || sender?.surface === 'options',
      vaultRoutes: ['vault/lock'],
    });
    const handler = makeVaultKernelMessageHandler({
      routes,
      trusted: (sender: any) => sender?.firstParty === true,
      humanUi: (sender: any) => sender?.surface === 'sidepanel' || sender?.surface === 'home',
      humanRoutes: new Set(),
      routeProvenance,
    });
    const invoke = (message: any, sender: any) => new Promise((resolve) => {
      handler(message, sender, resolve);
    });
    expect(await invoke({ type: 'git-cred/list' }, { firstParty: true, surface: 'options' }))
      .toEqual({ ok: true });
    expect(await invoke({ type: 'git-cred/list' }, { firstParty: true, surface: 'home' }))
      .toEqual({ ok: false, error: 'vault-route-unauthorized-sender' });
    expect(await invoke({ type: 'settings/update' }, { firstParty: true, surface: 'options' }))
      .toEqual({ ok: true });
    expect(await invoke(
      { type: 'provider/setKey', provider: 'anthropic', plaintext: 'secret-never-read' },
      { firstParty: true, surface: 'options' },
    )).toEqual({ ok: true });
    expect(await invoke(
      { type: 'provider/setKey', provider: 'anthropic', plaintext: 'secret-never-read' },
      { firstParty: true, surface: 'app', appId: 'one' },
    )).toEqual({ ok: false, error: 'vault-route-unauthorized-sender' });
    expect(await invoke(
      { type: 'provider/setKey', provider: 'anthropic', plaintext: 'secret-never-read' },
      { firstParty: true, surface: 'offscreen' },
    )).toEqual({ ok: false, error: 'vault-route-unauthorized-sender' });
    expect(await invoke(
      { type: 'provider/test', provider: 'anthropic' },
      { firstParty: true, surface: 'options' },
    )).toEqual({ ok: true });
    expect(await invoke(
      { type: 'provider/test', provider: 'anthropic' },
      { firstParty: true, surface: 'sidepanel' },
    )).toEqual({ ok: true });
    expect(await invoke(
      { type: 'provider/test', provider: 'anthropic' },
      { firstParty: true, surface: 'app', appId: 'one' },
    )).toEqual({ ok: false, error: 'vault-route-unauthorized-sender' });
    expect(await invoke(
      { type: 'provider/status' },
      { firstParty: true, surface: 'sidepanel' },
    )).toEqual({ ok: true });
    expect(await invoke(
      { type: 'provider/status' },
      { firstParty: true, surface: 'options' },
    )).toEqual({ ok: true });
    expect(await invoke(
      { type: 'provider/status' },
      { firstParty: true, surface: 'app', appId: 'one' },
    )).toEqual({ ok: false, error: 'vault-route-unauthorized-sender' });
    expect(await invoke(
      { type: 'provider/status' },
      { firstParty: true, surface: 'offscreen' },
    )).toEqual({ ok: false, error: 'vault-route-unauthorized-sender' });
    expect(await invoke(
      { type: 'models/options' },
      { firstParty: true, surface: 'sidepanel' },
    )).toEqual({ ok: true });
    expect(await invoke(
      { type: 'models/options' },
      { firstParty: true, surface: 'options' },
    )).toEqual({ ok: true });
    expect(await invoke(
      { type: 'models/options' },
      { firstParty: true, surface: 'app', appId: 'one' },
    )).toEqual({ ok: false, error: 'vault-route-unauthorized-sender' });
    expect(await invoke(
      { type: 'openrouter/models' },
      { firstParty: true, surface: 'options' },
    )).toEqual({ ok: true });
    expect(await invoke(
      { type: 'openrouter/models' },
      { firstParty: true, surface: 'sidepanel' },
    )).toEqual({ ok: false, error: 'vault-route-unauthorized-sender' });
    expect(await invoke(
      { type: 'openrouter/models' },
      { firstParty: true, surface: 'offscreen' },
    )).toEqual({ ok: false, error: 'vault-route-unauthorized-sender' });
    expect(await invoke(
      { type: 'local-model/catalog' },
      { firstParty: true, surface: 'options' },
    )).toEqual({ ok: true });
    expect(await invoke(
      { type: 'local-model/catalog' },
      { firstParty: true, surface: 'sidepanel' },
    )).toEqual({ ok: false, error: 'vault-route-unauthorized-sender' });
    expect(await invoke(
      { type: 'local-model/init', model: 'never-read' },
      { firstParty: true, surface: 'offscreen' },
    )).toEqual({ ok: false, error: 'vault-route-unauthorized-sender' });
    expect(await invoke(
      { type: 'memory/write', scope: { kind: 'user' }, body: 'private' },
      { firstParty: true, surface: 'options' },
    )).toEqual({ ok: true });
    expect(await invoke(
      { type: 'memory/write', scope: { kind: 'user' }, body: 'private' },
      { firstParty: true, surface: 'home' },
    )).toEqual({ ok: false, error: 'vault-route-unauthorized-sender' });
    expect(await invoke(
      { type: 'provider/test', provider: 'anthropic' },
      { firstParty: true, surface: 'offscreen' },
    )).toEqual({ ok: false, error: 'vault-route-unauthorized-sender' });
    expect(await invoke({ type: 'session/get' }, { firstParty: true, surface: 'options' }))
      .toEqual({ ok: false, error: 'vault-route-unauthorized-sender' });
    expect(await invoke({ type: 'session/get' }, { firstParty: true, surface: 'home' }))
      .toEqual({ ok: true });
    expect(await invoke(
      { type: 'permission/set', mode: 'plan' },
      { firstParty: true, surface: 'sidepanel' },
    )).toEqual({ ok: true });
    expect(await invoke(
      { type: 'permission/set', mode: 'act' },
      { firstParty: true, surface: 'options' },
    )).toEqual({ ok: true });
    expect(await invoke(
      { type: 'onboarding/complete', peerName: 'Nova' },
      { firstParty: true, surface: 'home' },
    )).toEqual({ ok: true });
    expect(await invoke(
      { type: 'apps/import-git', url: 'https://example.test/app.git' },
      { firstParty: true, surface: 'home' },
    )).toEqual({ ok: true });
    expect(await invoke(
      { type: 'apps/import-git', url: 'https://example.test/app.git' },
      { firstParty: true, surface: 'options' },
    )).toEqual({ ok: false, error: 'vault-route-unauthorized-sender' });
    for (const surface of ['options', 'app', 'offscreen', 'eval']) {
      expect(await invoke(
        { type: 'onboarding/complete', peerName: 'Never read' },
        { firstParty: true, surface, appId: 'one' },
      )).toEqual({ ok: false, error: 'vault-route-unauthorized-sender' });
    }
    expect(await invoke(
      { type: 'session/setModel', sessionId: 'chat', model: 'next' },
      { firstParty: true, surface: 'sidepanel' },
    )).toEqual({ ok: true });
    expect(await invoke(
      { type: 'session/setModel', sessionId: 'chat', model: 'next' },
      { firstParty: true, surface: 'options' },
    )).toEqual({ ok: false, error: 'vault-route-unauthorized-sender' });
    expect(await invoke(
      { type: 'agent/send', text: 'never load' },
      { firstParty: true, surface: 'offscreen' },
    )).toEqual({ ok: false, error: 'vault-route-unauthorized-sender' });
    expect(await invoke(
      { type: 'agent/send', text: 'hello' },
      { firstParty: true, surface: 'sidepanel' },
    )).toEqual({ ok: true });
    expect(await invoke(
      { type: 'agent/send', text: 'eval' },
      { firstParty: true, surface: 'eval' },
    )).toEqual({ ok: true });
    expect(await invoke(
      { type: 'agent/send', text: 'home' },
      { firstParty: true, surface: 'home' },
    )).toEqual({ ok: false, error: 'vault-route-unauthorized-sender' });
    expect(await invoke(
      { type: 'debug/originLock', origin: 'https://example.test' },
      { firstParty: true, surface: 'sidepanel' },
    )).toEqual({ ok: true });
    expect(await invoke(
      { type: 'debug/originLock', origin: 'https://example.test' },
      { firstParty: true, surface: 'eval' },
    )).toEqual({ ok: true });
    for (const surface of ['home', 'options', 'offscreen']) {
      expect(await invoke(
        { type: 'debug/originLock', origin: 'https://example.test' },
        { firstParty: true, surface },
      )).toEqual({ ok: false, error: 'vault-route-unauthorized-sender' });
    }
    expect(await invoke(
      { type: 'agent/stop', activity: 'live' },
      { surface: 'active-page' },
    )).toEqual({ ok: true });
    expect(await invoke({ type: 'actor/spawn' }, { firstParty: true, surface: 'notebook' }))
      .toEqual({ ok: true });
    for (const [route, allowed, denied] of [
      ['session/archive', 'home', 'eval'],
      ['session/switch', 'home', 'options'],
      ['session/reset', 'eval', 'options'],
      ['session/debugBundle', 'options', 'home'],
      ['actor-isolation/retry', 'sidepanel', 'home'],
    ]) {
      expect(await invoke({ type: route }, { firstParty: true, surface: allowed }))
        .toEqual({ ok: true });
      expect(await invoke({ type: route }, { firstParty: true, surface: denied }))
        .toEqual({ ok: false, error: 'vault-route-unauthorized-sender' });
    }
    for (const [route, allowed, denied] of [
      ['contacts/list', 'home', 'sidepanel'],
      ['skills/list', 'sidepanel', 'home'],
      ['hooks/list', 'sidepanel', 'home'],
      ['memory/init', 'options', 'home'],
    ]) {
      expect(await invoke({ type: route }, { firstParty: true, surface: allowed }))
        .toEqual({ ok: true });
      expect(await invoke({ type: route }, { firstParty: true, surface: denied }))
        .toEqual({ ok: false, error: 'vault-route-unauthorized-sender' });
    }
    expect(await invoke(
      { type: 'app/editor/read', appId: 'one' },
      { firstParty: true, surface: 'app', appId: 'one' },
    )).toEqual({ ok: true });
    expect(await invoke(
      { type: 'app/editor/read', appId: 'two' },
      { firstParty: true, surface: 'app', appId: 'one' },
    )).toEqual({ ok: false, error: 'vault-route-unauthorized-sender' });
    expect(await invoke(
      { type: 'app/editor-write', appId: 'one' },
      { firstParty: true, surface: 'app', appId: 'one' },
    )).toEqual({ ok: true });
    expect(await invoke(
      { type: 'app/editor-write', appId: 'one' },
      { firstParty: true, surface: 'sidepanel' },
    )).toEqual({ ok: false, error: 'vault-route-unauthorized-sender' });
    expect(calls).toEqual([
      'git', 'settings', 'provider', 'provider-test', 'provider-test',
      'provider-status', 'provider-status', 'models', 'models', 'openrouter-models', 'local-models', 'memory-write',
      'session', 'permission', 'permission', 'onboarding', 'import-git', 'set-model',
      'agent-send', 'agent-send', 'origin-lock', 'origin-lock', 'agent-stop', 'actor-spawn',
      'session-archive', 'session-switch', 'session-reset', 'debug', 'isolation',
      'contacts', 'skills', 'hooks', 'memory-init',
      'editor', 'editor-alias',
    ]);
    expect(() => makeKernelRouteProvenance({
      humanUi: () => true, optionsUi: () => true, appUi: () => true,
      homeUi: () => true, sidepanelUi: () => true, voiceUi: () => true,
      vaultRoutes: ['settings/update'],
    })).toThrow('kernel-route-provenance-duplicate:settings/update');
  });

  test('permission projection preserves durable defaults and legacy tiers', () => {
    expect(resolveKernelPermission(null, undefined, undefined))
      .toEqual({ mode: 'act', confirmActions: false });
    expect(resolveKernelPermission({ permissionMode: 'plan', actTier: 'suggest' }, 'act', false))
      .toEqual({ mode: 'plan', confirmActions: true });
    expect(resolveKernelPermission({ permissionMode: 'act', actTier: 'full-auto' }, 'plan', true))
      .toEqual({ mode: 'act', confirmActions: false });
    expect(resolveKernelPermission({ permissionMode: 'corrupt', confirmActions: false }, 'act', true))
      .toEqual({ mode: 'plan', confirmActions: false });
  });

  test('storage posture settles before settings, policy, and resume', async () => {
    const order: string[] = [];
    const result = await prepareVaultKernel({
      applyPosture: async () => { order.push('posture'); return { ok: true }; },
      readSettings: async () => { order.push('settings'); return { vaultAutoLockMs: 12_345 }; },
      setAutoLockMs: (value: number) => { order.push(`policy:${value}`); },
      attemptResume: async () => { order.push('resume'); return true; },
      defaultAutoLockMs: 45 * 60_000,
    });
    expect(order).toEqual(['posture', 'settings', 'policy:12345', 'resume']);
    expect(result).toEqual({ posture: { ok: true }, autoLockMs: 12_345, resumed: true });
  });

  test('a posture failure prevents resume and every vault route', async () => {
    let resume = 0;
    const ready = prepareVaultKernel({
      applyPosture: async () => { throw new Error('store blocked'); },
      readSettings: async () => ({}),
      setAutoLockMs: () => {},
      attemptResume: async () => { resume += 1; return false; },
      defaultAutoLockMs: 1,
    });
    const routes = makeVaultKernelRoutes({
      ready,
      deps: {
        vault: { prfStatus: async () => ({ enrolled: false }) },
        auditLog: { append: async () => {} },
        ...errors,
      },
    });
    await expect(routes['vault/prfStatus']()).rejects.toThrow('store blocked');
    expect(resume).toBe(0);
  });

  test('a rejected first-run mutation refreshes the posture and pushed state', async () => {
    const writes: any[] = [];
    let pushed = 0;
    const failure = new Error('session mirror unavailable');
    const routes = makeIndexedVaultRoutes({
      routes: { 'vault/initialize': async () => { throw failure; } },
      posture: {
        snapshot: () => ({ initialized: false }),
        read: async () => ({ initialized: false }),
        write: async (status: any) => { writes.push(status); },
      },
      vault: {
        isInitialized: () => true,
        status: async () => ({
          initialized: true, prfEnrolled: false, hasRecovery: true,
          locked: true, unlockedAt: 0, lockReason: null,
        }),
      },
      pushState: async () => { pushed += 1; },
    });
    await expect(routes['vault/initialize']()).rejects.toBe(failure);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ initialized: true, locked: true });
    expect(pushed).toBe(1);
  });

  test('an already-initialized retry repairs a stale fresh-install posture', async () => {
    const writes: any[] = [];
    const routes = makeIndexedVaultRoutes({
      routes: {
        'vault/initialize': async () => ({ ok: false, error: 'already-initialized' }),
      },
      posture: {
        snapshot: () => ({ initialized: false }),
        read: async () => ({ initialized: false }),
        write: async (status: any) => { writes.push(status); },
      },
      vault: {
        isInitialized: () => true,
        status: async () => ({ initialized: true, prfEnrolled: true, hasRecovery: false }),
      },
      pushState: () => {},
    });
    await expect(routes['vault/initialize']()).resolves
      .toEqual({ ok: false, error: 'already-initialized' });
    expect(writes).toEqual([{ initialized: true, prfEnrolled: true, hasRecovery: false }]);
  });

  test('auto-lock policy accepts only finite non-negative stored numbers', () => {
    expect(resolveVaultAutoLockMs(0, 9)).toBe(0);
    expect(resolveVaultAutoLockMs(5000, 9)).toBe(5000);
    for (const invalid of [-1, Infinity, Number.NaN, '5000', null, undefined]) {
      expect(resolveVaultAutoLockMs(invalid, 9)).toBe(9);
    }
  });

  test('session mirror resumes only after stored policy is installed', async () => {
    const kv = makeKv();
    const sessionCache = makeSession();
    const first = createVault({ kv, sessionCache, autoLockMs: 0 });
    await first.initializeWithPrfOnly({
      credentialId: CREDENTIAL, prfSalt: SALT, prfOutput: PRF,
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const revived = createVault({ kv, sessionCache, autoLockMs: 0 });
    const result = await prepareVaultKernel({
      applyPosture: async () => ({ ok: true }),
      readSettings: async () => ({ vaultAutoLockMs: 60_000 }),
      setAutoLockMs: revived.setAutoLockMs,
      attemptResume: revived.attemptResume,
      defaultAutoLockMs: 45 * 60_000,
    });
    expect(result.resumed).toBe(true);
    expect(revived.isLocked()).toBe(false);
    revived.lock();
  });

  test('stored auto-lock policy arms the live vault and locks with idle reason', async () => {
    let timer: (() => void) | null = null;
    const vault = createVault({
      kv: makeKv(),
      autoLockMs: 0,
      setTimer: (callback: () => void) => { timer = callback; return 1; },
      clearTimer: () => { timer = null; },
    });
    await vault.initializeWithPrfOnly({
      credentialId: CREDENTIAL, prfSalt: SALT, prfOutput: PRF,
    });
    expect(vault.isLocked()).toBe(false);
    const result = await prepareVaultKernel({
      applyPosture: async () => ({ ok: true }),
      readSettings: async () => ({ vaultAutoLockMs: 1_234 }),
      setAutoLockMs: vault.setAutoLockMs,
      attemptResume: vault.attemptResume,
      defaultAutoLockMs: 45 * 60_000,
    });
    expect(result.autoLockMs).toBe(1_234);
    expect(timer).toBeFunction();
    (timer as unknown as () => void)();
    expect(vault.isLocked()).toBe(true);
    expect(vault.lockReason()).toBe('idle');
  });

  test('vault auto-lock normalization remains byte-for-value identical to full settings', async () => {
    const normalizationDeps = {
      knownProviderNames: ['anthropic'], reasoningEffortLevels: ['medium'],
      dwebEnabled: false, autoUpdateAvailable: false,
      normalizeVariant: () => 'base', normalizeEngine: () => 'auto',
    };
    for (const value of [0, -1, 1_000, 60_001, 999_999_999, 'nope']) {
      expect(normalizeVaultAutoLockPatch({ vaultAutoLockMs: value }))
        .toEqual(normalizeSettingsPatch({ vaultAutoLockMs: value }, normalizationDeps));
    }

  });

  test('first-install VaultGate projection is exact against legacy locked state', () => {
    const legacyLockedSnapshot = {
      hydrated: true,
      vault: {
        initialized: false, locked: true, unlockedAt: 0,
        prfEnrolled: false, hasRecovery: false, lockReason: null,
      },
      settings: { vaultAutoLockMs: 45 * 60_000, unrelated: 'rich-host-only' },
    };
    const kernel = buildVaultKernelState({
      kernel: {
        schema: 1,
        buildId: `0.7.0:${'a'.repeat(64)}`,
        bootId: 'boot-differential',
        kernelEpoch: 'kernel-differential',
      },
      status: { initialized: false, prfEnrolled: false, hasRecovery: false },
      locked: true, unlockedAt: 999, lockReason: null, autoLockMs: 45 * 60_000,
      settings: { vaultAutoLockMs: 45 * 60_000 },
      session: { sessionId: null, messages: [], permission: { mode: 'plan', confirmActions: true } },
      providers: { current: 'anthropic', model: 'claude-sonnet-4-6', hasKey: false },
      composer: { provider: 'anthropic', model: 'claude-sonnet-4-6', keyless: false,
        credentialReady: false, localReady: false, canSend: false, reason: 'vault-locked' },
    });
    expect(projectVaultGateState(kernel)).toEqual(projectVaultGateState(legacyLockedSnapshot));
    expect(JSON.stringify(projectVaultGateState(kernel)))
      .not.toMatch(/credentialId|prfSalt|wrappedDK|secret|apiKey/);
  });
});
