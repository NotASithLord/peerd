import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectStaticModuleGraph } from '../../packaging/static-module-graph.ts';
import { EXTENSION_DIR } from '../../packaging/lib.ts';
import { buildVaultKernelState } from '../../extension/background/vault-kernel-core.js';
import { validateKernelStateProjection } from '../../extension/shared/kernel-state-contract.js';
import { createVault } from '../../extension/peerd-egress/vault/vault.js';

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

const KERNEL = Object.freeze({
  schema: 1,
  buildId: `0.7.0:${'a'.repeat(64)}`,
  bootId: 'boot-prototype',
  kernelEpoch: 'kernel-prototype',
});
const lockedUi = {
  settings: { vaultAutoLockMs: 45 * 60_000 },
  session: { sessionId: null, messages: [], permission: { mode: 'plan', confirmActions: true } },
  providers: { current: 'anthropic', model: 'claude-sonnet-4-6', hasKey: false },
  composer: { provider: 'anthropic', model: 'claude-sonnet-4-6', keyless: false,
    credentialReady: false, localReady: false, canSend: false, reason: 'vault-locked' },
};

const makeKv = () => {
  const store = new Map<string, any>();
  let reads = 0;
  return {
    store,
    get reads() { return reads; },
    resetReads() { reads = 0; },
    get: async (key: string) => { reads += 1; return store.get(key); },
    set: async (key: string, value: any) => { store.set(key, value); },
    delete: async (key: string) => { store.delete(key); },
    list: async (prefix = '') => Object.fromEntries(
      [...store].filter(([key]) => key.startsWith(prefix)),
    ),
    clear: async () => { store.clear(); },
  };
};

