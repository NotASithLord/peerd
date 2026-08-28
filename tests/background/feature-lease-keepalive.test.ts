import { describe, expect, test } from 'bun:test';
import { attachFeatureLeaseKeepalive } from '../../extension/background/feature-lease-keepalive.js';
import { FEATURE_LEASE_HOST_PROTOCOL } from '../../extension/shared/feature-lease-protocol.js';

const IDENTITY = Object.freeze({
  schema: 1 as const,
  buildId: `0.7.3:${'a'.repeat(64)}`,
  bootId: 'boot-feature-keepalive',
  kernelEpoch: 'kernel-feature-keepalive',
});

const event = () => {
  const listeners: Array<(value?: any) => void> = [];
  return {
    addListener(listener: (value?: any) => void) { listeners.push(listener); },
    emit(value?: any) { for (const listener of [...listeners]) listener(value); },
  };
};

const makeHarness = () => {
  const onMessage = event();
  const onDisconnect = event();
  const posted: any[] = [];
  const recovered: string[] = [];
  const authenticated: string[] = [];
  const lost: string[] = [];
  const errors: unknown[] = [];
  const snapshot = {
    ...IDENTITY,
    leases: {
      'model-host': {
        status: 'starting', leaseId: 'lease-model-host', generation: 2,
      },
    },
  };
  attachFeatureLeaseKeepalive({
    port: { onMessage, onDisconnect, postMessage: (value: any) => posted.push(value) },
    identity: IDENTITY,
    featureLeases: {
      snapshot: () => snapshot,
      handleHostLoss: async (hostEpoch: string) => {
        recovered.push(hostEpoch);
        return { hostEpoch, results: [] };
      },
    },
    onAuthenticated: (hostEpoch) => { authenticated.push(hostEpoch); },
    onLost: (hostEpoch) => { lost.push(hostEpoch); },
    onError: (cause) => errors.push(cause),
  });
  const heartbeat = (over: Record<string, any> = {}) => ({
    type: 'feature-lease/heartbeat',
    heartbeatId: 'heartbeat-feature-keepalive',
    protocol: FEATURE_LEASE_HOST_PROTOCOL,
    buildId: IDENTITY.buildId,
    hostEpoch: 'host-feature-keepalive',
    leases: [{
      ...IDENTITY,
      scope: 'model-host',
      hostEpoch: 'host-feature-keepalive',
      leaseId: 'lease-model-host',
      generation: 2,
    }],
    ...over,
  });
  return {
    onMessage, onDisconnect, posted, recovered, authenticated, lost, errors, heartbeat,
  };
};

describe('thin-kernel feature lease keepalive', () => {
  test('authenticates an exact starting generation and recovers it once on disconnect', async () => {
    const harness = makeHarness();
    harness.onMessage.emit(harness.heartbeat());
    expect(harness.posted).toEqual([{
      type: 'feature-lease/heartbeat-ack',
      protocol: FEATURE_LEASE_HOST_PROTOCOL,
      hostEpoch: 'host-feature-keepalive',
      heartbeatId: 'heartbeat-feature-keepalive',
    }]);
    expect(harness.authenticated).toEqual(['host-feature-keepalive']);
    harness.onDisconnect.emit();
    harness.onDisconnect.emit();
    expect(harness.lost).toEqual(['host-feature-keepalive']);
    await Promise.resolve();
    await Promise.resolve();
    expect(harness.recovered).toEqual(['host-feature-keepalive']);
    expect(harness.errors).toEqual([]);
  });

  test('stale build, boot, kernel, lease, and unauthenticated disconnect have no authority', async () => {
    for (const heartbeat of [
      { buildId: `0.7.3:${'b'.repeat(64)}` },
      { heartbeatId: 'short' },
      { leases: [{ ...IDENTITY, bootId: 'boot-stale', scope: 'model-host', hostEpoch: 'host-feature-keepalive', leaseId: 'lease-model-host', generation: 2 }] },
      { leases: [{ ...IDENTITY, kernelEpoch: 'kernel-stale', scope: 'model-host', hostEpoch: 'host-feature-keepalive', leaseId: 'lease-model-host', generation: 2 }] },
      { leases: [{ ...IDENTITY, scope: 'model-host', hostEpoch: 'host-feature-keepalive', leaseId: 'lease-forged', generation: 2 }] },
    ]) {
      const harness = makeHarness();
      harness.onMessage.emit(harness.heartbeat(heartbeat));
      harness.onDisconnect.emit();
      await Promise.resolve();
      expect(harness.posted).toEqual([]);
      expect(harness.recovered).toEqual([]);
      expect(harness.authenticated).toEqual([]);
      expect(harness.lost).toEqual([]);
    }
  });
});
