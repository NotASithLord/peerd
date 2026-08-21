import { describe, expect, test } from 'bun:test';
import {
  createOffscreenFeatureLeaseHost,
  FEATURE_LEASE_HOST_PROTOCOL,
  FEATURE_LEASE_KEEPALIVE_PORT,
} from '../../extension/offscreen/feature-lease-host.js';

const BUILD = `0.7.0:${'a'.repeat(64)}`;

const event = () => {
  const listeners: ((value?: any) => void)[] = [];
  return {
    addListener(fn: (value?: any) => void) { listeners.push(fn); },
    fire(value?: any) { for (const listener of [...listeners]) listener(value); },
  };
};

const makePort = (autoAck = true) => {
  const onMessage = event();
  const onDisconnect = event();
  const sent: any[] = [];
  let disconnected = false;
  let acknowledge = autoAck;
  return {
    name: FEATURE_LEASE_KEEPALIVE_PORT,
    onMessage,
    onDisconnect,
    sent,
    postMessage(message: any) {
      sent.push(structuredClone(message));
      if (acknowledge && message?.type === 'feature-lease/heartbeat') {
        queueMicrotask(() => onMessage.fire({
          type: 'feature-lease/heartbeat-ack',
          protocol: FEATURE_LEASE_HOST_PROTOCOL,
          hostEpoch: message.hostEpoch,
          heartbeatId: message.heartbeatId,
        }));
      }
    },
    disconnect() { disconnected = true; onDisconnect.fire(); },
    setAutoAck(value: boolean) { acknowledge = value; },
    get disconnected() { return disconnected; },
  };
};

const lease = (scope: string, over: Record<string, any> = {}) => ({
  scope,
  leaseId: `lease-${scope}-aaaa`,
  generation: 1,
  buildId: BUILD,
  kernelEpoch: 'kernel-epoch-aaaa',
  hostEpoch: 'host-epoch-aaaaaa',
  ...over,
});

const setup = (options: { autoAck?: boolean, stopScope?: (scope: string, value: any) => any } = {}) => {
  const ports: ReturnType<typeof makePort>[] = [];
  const started: any[] = [];
  const stopped: any[] = [];
  const adopted: any[] = [];
  const intervals: (() => void)[] = [];
  const reconnects: (() => void)[] = [];
  const heartbeatTimeouts: (() => void)[] = [];
  const host = createOffscreenFeatureLeaseHost({
    expectedBuildId: BUILD,
    newId: () => 'host-epoch-aaaaaa',
    startScope: async (scope, value) => { started.push({ scope, value }); return { started: scope }; },
    stopScope: async (scope, value) => {
      stopped.push({ scope, value });
      return options.stopScope ? options.stopScope(scope, value) : { stopped: scope };
    },
    adoptScope: async (scope, prior, next) => {
      adopted.push({ scope, prior, next });
      return { adopted: scope };
    },
    connectPort: () => {
      const port = makePort(options.autoAck !== false);
      ports.push(port);
      return port as any;
    },
    setIntervalFn: ((fn: () => void) => { intervals.push(fn); return intervals.length; }) as any,
    clearIntervalFn: (() => {}) as any,
    setTimeoutFn: ((fn: () => void, ms?: number) => {
      if (ms === 500) reconnects.push(fn);
      if (ms === 2_000) heartbeatTimeouts.push(fn);
      return reconnects.length + 1;
    }) as any,
    clearTimeoutFn: (() => {}) as any,
  });
  const message = (type: string, value?: any) => host.handleMessage({
    type,
    protocol: FEATURE_LEASE_HOST_PROTOCOL,
    ...(value ? { lease: value } : {}),
  });
  return {
    host, message, ports, started, stopped, adopted, intervals, reconnects,
    heartbeatTimeouts,
  };
};