describe('minimal vault authority-kernel prototype', () => {
  test('bounded vault reads project only first-paint gate booleans', async () => {
    const kv = makeKv();
    const vault = createVault({ kv, autoLockMs: 0 });
    expect(await getVaultGateStatus(vault)).toEqual({
      initialized: false, prfEnrolled: false, hasRecovery: false,
    });
    await vault.initializeWithPrfOnly({
      credentialId: new Uint8Array([1, 2, 3]),
      prfSalt: new Uint8Array(32).fill(4),
      prfOutput: new Uint8Array(32).fill(5),
      transports: ['internal'],
    });
    kv.resetReads();
    const status = await getVaultGateStatus(vault);
    expect(status).toEqual({ initialized: true, prfEnrolled: true, hasRecovery: false });
    expect(kv.reads).toBe(2);
    expect(Object.keys(status).sort()).toEqual(['hasRecovery', 'initialized', 'prfEnrolled']);
    expect(JSON.stringify(status)).not.toContain('credential');
    expect(JSON.stringify(status)).not.toContain('salt');
    expect(JSON.stringify(status)).not.toContain('wrapped');
    vault.lock();
  });

  test('first-paint state is explicit about unavailable semantic execution', () => {
    const state = buildVaultKernelState({
      kernel: KERNEL,
      status: { initialized: false, prfEnrolled: false, hasRecovery: false },
      locked: true, unlockedAt: 0, lockReason: null, autoLockMs: 45 * 60_000,
      ...lockedUi,
    });
    expect(state.hydrated).toBe(true);
    expect(state.kernel).toEqual(KERNEL);
    expect(state.vault).toEqual({
      initialized: false, locked: true, unlockedAt: 0,
      prfEnrolled: false, hasRecovery: false, lockReason: null,
    });
    expect(state.capabilities.actorExecution).toEqual({
      status: 'temporarily_unavailable', host: 'offscreen-document-worker',
      reason: 'controller-not-ready', retryable: true,
    });
    expect(state.session.sessionId).toBeNull();
    expect(state.composer).toMatchObject({ canSend: false, reason: 'vault-locked' });
    expect(validateKernelStateProjection(state)).toEqual({ ok: true, state });
    expect(JSON.stringify(state)).not.toMatch(/credentialId|prfSalt|wrappedDK|secret|apiKey/);
  });

  test('unlocked projection remains non-actionable until a controller commits', () => {
    const state = buildVaultKernelState({
      kernel: KERNEL,
      status: { initialized: true, prfEnrolled: true, hasRecovery: false },
      locked: false, unlockedAt: 123, lockReason: null, autoLockMs: 0,
      settings: { vaultAutoLockMs: 0 },
      session: { sessionId: null, messages: [], permission: { mode: 'plan', confirmActions: true } },
      providers: { current: 'anthropic', model: 'claude-sonnet-4-6', hasKey: false },
      composer: { provider: 'anthropic', model: 'claude-sonnet-4-6', keyless: false,
        credentialReady: false, localReady: true, canSend: false, reason: 'missing-key' },
      profile: { id: 'default', peerName: 'peerd', onboardingComplete: false },
    });
    expect(state.vault.locked).toBe(false);
    expect(state.vault.unlockedAt).toBe(123);
    expect(state.composer).toMatchObject({ canSend: false, reason: 'missing-key' });
    expect(state.projection.semanticController).toBe('required');
  });

  test('entry keeps tiny local projections cheaper than their bridge and excludes controller work', async () => {
    const source = readFileSync(join(import.meta.dir, '../../extension/background/vault-kernel.js'), 'utf8');
    const core = readFileSync(join(import.meta.dir, '../../extension/background/vault-kernel-core.js'), 'utf8');
    const composer = readFileSync(join(import.meta.dir, '../../extension/background/kernel-composer-routes.js'), 'utf8');
    const local = readFileSync(join(import.meta.dir, '../../extension/background/kernel-local-routes.js'), 'utf8');
    const utility = readFileSync(join(import.meta.dir, '../../extension/background/kernel-utility-routes.js'), 'utf8');
    for (const route of [
      'vault/prfStatus',
      'vault/initializeWithPasskey', 'vault/initialize',
      'vault/unlock', 'vault/unlockPrf', 'vault/lock',
      'vault/setRecoveryPassphrase', 'vault/enrollPrf', 'vault/disablePrf',
    ]) expect(core).toContain(`'${route}'`);
    expect(source).toContain("'bootstrap/ready'");
    expect(source).toContain('makeSystemReadRoutes');
    expect(source).toContain('applyStoreBootPosture');
    expect(source).toContain('makeWriteGuard');
    expect(source).toContain("import browser from '/shared/browser-api.js'");
    expect(source).toContain('makeKernelGenerationLifecycle');
    expect(source).toContain('createKernelIdentity');
    expect(source).toContain('createKernelColdReceipts');
    expect(source).toContain('coldReceipts.registerRecovery');
    expect(source).toContain('coldReceipts.recover()');
    expect(source).not.toContain('createColdListenerFanIn');
    expect(source).toContain('createKernelFrontDoor');
    expect(source).toContain('createKernelPortRouter');
    expect(source).toContain('createKernelLocalRoutes');
    expect(source).toContain('createKernelAppFileReader');
    expect(source).toContain('makeKernelAppEditorRoutes');
    expect(source).toContain('createKernelSiteClientRoutes');
    expect(source).toContain('makeKernelOpfsPostureRoute');
    expect(source).toContain('makeKernelVmMetaRoute');
    expect(source).toContain('makeKernelVoiceAuditRoute');
    expect(source).not.toContain('kernelLocal.appFiles');
    expect(source).not.toContain('kernelLocal.appEditorRoutes');
    expect(source).not.toContain('kernelLocal.opfsPostureRoute');
    expect(source).not.toContain('kernelLocal.vmMeta');
    expect(source).not.toContain('kernelLocal.siteClients');
    expect(source).not.toContain('kernelLocal.voiceAudit');
    expect(local).not.toContain('createKernelAppFileReader');
    expect(local).not.toContain('createKernelSiteClientRoutes');
    expect(local).not.toContain('makeKernelOpfsPostureRoute');
    expect(local).not.toContain('makeKernelVmMetaRoute');
    expect(local).not.toContain('makeKernelVoiceAuditRoute');
    expect(composer).not.toContain('makeKernelAppEditorRoutes');
    expect(utility).toContain("from './kernel-app-file-reader.js'");
    expect(utility).toContain("from './kernel-site-client-routes.js'");
    expect(source).not.toContain('createKernelSemanticDemand');
    expect(source).toContain('createKernelSemanticRoutes');
    expect(source).toContain('currentVaultKernelAssemblyReport');
    expect(source).toContain('identity: kernelIdentity');
    expect(source).toContain('CONTROLLER_BUILD_DIGEST');
    expect(source).toContain('bindReply: generation.bindCurrent');
    expect(source).toContain("generation.bind({ type: 'state', state })");
    expect(source).not.toContain('globalThis.chrome');
    expect(source).toContain('isFirstPartySender');
    expect(source).toContain('isSidepanelSender');
    expect(source).toContain('isSidepanelPortSender');
    expect(source).toContain('makeVaultKernelMessageHandler');
    expect(core).toContain('humanRoutes.has(message.type) && !humanUi(sender)');
    expect(core).toContain('vault-route-unauthorized-sender');
    expect(core).toContain("'settings/update'");
    const graph = [...await collectStaticModuleGraph(
      EXTENSION_DIR,
      join(EXTENSION_DIR, 'background/vault-kernel.js'),
    )].map((path) => path.slice(EXTENSION_DIR.length + 1));
    expect(graph).toContain('background/routes/toolbox.js');
    expect(graph).toContain('background/kernel-toolbox-store.js');
    expect(graph).not.toContain('peerd-runtime/toolbox/store.js');
    expect(graph).not.toContain('peerd-runtime/toolbox/core.js');
    expect(graph).not.toContain('peerd-runtime/tools/prompt-wrap.js');
    expect(graph).not.toContain('background/context-snapshots.js');
    expect(graph).toContain('background/routes/contacts.js');
    expect(graph).toContain('peerd-runtime/contacts/aggregate.js');
    expect(graph).not.toContain('peerd-runtime/contacts/store.js');
    expect(graph).not.toContain('background/kernel-semantic-demand.js');
    expect(graph).not.toContain('background/semantic-demand-client.js');
    expect(graph).not.toContain('shared/semantic-demand-policy.js');
    expect(graph).toContain('background/kernel-command-reader.js');
    expect(graph).toContain('background/kernel-app-file-reader.js');
    expect(graph).not.toContain('peerd-runtime/skills/registry.js');
    expect(graph).not.toContain('peerd-runtime/skills/store.js');
    expect(graph).not.toContain('background/app-client.js');
    expect(graph).not.toContain('peerd-engine/opfs.js');
    expect(graph).not.toContain('background/offscreen-controller-client.js');
    expect(graph).not.toContain('offscreen/semantic-route-host.js');
    expect(graph).not.toContain('offscreen/controller-runtime.js');
    expect(graph).not.toContain('peerd-runtime/loop/agent-loop.js');
  });
});
