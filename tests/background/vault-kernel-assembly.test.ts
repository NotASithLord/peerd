import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { collectStaticModuleGraph } from '../../packaging/static-module-graph.ts';
import { EXTENSION_DIR } from '../../packaging/lib.ts';
import {
  createKernelPortRouter,
  KERNEL_PORT_NAMES,
} from '../../extension/background/kernel-port-owners.js';
import {
  createVaultKernelAssemblyReport,
} from '../../extension/background/vault-kernel-assembly.js';
import {
  coldPortNamesFor,
  KERNEL_COLD_EVENTS,
  KERNEL_PORT_CLASSES,
} from '../../extension/background/cold-kernel-inventory.js';

const IDENTITY = Object.freeze({
  schema: 1 as const,
  buildId: `0.7.0:${'a'.repeat(64)}`,
  bootId: 'boot-vault-assembly',
  kernelEpoch: 'kernel-vault-assembly',
});

const makePort = (name: string, senderClass = name) => {
  let disconnected = 0;
  return {
    name,
    sender: { senderClass },
    get disconnected() { return disconnected; },
    disconnect() { disconnected += 1; },
  };
};

describe('thin vault-kernel Port assembly', () => {
  test('routes exactly six names through their own provenance and owner', () => {
    expect(KERNEL_PORT_NAMES).toEqual(KERNEL_PORT_CLASSES.map((entry) => entry.name));
    expect(KERNEL_PORT_NAMES).toHaveLength(6);
    const proven: string[] = [];
    const handled: string[] = [];
    const contexts: any[] = [];
    const provenance = Object.fromEntries(KERNEL_PORT_NAMES.map((name) => [
      name,
      (sender: any) => {
        proven.push(name);
        return sender?.senderClass === name;
      },
    ]));
    const handlers = Object.fromEntries(KERNEL_PORT_NAMES.map((name) => [
      name,
      (_port: any, context: any) => {
        handled.push(name);
        contexts.push(context);
      },
    ]));
    const router = createKernelPortRouter({ identity: IDENTITY, provenance, handlers });
    for (const name of KERNEL_PORT_NAMES) {
      const port = makePort(name);
      expect(router.route(port)).toEqual({ accepted: true, name, reason: null });
      expect(port.disconnected).toBe(0);
    }
    expect(proven).toEqual([...KERNEL_PORT_NAMES]);
    expect(handled).toEqual([...KERNEL_PORT_NAMES]);
    expect(contexts.every((context) => context.identity === router.identity)).toBe(true);
    expect(contexts.map((context) => context.name)).toEqual([...KERNEL_PORT_NAMES]);
  });

  test('fails closed for forged, unknown, unavailable, throwing, and rejected owners', async () => {
    const provenance = Object.fromEntries(KERNEL_PORT_NAMES.map((name) => [
      name, (sender: any) => sender?.senderClass === name,
    ]));
    const rejected = makePort('home');
    const router = createKernelPortRouter({
      identity: IDENTITY,
      provenance,
      handlers: {
        sidepanel: () => {},
        home: async () => { throw new Error('late owner loss'); },
      },
    });
    const forged = makePort('sidepanel', 'home');
    expect(router.route(forged)).toMatchObject({
      accepted: false, reason: 'provenance-refused',
    });
    expect(forged.disconnected).toBe(1);
    const unavailable = makePort('feature-lease-keepalive');
    expect(router.route(unavailable)).toMatchObject({
      accepted: false, reason: 'owner-unavailable',
    });
    expect(unavailable.disconnected).toBe(1);
    const unknown = makePort('invented-port');
    expect(router.route(unknown)).toMatchObject({ accepted: false, reason: 'unknown-port' });
    expect(unknown.disconnected).toBe(1);
    expect(router.route(rejected)).toMatchObject({ accepted: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rejected.disconnected).toBe(1);
  });

  test('requires one explicit predicate per class and rejects handler aliases', () => {
    expect(() => createKernelPortRouter({
      identity: IDENTITY, provenance: {}, handlers: {},
    })).toThrow('kernel-port-provenance-incomplete');
    const provenance = Object.fromEntries(KERNEL_PORT_NAMES.map((name) => [name, () => true]));
    expect(() => createKernelPortRouter({
      identity: IDENTITY, provenance, handlers: { invented: () => {} },
    })).toThrow('kernel-port-handler-invalid');
    expect(() => createKernelPortRouter({
      identity: { ...IDENTITY, bootId: IDENTITY.kernelEpoch }, provenance, handlers: {},
    } as any)).toThrow('kernel-port-identity-invalid');
    const source = readFileSync(
      join(EXTENSION_DIR, 'background/kernel-port-owners.js'), 'utf8',
    );
    expect(source).not.toContain('adoptPort');
  });
});

describe('executable vault-kernel cutover report', () => {
  test('reports update-event readiness only for the target that attaches that listener', () => {
    const source = readFileSync(join(
      import.meta.dir, '..', '..', 'extension', 'background', 'vault-kernel.js',
    ), 'utf8');
    expect(source).toContain(
      "'runtime.onUpdateAvailable': kernelSelfHostedChrome && !!kernelUpdateCustody",
    );
  });
  test('inventories all events and Ports but defaults every executable owner fail-closed', () => {
    const store = createVaultKernelAssemblyReport({ identity: IDENTITY });
    expect(store.events.map((entry) => entry.key))
      .toEqual(KERNEL_COLD_EVENTS.map((entry) => entry.key));
    expect(store.ports.map((entry) => entry.name))
      .toEqual(KERNEL_PORT_CLASSES.map((entry) => entry.name));
    expect(store.counts).toEqual({
      eventInventory: 16,
      requiredEvents: 13,
      ownedRequiredEvents: 0,
      portInventory: 6,
      requiredPorts: 4,
      ownedRequiredPorts: 0,
    });
    expect(store.missingRequiredEvents).toHaveLength(13);
    expect(store.events.filter((entry) => entry.owner === 'kernel-front-door')
      .map((entry) => entry.key)).toEqual([
      'windows.onFocusChanged', 'action.onClicked', 'commands.onCommand',
    ]);
    expect(store.incompletePorts).toEqual([
      'sidepanel', 'home', 'eval', 'feature-lease-keepalive',
    ]);
    expect(store.cutoverReady).toBe(false);

    const partial = createVaultKernelAssemblyReport({
      identity: IDENTITY,
      eventOwners: { 'runtime.onMessage': 'kernel-message-router' },
      eventReadiness: { 'runtime.onMessage': false },
      portOwners: {}, failClosedPorts: {},
    });
    expect(partial.events.find((entry) => entry.key === 'runtime.onMessage'))
      .toMatchObject({ status: 'partial', owner: 'kernel-message-router' });
    expect(partial.missingRequiredEvents).toContain('runtime.onMessage');

    const firefox = createVaultKernelAssemblyReport({ identity: IDENTITY, firefox: true });
    const preview = createVaultKernelAssemblyReport({
      identity: IDENTITY, selfHostedChrome: true,
    });
    expect(firefox.counts.requiredEvents).toBe(15);
    expect(firefox.counts.ownedRequiredEvents).toBe(0);
    expect(firefox.counts.requiredPorts).toBe(4);
    expect(firefox.counts.ownedRequiredPorts).toBe(0);
    expect(firefox.incompletePorts).toEqual([
      'private-transfer', 'sidepanel', 'home', 'eval',
    ]);
    expect(firefox.missingRequiredEvents).toContain('webRequest.onBeforeRequest');
    expect(preview.counts.requiredPorts).toBe(5);
    expect(preview.incompletePorts).toEqual([
      'sidepanel', 'home', 'eval', 'feature-lease-keepalive', 'dweb-custody',
    ]);
    expect(preview.counts.requiredEvents).toBe(14);
    expect(preview.counts.ownedRequiredEvents).toBe(0);
    expect(preview.missingRequiredEvents).toContain('runtime.onUpdateAvailable');
    expect(firefox.cutoverReady).toBe(false);
    expect(preview.cutoverReady).toBe(false);
  });

  test('becomes ready only with every target event and every Port owned', () => {
    const eventOwners = Object.fromEntries(
      KERNEL_COLD_EVENTS.map((entry) => [entry.key, `owner:${entry.key}`]),
    );
    const eventReadiness = Object.fromEntries(
      KERNEL_COLD_EVENTS.map((entry) => [entry.key, true]),
    );
    const portOwners = Object.fromEntries(
      KERNEL_PORT_CLASSES.map((entry) => [entry.name, `owner:${entry.name}`]),
    );
    const complete = createVaultKernelAssemblyReport({
      identity: IDENTITY, firefox: true, selfHostedChrome: true,
      eventOwners, eventReadiness, portOwners, failClosedPorts: {},
      portReadiness: Object.fromEntries(
        KERNEL_PORT_CLASSES.map((entry) => [entry.name, true]),
      ),
    });
    expect(complete.counts).toEqual({
      eventInventory: 16,
      requiredEvents: 16,
      ownedRequiredEvents: 16,
      portInventory: 6,
      requiredPorts: 4,
      ownedRequiredPorts: 4,
    });
    expect(complete.cutoverReady).toBe(true);
    expect(() => createVaultKernelAssemblyReport({
      identity: IDENTITY,
      portOwners: { sidepanel: 'owner:sidepanel' },
      failClosedPorts: { sidepanel: 'still-fail-closed' },
    })).toThrow('vault-kernel-port-owner-overlap');
    expect(() => createVaultKernelAssemblyReport({
      identity: IDENTITY, eventReadiness: { invented: true },
    } as any)).toThrow('vault-kernel-event-readiness-invalid');
    expect(() => createVaultKernelAssemblyReport({
      identity: IDENTITY, portReadiness: { invented: true },
    } as any)).toThrow('vault-kernel-port-readiness-invalid');
  });

  test('requires only the Port classes physically present in each target', () => {
    expect(coldPortNamesFor()).toEqual([
      'sidepanel', 'home', 'eval', 'feature-lease-keepalive',
    ]);
    expect(coldPortNamesFor({ firefox: true })).toEqual([
      'private-transfer', 'sidepanel', 'home', 'eval',
    ]);
    expect(coldPortNamesFor({ dweb: true })).toEqual([
      'sidepanel', 'home', 'eval', 'feature-lease-keepalive', 'dweb-custody',
    ]);
  });
});

test('native entry uses one identity and target-exact kernel custody', async () => {
  const entry = join(EXTENSION_DIR, 'background/vault-kernel.js');
  const source = readFileSync(entry, 'utf8');
  expect(source.match(/createKernelIdentity\s*\(/g)).toHaveLength(1);
  expect(source).toContain('identity: kernelIdentity');
  expect(source).toContain('kernelIdentity,');
  expect(source).toContain("'runtime.onMessage', browser.runtime.onMessage");
  expect(source).toContain("'runtime.onConnect', browser.runtime.onConnect");
  expect(source).toContain('eventOwners: kernelEvents.owners()');
  expect(source).toContain('SEMANTIC_CUTOVER_SUMMARY.ready');
  expect(source).toContain('semantic: SEMANTIC_CUTOVER_SUMMARY');
  expect(source).toContain('attachKernelFrontDoor');
  expect(source).toContain('const kernelEvents = coldReceipts');
  expect(source).toContain('createKernelColdReceipts');
  expect(source).toContain('coldReceipts.registerRecovery');
  expect(source).toContain('createKernelFeatureHost');
  expect(source).toContain('attachKernelTabEvents({');
  expect(source).toContain('firefox: kernelFirefox');
  expect(source).not.toContain('onBeforeRequest: () => ({})');
  expect(source).toContain('attachFeatureLease: featureHost.handleKeepalive');
  expect(source).toContain('attachUi: uiPortOwner.attach');
  expect(source).not.toContain('browser.runtime.onMessage.addListener');
  expect(source).not.toContain('browser.runtime.onConnect.addListener');
  expect(source).toContain('await vaultReady; return kv.get(key)');
  expect(source).toContain('await vaultReady; await kv.set(key, value)');
  expect(source).toContain('createVaultKernelAssemblyReport');
  expect(source).not.toContain('export const vaultKernelAssembly');
  expect(source).toContain('assembly: assemblyReport()');
  expect(source).not.toContain('adoptPort');

  const graph = await collectStaticModuleGraph(EXTENSION_DIR, entry);
  const modules = [...graph].map((file) => relative(EXTENSION_DIR, file)).sort();
  expect(modules).toContain('background/cold-kernel-inventory.js');
  expect(modules).toContain('background/kernel-cold-receipts.js');
  expect(modules).not.toContain('background/kernel-recovery-registry.js');
  expect(modules).not.toContain('background/cold-listener-fan-in.js');
  expect(modules).not.toContain('background/cold-kernel-capture.js');
  expect(modules).not.toContain('background/kernel-port-router.js');
  expect(modules).toContain('background/kernel-port-owners.js');
  expect(modules).toContain('background/kernel-front-door.js');
  expect(modules).not.toContain('background/kernel-event-registry.js');
  expect(modules).toContain('background/kernel-feature-host.js');
  expect(modules).toContain('background/vault-kernel-assembly.js');
  expect(modules).not.toContain('background/service-worker.js');
  expect(modules.some((module) => module.startsWith('offscreen/'))).toBe(false);
  expect(modules.some((module) => /controller-(?:worker|runtime|shell)/.test(module))).toBe(false);

});