describe('offscreen feature-lease host', () => {
  test('has no port or heartbeat before an exact lease and tears both down after the last stop', async () => {
    const h = setup();
    expect(h.host.snapshot().leases).toEqual([]);
    expect(h.ports).toEqual([]);

    const current = lease('controller');
    expect(await h.message('feature-lease/host-start', current)).toMatchObject({
      ok: true, active: true, ...current,
    });
    expect(h.started).toHaveLength(1);
    expect(h.ports).toHaveLength(1);
    expect(h.ports[0].sent[0]).toMatchObject({
      type: 'feature-lease/heartbeat',
      protocol: FEATURE_LEASE_HOST_PROTOCOL,
      hostEpoch: current.hostEpoch,
      leases: [expect.objectContaining(current)],
    });

    expect(await h.message('feature-lease/host-start', current)).toMatchObject({
      ok: true, active: true, coalesced: true,
    });
    expect(h.started).toHaveLength(1);
    expect(await h.message('feature-lease/host-stop', current)).toMatchObject({
      ok: true, active: false,
    });
    expect(h.stopped).toHaveLength(1);
    expect(h.ports[0].disconnected).toBe(true);
    expect(h.host.snapshot().leases).toEqual([]);
  });

  test('never publishes an active receipt before the exact heartbeat is acknowledged', async () => {
    const h = setup({ autoAck: false });
    const current = lease('dweb');
    let settled = false;
    const starting = h.message('feature-lease/host-start', current)
      .then((value) => { settled = true; return value; });
    while (h.ports.length === 0 || h.ports[0].sent.length === 0) await Promise.resolve();
    expect(settled).toBe(false);
    const heartbeat = h.ports[0].sent.at(-1);
    h.ports[0].onMessage.fire({
      type: 'feature-lease/heartbeat-ack',
      protocol: FEATURE_LEASE_HOST_PROTOCOL,
      hostEpoch: current.hostEpoch,
      heartbeatId: 'stale-heartbeat-id',
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    h.ports[0].onMessage.fire({
      type: 'feature-lease/heartbeat-ack',
      protocol: FEATURE_LEASE_HOST_PROTOCOL,
      hostEpoch: current.hostEpoch,
      heartbeatId: heartbeat.heartbeatId,
    });
    expect(await starting).toMatchObject({ ok: true, active: true, ...current });
  });

  test('a renderer crash before first heartbeat acknowledgement cannot strand a durable lease', async () => {
    const h = setup({ autoAck: false });
    const current = lease('dweb');
    const starting = h.message('feature-lease/host-start', current);
    while (h.ports.length === 0 || h.ports[0].sent.length === 0) await Promise.resolve();
    h.ports[0].onDisconnect.fire();
    const result = await starting;
    expect(result).toMatchObject({ ok: false, scope: 'dweb' });
    expect(h.host.isActive('dweb')).toBe(false);
    expect(h.stopped).toEqual([
      expect.objectContaining({ scope: 'dweb' }),
    ]);
  });

  test('a frozen kernel that misses a periodic heartbeat retires bounded custody', async () => {
    const h = setup();
    const current = lease('controller');
    expect(await h.message('feature-lease/host-start', current)).toMatchObject({ ok: true });
    h.ports[0].setAutoAck(false);
    const priorHeartbeats = h.ports[0].sent.length;
    const priorTimeouts = h.heartbeatTimeouts.length;
    h.intervals[0]();
    await Promise.resolve();
    expect(h.ports[0].sent.length).toBe(priorHeartbeats + 1);
    expect(h.heartbeatTimeouts.length).toBe(priorTimeouts + 1);
    h.heartbeatTimeouts.at(-1)?.();
    for (let turn = 0; turn < 10 && h.host.isActive('controller'); turn += 1) {
      await Promise.resolve();
    }
    expect(h.host.isActive('controller')).toBe(false);
    expect(h.ports[0].disconnected).toBe(true);
    expect(h.stopped).toEqual([
      expect.objectContaining({ scope: 'controller', value: expect.objectContaining({
        reason: 'kernel-heartbeat-unacknowledged',
      }) }),
    ]);
  });

  test('a lost periodic ACK disconnects its exact Port and a late old packet cannot retire the successor', async () => {
    const h = setup();
    const current = lease('dweb', { schema: 1, bootId: 'boot-dweb-a' });
    expect(await h.message('feature-lease/host-start', current)).toMatchObject({ ok: true });
    h.ports[0].setAutoAck(false);
    h.intervals[0]();
    await Promise.resolve();
    const lostHeartbeat = h.ports[0].sent.at(-1);
    h.heartbeatTimeouts.at(-1)?.();
    await Promise.resolve();
    expect(h.ports[0].disconnected).toBe(true);
    expect(h.host.snapshot().leases).toEqual([
      expect.objectContaining({ scope: 'dweb', orphaned: true }),
    ]);
    expect(h.host.requireActive('dweb')).toMatchObject({
      ok: false, error: 'feature-lease-required', scope: 'dweb',
    });

    h.reconnects.at(-1)?.();
    await Promise.resolve();
    expect(h.ports).toHaveLength(2);
    const successor = lease('dweb', {
      schema: 1,
      bootId: 'boot-dweb-b',
      kernelEpoch: 'kernel-epoch-bbbb',
      leaseId: 'lease-dweb-bbbb',
      generation: 2,
    });
    expect(await h.message('feature-lease/host-start', successor)).toMatchObject({
      ok: true, adopted: true,
    });
    expect(h.host.requireActive('dweb')).toBeNull();

    // Both the reordered ACK and duplicate disconnect belong to the retired
    // Port and cannot orphan the lease adopted through Port generation two.
    h.ports[0].onMessage.fire({
      type: 'feature-lease/heartbeat-ack',
      protocol: FEATURE_LEASE_HOST_PROTOCOL,
      hostEpoch: current.hostEpoch,
      heartbeatId: lostHeartbeat.heartbeatId,
    });
    h.ports[0].onDisconnect.fire();
    expect(h.host.snapshot().leases).toEqual([
      expect.objectContaining({ ...successor, orphaned: false }),
    ]);
  });

  test('heartbeat loss retires bounded custody even when physical scope teardown never settles', async () => {
    const h = setup({ stopScope: () => new Promise(() => {}) });
    const current = lease('controller');
    expect(await h.message('feature-lease/host-start', current)).toMatchObject({ ok: true });
    h.ports[0].setAutoAck(false);
    h.intervals[0]();
    await Promise.resolve();
    h.heartbeatTimeouts.at(-1)?.();
    await Promise.resolve();
    expect(h.host.isActive('controller')).toBe(false);
    expect(h.ports[0].disconnected).toBe(true);
    expect(h.reconnects).toEqual([]);
  });

  test('schema/build/host and stale-stop forgeries cannot change active authority', async () => {
    const h = setup();
    const current = lease('dweb');
    expect(await h.host.handleMessage({ type: 'feature-lease/host-status', protocol: 9 }))
      .toMatchObject({ ok: false, error: 'feature-lease-host-protocol-invalid' });
    for (const forged of [
      { ...current, buildId: `0.7.1:${'b'.repeat(64)}` },
      { ...current, hostEpoch: 'host-epoch-forged' },
      { ...current, leaseId: 'short' },
    ]) {
      expect(await h.message('feature-lease/host-start', forged)).toMatchObject({ ok: false });
    }
    expect(h.started).toEqual([]);

    await h.message('feature-lease/host-start', current);
    expect(await h.message('feature-lease/host-stop', {
      ...current, leaseId: 'lease-dweb-stale', generation: 2,
    })).toMatchObject({ ok: false, error: 'feature-lease-host-stop-stale' });
    expect(h.host.isActive('dweb')).toBe(true);
    expect(h.stopped).toEqual([]);
  });

  test('kernel-port loss adopts only durable dweb and drops every bounded host', async () => {
    const h = setup();
    for (const scope of [
      'controller', 'dweb', 'dom-host', 'media-host', 'model-host', 'vault-authority',
    ]) {
      await h.message('feature-lease/host-start', lease(scope));
    }
    expect(h.started.map((entry) => entry.scope)).toEqual([
      'controller', 'dweb', 'dom-host', 'media-host', 'model-host',
      'vault-authority',
    ]);
    h.ports[0].onDisconnect.fire();
    await Promise.resolve();
    expect(h.host.snapshot().leases).toEqual([
      expect.objectContaining({ scope: 'dweb', orphaned: true }),
    ]);
    expect(h.stopped.map((entry) => entry.scope).sort()).toEqual([
      'controller', 'dom-host', 'media-host', 'model-host',
      'vault-authority',
    ]);
    expect(h.reconnects).toHaveLength(1);
    h.reconnects[0]();
    expect(h.ports).toHaveLength(2);

    const dwebNext = lease('dweb', {
      leaseId: 'lease-dweb-next', generation: 2, kernelEpoch: 'kernel-epoch-next',
    });
    expect(await h.message('feature-lease/host-start', dwebNext))
      .toMatchObject({ ok: true, adopted: true });
    expect(h.ports[1].sent.at(-1)?.leases).toEqual(expect.arrayContaining([
      expect.objectContaining(dwebNext),
    ]));
    expect(h.adopted.map((entry) => entry.scope)).toEqual(['dweb']);
    expect(h.started).toHaveLength(6);
    expect(h.host.snapshot().leases).toEqual([
      expect.objectContaining({ ...dwebNext, orphaned: false }),
    ]);
  });

  test('strict adoption requires a fresh bootId and kernelEpoch from the same build', async () => {
    const h = setup();
    const current = lease('dweb', {
      schema: 1, bootId: 'boot-dweb-a',
    });
    await h.message('feature-lease/host-start', current);
    h.ports[0].onDisconnect.fire();
    await Promise.resolve();

    expect(await h.message('feature-lease/host-start', {
      ...current,
      leaseId: 'lease-dweb-forged', generation: 2,
      kernelEpoch: 'kernel-dweb-b',
    })).toMatchObject({ ok: false, error: 'feature-lease-host-conflict' });
    expect(h.adopted).toEqual([]);

    const successor = {
      ...current,
      leaseId: 'lease-dweb-next', generation: 2,
      bootId: 'boot-dweb-b', kernelEpoch: 'kernel-dweb-b',
    };
    expect(await h.message('feature-lease/host-start', successor))
      .toMatchObject({ ok: true, adopted: true });
    expect(h.adopted).toHaveLength(1);
  });

  test('a live scope refuses overlapping kernel/lease ownership', async () => {
    const h = setup();
    await h.message('feature-lease/host-start', lease('dweb'));
    expect(await h.message('feature-lease/host-start', lease('dweb', {
      leaseId: 'lease-dweb-other', generation: 2, kernelEpoch: 'kernel-epoch-other',
    }))).toMatchObject({
      ok: false,
      error: 'feature-lease-host-conflict',
      activeKernelEpoch: 'kernel-epoch-aaaa',
    });
    expect(h.started).toHaveLength(1);
  });

  test('host replacement changes epoch and refuses delayed packets from the prior realm', async () => {
    const first = setup();
    const old = lease('controller');
    await first.message('feature-lease/host-start', old);
    await first.host.close();

    const secondPorts: ReturnType<typeof makePort>[] = [];
    const second = createOffscreenFeatureLeaseHost({
      expectedBuildId: BUILD,
      newId: () => 'host-epoch-bbbbbb',
      startScope: async () => ({}),
      stopScope: async () => ({}),
      connectPort: () => {
        const port = makePort();
        secondPorts.push(port);
        return port as any;
      },
    });
    expect(await second.handleMessage({
      type: 'feature-lease/host-start', protocol: FEATURE_LEASE_HOST_PROTOCOL, lease: old,
    })).toMatchObject({ ok: false, error: 'feature-lease-host-binding-invalid' });
    expect(secondPorts).toEqual([]);
  });

  test('failed start stays dormant and failed stop retains exact custody for retry', async () => {
    const ports: ReturnType<typeof makePort>[] = [];
    let failStart = true;
    let failStop = true;
    const host = createOffscreenFeatureLeaseHost({
      expectedBuildId: BUILD,
      newId: () => 'host-epoch-aaaaaa',
      startScope: async () => {
        if (failStart) throw new Error('start-failed');
        return {};
      },
      stopScope: async () => {
        if (failStop) throw new Error('stop-failed');
        return {};
      },
      connectPort: () => {
        const port = makePort();
        ports.push(port);
        return port as any;
      },
    });
    const current = lease('media-host');
    expect(await host.handleMessage({
      type: 'feature-lease/host-start', protocol: FEATURE_LEASE_HOST_PROTOCOL, lease: current,
    })).toMatchObject({ ok: false, error: 'feature-lease-host-start-failed' });
    expect(host.snapshot().leases).toEqual([]);
    expect(ports).toEqual([]);

    failStart = false;
    expect(await host.handleMessage({
      type: 'feature-lease/host-start', protocol: FEATURE_LEASE_HOST_PROTOCOL, lease: current,
    })).toMatchObject({ ok: true });
    expect(await host.handleMessage({
      type: 'feature-lease/host-stop', protocol: FEATURE_LEASE_HOST_PROTOCOL, lease: current,
    })).toMatchObject({ ok: false, error: 'feature-lease-host-stop-failed' });
    expect(host.snapshot().leases).toEqual([expect.objectContaining(current)]);
    expect(ports[0].disconnected).toBe(false);

    failStop = false;
    expect(await host.handleMessage({
      type: 'feature-lease/host-stop', protocol: FEATURE_LEASE_HOST_PROTOCOL, lease: current,
    })).toMatchObject({ ok: true, active: false });
    expect(host.snapshot().leases).toEqual([]);
  });
});
