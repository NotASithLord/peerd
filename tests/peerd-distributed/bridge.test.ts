import { describe, test, expect } from 'bun:test';
import { createDwebBridge } from '../../extension/peerd-distributed/apps/bridge.js';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
};
const CLIENT = 'client-epoch-0001';
const rpc = (id: string, op: string, args: any = {}, clientId = CLIENT) => ({
  peerd: 'dweb', id, clientId, op, args,
});

// A mock transport — the seam the iframe-decoupling opened up. `drive` feeds an
// op in (as the dwapp would); `sent` captures everything the bridge posts back.
const mockTransport = () => {
  const sent: any[] = [];
  let handler: ((m: any) => void) | null = null;
  return {
    sent,
    transport: { send: (m: any) => sent.push(m), onMessage: (h: any) => { handler = h; return () => { handler = null; }; } },
    drive: (m: any) => handler?.(m),
    hasHandler: () => handler !== null,
    results: () => sent.filter((m) => m.peerd === 'dweb:result'),
    events: () => sent.filter((m) => m.peerd === 'dweb:event'),
  };
};

// The bridge now talks to the offscreen base host over swCall('dweb/base/room')
// and receives pushed room events via onHostEvent — no in-page room host, no
// identity minting, no signaler. The fakes below stand in for that host.
const makeBridge = ({ confirm = true, joinHost, leaveHost, appDweb = { seed: 'commons' }, currentDweb = appDweb, storage = { get: async () => ({}), set: async () => {} } }: {
  confirm?: boolean | ((request: any) => boolean | Promise<boolean>),
  joinHost?: (payload: any) => Promise<any>,
  leaveHost?: (payload: any) => Promise<any>,
  appDweb?: any,
  currentDweb?: any,
  storage?: { get: (key: any) => Promise<any>, set: (value: any) => Promise<void> },
} = {}) => {
  const mt = mockTransport();
  const calls: any[] = [];
  const confirmations: any[] = [];
  let pushEvent: ((m: any) => void) | null = null;
  const swCall = async (type: string, payload: any = {}) => {
    if (type === 'app/get-meta') return { ok: true, dweb: currentDweb };
    if (type !== 'dweb/base/room') return { ok: true };
    calls.push(payload);
    switch (payload.op) {
      case 'join': return joinHost
        ? joinHost(payload)
        : { ok: true, did: 'did:key:zME', joined: payload.roomId, present: [] };
      case 'publish': return { ok: true, id: 'e1', ts: 1 };
      case 'dm': return { ok: true, id: 'd1', ts: 2 };
      case 'presence': return { ok: true, present: [{ did: 'did:key:zBOB', meta: { name: 'bob' } }] };
      case 'history': return { ok: true, items: [] };
      case 'leave': return leaveHost ? leaveHost(payload) : { ok: true, left: true };
      case 'publish-app': return { ok: true, uri: 'peerd://bundle', hash: 'hash' };
      default: return { ok: true };
    }
  };
  const bridge = createDwebBridge({
    appId: 'commons', appName: 'commons', appDweb, entryFile: 'index.html',
    transport: mt.transport,
    swCall,
    storage,
    confirmAction: async (request: any) => {
      confirmations.push(request);
      return typeof confirm === 'function' ? confirm(request) : confirm;
    },
    onHostEvent: (h: any) => { pushEvent = h; return () => { pushEvent = null; }; },
    launch: {},
  });
  return { mt, bridge, calls, confirmations, push: (m: any) => pushEvent?.(m) };
};

