import { describe, expect, test } from 'bun:test';
import { createKernelPortOwners } from '../../extension/background/kernel-port-owners.js';
import { createKernelPortRouter, KERNEL_PORT_NAMES } from '../../extension/background/kernel-port-router.js';
import { createVaultKernelAssemblyReport } from '../../extension/background/vault-kernel-assembly.js';

const IDENTITY = Object.freeze({
  schema: 1 as const,
  buildId: `0.7.0:${'a'.repeat(64)}`,
  bootId: 'boot-port-owners',
  kernelEpoch: 'epoch-port-owners',
});

const provenance = Object.fromEntries(KERNEL_PORT_NAMES.map((name) => [name, () => true]));
const makePort = (name: string) => {
  let disconnected = 0;
  return {
    name, sender: {},
    get disconnected() { return disconnected; },
    disconnect() { disconnected += 1; },
  };
};

const ownerCalls = () => {
  const calls: string[] = [];
  return {
    calls,
    attachUi: (_port: any, context: any) => { calls.push(`ui:${context.name}`); },
    attachPrivateTransfer: () => { calls.push('private-transfer'); },
    attachFeatureLease: () => { calls.push('feature-lease'); },
    attachDwebCustody: () => { calls.push('dweb-custody'); },
  };
};

describe('target-exact kernel Port owners', () => {
  test('projects exact required owners and fail-closed classes for every target', () => {
    const store = createKernelPortOwners({ ...ownerCalls() });
    expect(store.required).toEqual([
      'sidepanel', 'home', 'eval', 'feature-lease-keepalive',
    ]);
    expect(store.owners).toEqual({
      sidepanel: 'vault-ui-ports', home: 'vault-ui-ports', eval: 'vault-ui-ports',
      'feature-lease-keepalive': 'kernel-feature-host',
    });
    expect(store.readiness).toEqual({
      sidepanel: true, home: true, eval: true, 'feature-lease-keepalive': true,
    });
    expect(store.failClosedPorts).toEqual({
      'private-transfer': 'window-client-transfer-owned-on-chrome',
      'dweb-custody': 'dweb-not-packaged-for-target',
    });
    expect(createVaultKernelAssemblyReport({
      identity: IDENTITY,
      portOwners: store.owners,
      portReadiness: store.readiness,
      failClosedPorts: store.failClosedPorts,
    }).incompletePorts).toEqual([]);

    const preview = createKernelPortOwners({ ...ownerCalls(), dweb: true });
    expect(preview.required).toContain('dweb-custody');
    expect(preview.owners['dweb-custody']).toBe('kernel-dweb-custody');
    expect(preview.failClosedPorts).not.toHaveProperty('dweb-custody');
    expect(createVaultKernelAssemblyReport({
      identity: IDENTITY, selfHostedChrome: true, dweb: true,
      portOwners: preview.owners,
      portReadiness: preview.readiness,
      failClosedPorts: preview.failClosedPorts,
    }).incompletePorts).toEqual([]);

    const firefox = createKernelPortOwners({ ...ownerCalls(), firefox: true });
    expect(firefox.required).toEqual([
      'private-transfer', 'sidepanel', 'home', 'eval',
    ]);
    expect(firefox.owners['private-transfer']).toBe('kernel-private-transfer');
    expect(firefox.failClosedPorts).toEqual({
      'feature-lease-keepalive': 'firefox-background-owns-feature-lifetime',
      'dweb-custody': 'dweb-not-packaged-for-target',
    });
    expect(createVaultKernelAssemblyReport({
      identity: IDENTITY, firefox: true,
      portOwners: firefox.owners,
      portReadiness: firefox.readiness,
      failClosedPorts: firefox.failClosedPorts,
    }).incompletePorts).toEqual([]);
  });

  test('routes only target-present classes and never calls supplied pruned owners', () => {
    const owners = ownerCalls();
    const production = createKernelPortOwners({ ...owners });
    const router = createKernelPortRouter({
      identity: IDENTITY, provenance, handlers: production.handlers,
    });
    for (const name of production.required) {
      expect(router.route(makePort(name))).toMatchObject({ accepted: true, name });
    }
    const privateTransfer = makePort('private-transfer');
    const dweb = makePort('dweb-custody');
    expect(router.route(privateTransfer)).toMatchObject({
      accepted: false, reason: 'owner-unavailable',
    });
    expect(router.route(dweb)).toMatchObject({
      accepted: false, reason: 'owner-unavailable',
    });
    expect(privateTransfer.disconnected).toBe(1);
    expect(dweb.disconnected).toBe(1);
    expect(owners.calls).toEqual([
      'ui:sidepanel', 'ui:home', 'ui:eval', 'feature-lease',
    ]);
  });

  test('rejects missing required owners and asynchronous custody', () => {
    expect(() => createKernelPortOwners({
      attachUi: () => {},
    })).toThrow('kernel-port-owners-config-invalid');
    expect(() => createKernelPortOwners({
      firefox: true, attachUi: () => {},
    })).toThrow('kernel-port-owners-config-invalid');
    expect(() => createKernelPortOwners({
      dweb: true, attachUi: () => {}, attachFeatureLease: () => {},
    })).toThrow('kernel-port-owners-config-invalid');

    const production = createKernelPortOwners({
      attachUi: async () => {}, attachFeatureLease: () => {},
    });
    const router = createKernelPortRouter({
      identity: IDENTITY, provenance, handlers: production.handlers,
    });
    const port = makePort('sidepanel');
    expect(router.route(port)).toEqual({
      accepted: false, name: 'sidepanel', reason: 'owner-failed',
    });
    // Both the ownership boundary and router fail closed; disconnect is idempotent
    // at the browser API even though this test double counts both calls.
    expect(port.disconnected).toBe(2);
  });
});