describe('dwapp bridge (base-network rooms, transport-agnostic)', () => {
  test('hello replies over the injected transport', async () => {
    const { mt } = makeBridge();
    mt.drive(rpc('request-0001', 'hello'));
    await tick();
    const [r] = mt.results();
    expect(r).toMatchObject({ peerd: 'dweb:result', id: 'request-0001', clientId: CLIENT, ok: true });
    expect(r.value).toMatchObject({ available: true, app: 'commons', joined: null });
  });

  test('join → publish relays room ops over swCall', async () => {
    const { mt, bridge, calls } = makeBridge({ appDweb: { seed: 'commons', generation: 7 } });
    mt.drive(rpc('request-0001', 'join', { roomId: 'peerd-global', name: 'ada' }));
    await tick();
    expect(mt.results().find((r) => r.id === 'request-0001')).toMatchObject({ ok: true, value: { joined: 'peerd-global', did: 'did:key:zME' } });

    mt.drive(rpc('request-0002', 'publish', { topic: 'feed', data: { text: 'hi' } }));
    await tick();
    expect(calls.find((c) => c.op === 'publish')).toMatchObject({ roomId: 'peerd-global', topic: 'feed', data: { text: 'hi' } });
    await bridge.dispose();
    await tick();
    mt.drive(rpc('request-0003', 'publish', { topic: 'feed', data: { text: 'late' } }));
    await tick();
    expect(calls.filter((call) => call.op === 'publish')).toHaveLength(1);
    expect(calls.filter((call) => call.op === 'leave')).toHaveLength(1);
    expect(calls.every((call) => call.bridgeAppGeneration === 7)).toBe(true);
    expect(mt.results().find((r) => r.id === 'request-0002')).toMatchObject({ ok: true, value: { id: 'e1' } });
  });

  test('publishing the current App sends its trusted id, not page-supplied files', async () => {
    const { mt, calls, confirmations } = makeBridge();
    mt.drive(rpc('request-0001', 'join', { roomId: 'r', name: 'ada' }));
    await tick();
    mt.drive(rpc('request-0002', 'publish-app', { files: { 'evil.bin': 'ignored' } }));
    await tick();
    expect(calls.find((call) => call.op === 'publish-app')).toMatchObject({
      appId: 'commons', entry: 'index.html', name: 'commons',
    });
    expect(calls.find((call) => call.op === 'publish-app').files).toBeUndefined();
    expect(confirmations.filter((request) => request.kind === 'share')).toHaveLength(1);
    expect(confirmations.find((request) => request.kind === 'share').detail).toContain('source and binary assets');
    expect(confirmations.find((request) => request.kind === 'share').approveLabel).toBe('Share app');
  });

  test('a remembered room join never replaces fresh consent for publishing App files', async () => {
    const { mt, calls, confirmations } = makeBridge({
      confirm: (request) => request.kind !== 'share',
    });
    mt.drive(rpc('request-0001', 'join', { roomId: 'r', name: 'ada' }));
    await tick();
    mt.drive(rpc('request-0002', 'publish-app'));
    await tick();
    expect(mt.results().find((result) => result.id === 'request-0002')).toMatchObject({ ok: false });
    expect(calls.some((call) => call.op === 'publish-app')).toBe(false);
    expect(confirmations.map((request) => request.kind)).toEqual(['join', 'share']);
  });

  test('pushed host events are emitted to the app — filtered to our room + subscribed topics', async () => {
    const { mt, push } = makeBridge();
    mt.drive(rpc('request-0001', 'join', { roomId: 'peerd-global', name: 'ada' }));
    await tick();
    mt.drive(rpc('request-0002', 'subscribe', { topic: 'feed' }));
    await tick();

    push({ type: 'dweb/base-room/event', roomId: 'someone-elses-room', event: 'message', data: { topic: 'feed', from: 'x', data: {} } });
    push({ type: 'dweb/base-room/event', roomId: 'peerd-global', event: 'direct', data: { from: 'did:key:zBOB', data: { hi: 1 } } });
    push({ type: 'dweb/base-room/event', roomId: 'peerd-global', event: 'message', data: { topic: 'feed', from: 'did:key:zBOB', data: { text: 'yo' } } });
    await tick();

    const evs = mt.events();
    expect(evs.find((e) => e.event === 'direct')?.data).toMatchObject({ from: 'did:key:zBOB' });
    expect(evs.find((e) => e.event === 'message')?.data).toMatchObject({ from: 'did:key:zBOB', data: { text: 'yo' } });
    expect(evs.filter((e) => e.event === 'message').length).toBe(1); // the other room never leaked in
  });

  test('join is denied when the user declines consent', async () => {
    const { mt } = makeBridge({ confirm: false });
    mt.drive(rpc('request-0001', 'join', { roomId: 'peerd-global', name: 'ada' }));
    await tick();
    expect(mt.results().find((r) => r.id === 'request-0001')).toMatchObject({ ok: false });
  });

  test('a local fork cannot reuse consent granted to the installed bundle', async () => {
    const stored: Record<string, any> = {
      'dweb.grants.v1': { 'bundle-v1': { rooms: { 'peerd-global': true } } },
    };
    const storage = {
      get: async () => stored,
      set: async (value: any) => { Object.assign(stored, value); },
    };
    const first = makeBridge({
      appDweb: { hash: 'bundle-v1' },
      currentDweb: { hash: 'bundle-v1', forked: true },
      storage,
    });
    first.mt.drive(rpc('request-0001', 'join', { roomId: 'peerd-global' }));
    await tick();
    expect(first.confirmations).toHaveLength(1);
    expect(stored['dweb.grants.v1']['fork:commons:bundle-v1'].rooms['peerd-global']).toBe(true);
    await first.bridge.dispose();

    const second = makeBridge({ confirm: false, appDweb: { hash: 'bundle-v1', forked: true }, storage });
    second.mt.drive(rpc('request-0002', 'join', { roomId: 'peerd-global' }));
    await tick();
    expect(second.confirmations).toHaveLength(0);
    expect(second.calls.some((call) => call.op === 'join')).toBe(true);

    const nextVersion = makeBridge({
      confirm: false,
      appDweb: { hash: 'bundle-v2', forked: true },
      storage,
    });
    nextVersion.mt.drive(rpc('request-0003', 'join', { roomId: 'peerd-global' }));
    await tick();
    expect(nextVersion.confirmations).toHaveLength(1);
    expect(nextVersion.calls.some((call) => call.op === 'join')).toBe(false);

    const staleVersion = makeBridge({
      appDweb: { hash: 'bundle-v1' },
      currentDweb: { hash: 'bundle-v2' },
      storage,
    });
    staleVersion.mt.drive(rpc('request-0004', 'join', { roomId: 'peerd-global' }));
    await tick();
    expect(staleVersion.confirmations).toHaveLength(0);
    expect(staleVersion.calls.some((call) => call.op === 'join')).toBe(false);
    expect(staleVersion.mt.results().find((result) => result.id === 'request-0004')?.error).toContain('Reload');
  });

  test('a clean App cannot join after it changes during consent', async () => {
    const current = { hash: 'bundle-v1', forked: false };
    const bridge = makeBridge({
      appDweb: { hash: 'bundle-v1' },
      currentDweb: current,
      confirm: () => { current.forked = true; return true; },
      joinHost: async (request) => request.bridgeAppForked === current.forked
        ? { ok: true, did: 'did:key:zME', joined: request.roomId, present: [] }
        : { ok: false, error: 'app-identity-changed' },
    });
    bridge.mt.drive(rpc('request-0005', 'join', { roomId: 'peerd-global' }));
    await tick();
    expect(bridge.calls.at(-1)).toMatchObject({ bridgeAppId: 'commons', bridgeAppHash: 'bundle-v1', bridgeAppForked: false, bridgeAppGeneration: 0 });
    expect(bridge.mt.results().at(-1)).toMatchObject({ ok: false, error: 'app-identity-changed' });
  });

  test('prototype-shaped room names cannot inherit a remembered grant', async () => {
    for (const roomId of ['__proto__', 'constructor', 'toString']) {
      const { mt, calls } = makeBridge();
      mt.drive(rpc(`request-${roomId}-0001`, 'join', { roomId }));
      await tick();
      expect(mt.results().find((r) => r.id === `request-${roomId}-0001`)).toMatchObject({ ok: false });
      expect(calls.some((call) => call.op === 'join')).toBe(false);
    }
  });

  test('cancellation while consent is delayed never reaches the host and a retry succeeds', async () => {
    const consentGate = deferred<boolean>();
    let confirmations = 0;
    const { mt, calls } = makeBridge({
      confirm: async () => (++confirmations === 1 ? consentGate.promise : true),
    });
    mt.drive(rpc('request-join-delayed', 'join', { roomId: 'slow-room' }));
    await tick();
    mt.drive({ peerd: 'dweb:cancel', clientId: CLIENT, id: 'request-join-delayed' });
    consentGate.resolve(true);
    await tick();
    expect(calls.filter((call) => call.op === 'join')).toHaveLength(0);

    mt.drive(rpc('request-join-retry01', 'join', { roomId: 'slow-room' }));
    await tick();
    expect(calls.filter((call) => call.op === 'join')).toHaveLength(1);
    expect(mt.results().find((r) => r.id === 'request-join-retry01')).toMatchObject({
      ok: true, value: { joined: 'slow-room' }, clientId: CLIENT,
    });
  });

  test('same-client concurrent joins serialize to one host room', async () => {
    const { mt, calls } = makeBridge();
    mt.drive(rpc('request-same-room01', 'join', { roomId: 'same-room' }));
    mt.drive(rpc('request-same-room02', 'join', { roomId: 'same-room' }));
    await tick();
    expect(calls.filter((call) => call.op === 'join')).toHaveLength(1);
    expect(mt.results().filter((r) => r.ok)).toHaveLength(2);
  });

  test('replacement client cancels an in-flight different-room join, rolls it back, then joins once', async () => {
    const firstJoin = deferred<any>();
    let joins = 0;
    const { mt, calls } = makeBridge({
      joinHost: async (payload) => {
        joins += 1;
        if (joins === 1) return firstJoin.promise;
        return { ok: true, did: 'did:key:zME', joined: payload.roomId, present: [] };
      },
    });
    const replacement = 'client-epoch-0002';
    mt.drive(rpc('request-old-room001', 'join', { roomId: 'old-room' }, CLIENT));
    await tick();
    mt.drive(rpc('request-new-room001', 'join', { roomId: 'new-room' }, replacement));
    firstJoin.resolve({ ok: true, did: 'did:key:zME', joined: 'old-room', present: [] });
    await tick(20);
    expect(calls.map((call) => [call.op, call.roomId])).toEqual([
      ['join', 'old-room'], ['leave', 'old-room'], ['join', 'new-room'],
    ]);
    expect(mt.results().some((r) => r.clientId === CLIENT)).toBe(false);
    expect(mt.results().find((r) => r.clientId === replacement)).toMatchObject({
      ok: true, value: { joined: 'new-room' },
    });
  });

  test('cancel after host join rolls back the exact room and retry succeeds without a leaked ref', async () => {
    const hostJoin = deferred<any>();
    let joins = 0;
    const { mt, calls } = makeBridge({
      joinHost: async (payload) => {
        joins += 1;
        if (joins === 1) return hostJoin.promise;
        return { ok: true, did: 'did:key:zME', joined: payload.roomId, present: [] };
      },
    });
    mt.drive(rpc('request-cancel-host', 'join', { roomId: 'rollback-room' }));
    await tick();
    mt.drive({ peerd: 'dweb:cancel', clientId: CLIENT, id: 'request-cancel-host' });
    hostJoin.resolve({ ok: true, did: 'did:key:zME', joined: 'rollback-room', present: [] });
    await tick(20);
    expect(calls.slice(0, 2).map((call) => [call.op, call.roomId])).toEqual([
      ['join', 'rollback-room'], ['leave', 'rollback-room'],
    ]);

    mt.drive(rpc('request-after-cancel', 'join', { roomId: 'rollback-room' }));
    await tick();
    expect(calls.filter((call) => call.op === 'join')).toHaveLength(2);
    expect(mt.results().find((r) => r.id === 'request-after-cancel')).toMatchObject({ ok: true });
  });

  test('a replacement epoch adopts an established room and stale dispose cannot tear it down', async () => {
    const { mt, calls } = makeBridge();
    const replacement = 'client-epoch-0002';
    mt.drive(rpc('request-owner-join1', 'join', { roomId: 'stable-room' }, CLIENT));
    await tick();
    mt.drive(rpc('request-new-hello1', 'hello', {}, replacement));
    await tick();
    mt.drive({ peerd: 'dweb:dispose', clientId: CLIENT });
    await tick();
    expect(calls.filter((call) => call.op === 'leave')).toHaveLength(0);
    mt.drive({ peerd: 'dweb:dispose', clientId: replacement });
    await tick();
    expect(calls.filter((call) => call.op === 'leave')).toHaveLength(1);
    expect(calls.find((call) => call.op === 'leave').roomId).toBe('stable-room');

    let leaveAttempts = 0;
    const retry = makeBridge({
      leaveHost: async () => ++leaveAttempts === 1
        ? { ok: false, error: 'leave-failed' }
        : { ok: true, left: true },
    });
    retry.mt.drive(rpc('request-owner-join-retry', 'join', { roomId: 'retry-room' }, CLIENT));
    await tick();
    retry.mt.drive({ peerd: 'dweb:dispose', clientId: CLIENT });
    await tick();
    retry.mt.drive(rpc('request-new-hello-retry', 'hello', {}, replacement));
    await tick();
    retry.mt.drive({ peerd: 'dweb:dispose', clientId: replacement });
    await tick();
    expect(retry.calls.filter((call) => call.op === 'leave').map((call) => call.roomId))
      .toEqual(['retry-room', 'retry-room']);
  });

  test('a retired epoch cannot recapture the bridge with a late RPC or dispose the replacement room', async () => {
    const { mt, calls } = makeBridge();
    const replacement = 'client-epoch-0002';
    mt.drive(rpc('request-owner-join2', 'join', { roomId: 'stable-room' }, CLIENT));
    await tick();
    mt.drive(rpc('request-new-hello2', 'hello', {}, replacement));
    await tick();

    mt.drive(rpc('request-late-hello', 'hello', {}, CLIENT));
    await tick();
    expect(mt.results().find((result) => result.id === 'request-late-hello')).toMatchObject({
      ok: false, clientId: CLIENT, error: 'retired client epoch',
    });
    mt.drive({ peerd: 'dweb:dispose', clientId: CLIENT });
    await tick();
    expect(calls.filter((call) => call.op === 'leave')).toHaveLength(0);

    mt.drive(rpc('request-new-status', 'status', {}, replacement));
    await tick();
    expect(mt.results().find((result) => result.id === 'request-new-status')).toMatchObject({
      ok: true, clientId: replacement, value: { joined: 'stable-room' },
    });
  });

  test('dispose waits for a joined room to leave', async () => {
    const leaving = deferred<any>();
    const { mt, bridge, calls } = makeBridge({ leaveHost: async () => leaving.promise });
    mt.drive(rpc('request-join-dispose', 'join', { roomId: 'stable-room' }));
    await tick();
    let settled = false;
    const disposing = bridge.dispose().then(() => { settled = true; });
    await tick();
    expect(calls.filter((call) => call.op === 'leave')).toHaveLength(1);
    expect(settled).toBe(false);
    leaving.resolve({ ok: true, left: true });
    await disposing;
    expect(settled).toBe(true);

    const failed = makeBridge({ leaveHost: async () => ({ ok: false, error: 'leave-failed' }) });
    failed.mt.drive(rpc('request-failed-leave', 'join', { roomId: 'failed-room' }));
    await tick();
    await expect(failed.bridge.dispose()).rejects.toThrow('leave-failed');

    const explicitLeave = deferred<any>();
    const concurrent = makeBridge({ leaveHost: async () => explicitLeave.promise });
    concurrent.mt.drive(rpc('request-concurrent-join', 'join', { roomId: 'concurrent-room' }));
    await tick();
    concurrent.mt.drive(rpc('request-concurrent-leave', 'leave'));
    await tick();
    const concurrentDispose = concurrent.bridge.dispose();
    explicitLeave.resolve({ ok: true, left: true });
    await concurrentDispose;
    expect(concurrent.calls.filter((call) => call.op === 'leave')).toHaveLength(1);
  });

  test('dispose waits for a started host join and its exact-room rollback', async () => {
    const joining = deferred<any>();
    const leaving = deferred<any>();
    const { mt, bridge, calls } = makeBridge({
      joinHost: async () => joining.promise,
      leaveHost: async () => leaving.promise,
    });
    mt.drive(rpc('request-pending-dispose', 'join', { roomId: 'pending-room' }));
    await tick();
    let settled = false;
    const disposing = bridge.dispose().then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);
    joining.resolve({ ok: true, did: 'did:key:zME', joined: 'pending-room', present: [] });
    await tick();
    expect(calls.map((call) => call.op)).toEqual(['join', 'leave']);
    expect(settled).toBe(false);
    leaving.resolve({ ok: true, left: true });
    await disposing;
    expect(settled).toBe(true);
  });

  test('authority invalidation does not wait for a join or leave reply', async () => {
    const joining = deferred<any>();
    const leaving = deferred<any>();
    const { mt, bridge, calls } = makeBridge({
      joinHost: async () => joining.promise,
      leaveHost: async () => leaving.promise,
    });
    mt.drive(rpc('request-pending-invalidate', 'join', { roomId: 'pending-room' }));
    await tick();
    let settled = false;
    await bridge.invalidate().then(() => { settled = true; });
    expect(settled).toBe(true);
    expect(calls.map((call) => call.op)).toEqual(['join', 'leave']);
    joining.resolve({ ok: true, did: 'did:key:zME', joined: 'pending-room', present: [] });
    leaving.resolve({ ok: true, left: true });
    await tick();
  });

  test('dispose removes an exact owner after the host loses its join reply', async () => {
    const owners = new Set<string>();
    let leaves = 0;
    const ownerOf = (payload: any) => `${payload.bridgeAppId}:${payload.bridgeAppGeneration}`;
    const { mt, bridge, calls } = makeBridge({
      appDweb: { seed: 'commons', generation: 9 },
      joinHost: async (payload) => {
        owners.add(ownerOf(payload));
        throw new Error('join reply lost');
      },
      leaveHost: async (payload) => {
        leaves += 1;
        if (leaves === 1) throw new Error('cleanup unavailable');
        owners.delete(ownerOf(payload));
        return { ok: true, left: true };
      },
    });
    mt.drive(rpc('request-lost-join', 'join', { roomId: 'lost-room' }));
    await tick(20);
    expect(owners).toEqual(new Set(['commons:9']));
    await bridge.dispose();
    expect(owners.size).toBe(0);
    expect(calls.map((call) => [call.op, call.roomId, ownerOf(call)])).toEqual([
      ['join', 'lost-room', 'commons:9'],
      ['leave', 'lost-room', 'commons:9'],
      ['leave', 'lost-room', 'commons:9'],
    ]);
  });

  test('unknown op is rejected; dispose unsubscribes transport + host events', async () => {
    const { mt, bridge } = makeBridge();
    mt.drive(rpc('request-0007', 'nonsense'));
    await tick();
    expect(mt.results().find((r) => r.id === 'request-0007')).toMatchObject({ ok: false });
    expect(mt.hasHandler()).toBe(true);
    await bridge.dispose();
    expect(mt.hasHandler()).toBe(false);
  });
});
