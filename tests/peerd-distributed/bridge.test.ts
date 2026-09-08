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

const memoryStorage = () => {
  const values: Record<string, any> = Object.create(null);
  return {
    get: async (key: string) => ({ [key]: structuredClone(values[key]) }),
    set: async (patch: any) => {
      for (const [key, value] of Object.entries(patch)) values[key] = structuredClone(value);
    },
    values,
  };
};

// The bridge now talks to the offscreen base host over swCall('dweb/base/room')
// and receives pushed room events via onHostEvent — no in-page room host, no
// identity minting, no signaler. The fakes below stand in for that host.
const makeBridge = ({ confirm = true, joinHost, roomCall, storage }: {
  confirm?: boolean | ((request: any) => boolean | Promise<boolean>),
  joinHost?: (payload: any) => Promise<any>,
  roomCall?: (payload: any) => Promise<any>,
  storage?: { get: (key: string) => Promise<any>, set: (value: any) => Promise<void> },
} = {}) => {
  const mt = mockTransport();
  const calls: any[] = [];
  const confirmations: any[] = [];
  let pushEvent: ((m: any) => void) | null = null;
  const swCall = async (type: string, payload: any = {}) => {
    if (type !== 'dweb/base/room') return { ok: true };
    calls.push(payload);
    if (roomCall) return roomCall(payload);
    switch (payload.op) {
      case 'join': {
        const joined = joinHost
          ? await joinHost(payload)
          : {
              ok: true, did: 'did:key:zME', joined: payload.roomId,
              hostEpoch: 'host-epoch-0001', present: [],
            };
        return { ...joined, admissionToken: joined?.admissionToken ?? payload.roomAdmissionToken };
      }
      case 'join-ack': return {
        ok: true, joined: payload.roomId, admissionToken: payload.roomAdmissionToken,
      };
      case 'publish': return { ok: true, id: 'e1', ts: 1 };
      case 'dm': return { ok: true, id: 'd1', ts: 2 };
      case 'presence': return { ok: true, present: [{ did: 'did:key:zBOB', meta: { name: 'bob' } }] };
      case 'history': return { ok: true, items: [] };
      case 'leave': return { ok: true, left: true };
      case 'publish-app': return { ok: true, uri: 'peerd://bundle', hash: 'hash' };
      default: return { ok: true };
    }
  };
  const bridge = createDwebBridge({
    appId: 'commons', appName: 'commons', appDweb: { seed: 'commons' }, entryFile: 'index.html',
    transport: mt.transport,
    swCall,
    storage: storage ?? { get: async () => ({}), set: async () => {} },
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
    const { mt, calls } = makeBridge();
    mt.drive(rpc('request-0001', 'join', { roomId: 'peerd-global', name: 'ada' }));
    await tick();
    expect(mt.results().find((r) => r.id === 'request-0001')).toMatchObject({ ok: true, value: { joined: 'peerd-global', did: 'did:key:zME' } });

    mt.drive(rpc('request-0002', 'publish', { topic: 'feed', data: { text: 'hi' } }));
    await tick();
    expect(calls.find((c) => c.op === 'publish')).toMatchObject({ roomId: 'peerd-global', topic: 'feed', data: { text: 'hi' } });
    expect(calls.every((call) => call.appId === 'commons')).toBe(true);
    expect(mt.results().find((r) => r.id === 'request-0002')).toMatchObject({ ok: true, value: { id: 'e1' } });
  });

  test('cancellation cannot hide completed publish or direct-message effects', async () => {
    for (const effect of [
      { publicOp: 'publish', hostOp: 'publish', args: { topic: 'feed', data: { text: 'hi' } } },
      { publicOp: 'dm-send', hostOp: 'dm', args: { to: 'did:key:zPeer', data: 'hi' } },
    ]) {
      const completed = deferred<any>();
      const { mt } = makeBridge({
        roomCall: async (payload) => {
          if (payload.op === 'join') return {
            ok: true, did: 'did:key:zME', joined: payload.roomId,
            hostEpoch: 'host-epoch-0001', present: [],
            admissionToken: payload.roomAdmissionToken,
          };
          if (payload.op === 'join-ack') {
            return { ok: true, admissionToken: payload.roomAdmissionToken };
          }
          if (payload.op === effect.hostOp) return completed.promise;
          return { ok: true };
        },
      });
      mt.drive(rpc('request-join', 'join', { roomId: 'peerd-global' }));
      await tick();
      mt.drive(rpc('request-effect', effect.publicOp, effect.args));
      await tick();
      mt.drive({ peerd: 'dweb:cancel', clientId: CLIENT, id: 'request-effect' });
      completed.resolve({ ok: true, id: 'committed-event', ts: 1 });
      await tick();
      expect(mt.results().find((result) => result.id === 'request-effect')).toMatchObject({
        ok: true, value: { id: 'committed-event' },
      });
    }
  });

  test('failed publish and DM replies never become success and preserve unknown custody', async () => {
    const { mt } = makeBridge({
      roomCall: async (payload) => payload.op === 'join'
        ? {
            ok: true, did: 'did:key:zME', joined: payload.roomId,
            hostEpoch: 'host-epoch-0001', present: [],
            admissionToken: payload.roomAdmissionToken,
          }
        : payload.op === 'join-ack'
          ? { ok: true, admissionToken: payload.roomAdmissionToken }
          : {
              ok: false, error: 'response lost', performed: true,
              outcomeKnown: false, outcomeKind: 'transport-lost', retryable: false,
            },
    });
    mt.drive(rpc('request-0001', 'join', { roomId: 'r' }));
    await tick();
    mt.drive(rpc('request-0002', 'publish', { topic: 'feed', data: 'x' }));
    mt.drive(rpc('request-0003', 'dm-send', { to: 'did:key:zPeer', data: 'x' }));
    await tick();
    for (const id of ['request-0002', 'request-0003']) {
      expect(mt.results().find((result) => result.id === id)).toMatchObject({
        ok: false, error: 'response lost', performed: true,
        outcomeKnown: false, outcomeKind: 'transport-lost', retryable: false,
      });
    }
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

  test('a replacement host rejoins the exact member and restores retained/subscribed topics once', async () => {
    const members = new Set<string>();
    const { mt, calls, push } = makeBridge({
      joinHost: async (payload) => {
        members.add(payload.roomClientId);
        return {
          ok: true,
          did: 'did:key:zME',
          joined: payload.roomId,
          hostEpoch: payload.expectedHostEpoch ?? 'host-epoch-0001',
          present: [],
        };
      },
    });
    mt.drive(rpc('request-host-join1', 'join', { roomId: 'durable-room', name: 'ada' }));
    await tick();
    mt.drive(rpc('request-host-retain', 'retain', { topic: 'lobby-state' }));
    mt.drive(rpc('request-host-sub001', 'subscribe', { topic: 'moves' }));
    await tick();
    const initialJoin = calls.find((call) => call.op === 'join');
    calls.length = 0;

    push({
      type: 'dweb/base-host/generation',
      hostEpoch: 'host-epoch-0002',
      meshGeneration: 1,
      did: 'did:key:zME',
    });
    await tick(20);
    expect(calls.map((call) => call.op)).toEqual(['join', 'join-ack', 'retain', 'subscribe']);
    expect(calls[0]).toMatchObject({
      roomId: 'durable-room', name: 'ada', expectedHostEpoch: 'host-epoch-0002',
      roomClientId: initialJoin.roomClientId,
      roomAdmissionToken: initialJoin.roomAdmissionToken,
    });
    expect(members.size).toBe(1);
    expect(calls[1]).toMatchObject({
      roomId: 'durable-room', expectedHostEpoch: 'host-epoch-0002',
      roomAdmissionToken: initialJoin.roomAdmissionToken,
    });
    expect(calls[2]).toMatchObject({
      roomId: 'durable-room', topic: 'lobby-state', expectedHostEpoch: 'host-epoch-0002',
    });
    expect(calls[3]).toMatchObject({
      roomId: 'durable-room', topic: 'moves', expectedHostEpoch: 'host-epoch-0002',
    });
    expect(mt.events().find((event) => event.event === 'host-recovered')).toMatchObject({
      data: { roomId: 'durable-room', hostEpoch: 'host-epoch-0002' },
    });

    calls.length = 0;
    push({ type: 'dweb/base-host/generation', hostEpoch: 'host-epoch-0002', meshGeneration: 1 });
    push({ type: 'dweb/base-host/generation', hostEpoch: 'host-epoch-0001', meshGeneration: 1 });
    await tick();
    expect(calls).toEqual([]);
  });

  test('join is denied when the user declines consent', async () => {
    const { mt } = makeBridge({ confirm: false });
    mt.drive(rpc('request-0001', 'join', { roomId: 'peerd-global', name: 'ada' }));
    await tick();
    expect(mt.results().find((r) => r.id === 'request-0001')).toMatchObject({ ok: false });
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
      ['join-ack', 'new-room'],
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

  test('host commit followed by SW relay death compensates the exact token before retry', async () => {
    const members = new Map<string, string>();
    let failFirstRelay = true;
    const { mt, calls } = makeBridge({
      roomCall: async (payload) => {
        if (payload.op === 'join') {
          members.set(payload.roomClientId, payload.roomAdmissionToken);
          if (failFirstRelay) {
            failFirstRelay = false;
            throw new Error('service worker died after host commit');
          }
          return {
            ok: true, did: 'did:key:zME', joined: payload.roomId,
            hostEpoch: 'host-epoch-0001', present: [],
            admissionToken: payload.roomAdmissionToken,
          };
        }
        if (payload.op === 'join-ack') {
          return { ok: true, admissionToken: payload.roomAdmissionToken };
        }
        if (payload.op === 'leave') {
          if (members.get(payload.roomClientId) === payload.roomAdmissionToken) {
            members.delete(payload.roomClientId);
          }
          return { ok: true, left: true };
        }
        return { ok: true };
      },
    });
    mt.drive(rpc('request-crash-join1', 'join', { roomId: 'crash-room' }));
    await tick(20);
    expect(mt.results().find((row) => row.id === 'request-crash-join1'))
      .toMatchObject({ ok: false });
    expect(members.size).toBe(0);
    const firstJoin = calls.find((call) => call.op === 'join');
    const rollback = calls.find((call) => call.op === 'leave');
    expect(rollback).toMatchObject({
      roomId: 'crash-room',
      roomClientId: firstJoin.roomClientId,
      roomAdmissionToken: firstJoin.roomAdmissionToken,
    });

    mt.drive(rpc('request-crash-join2', 'join', { roomId: 'crash-room' }));
    await tick(20);
    expect(mt.results().find((row) => row.id === 'request-crash-join2'))
      .toMatchObject({ ok: true, value: { joined: 'crash-room' } });
    expect(members.size).toBe(1);
    expect(members.get(firstJoin.roomClientId)).not.toBe(firstJoin.roomAdmissionToken);
  });

  test('acknowledged join with a lost reply persists exact cleanup across App reopen', async () => {
    const storage = memoryStorage();
    const members = new Map<string, string>();
    let cold = true;
    const roomCall = async (payload: any) => {
      if (payload.op === 'join') {
        members.set(payload.roomClientId, payload.roomAdmissionToken);
        return {
          ok: true, did: 'did:key:zME', joined: payload.roomId,
          hostEpoch: 'host-epoch-0001', present: [],
          admissionToken: payload.roomAdmissionToken,
        };
      }
      if (payload.op === 'join-ack') {
        if (members.get(payload.roomClientId) !== payload.roomAdmissionToken) {
          return { ok: false, error: 'app-room-admission-mismatch' };
        }
        throw new Error('service worker died after admission acknowledgement');
      }
      if (payload.op === 'leave') {
        if (cold) throw new Error('service worker unavailable');
        if (members.get(payload.roomClientId) === payload.roomAdmissionToken) {
          members.delete(payload.roomClientId);
        }
        return { ok: true, left: true };
      }
      return { ok: true };
    };
    const first = makeBridge({ roomCall, storage });
    first.mt.drive(rpc('request-ack-crash1', 'join', { roomId: 'reopen-room' }));
    await tick(20);
    expect(first.mt.results().find((row) => row.id === 'request-ack-crash1'))
      .toMatchObject({ ok: false });
    expect(members.size).toBe(1);
    const compensationKey = Object.keys(storage.values)
      .find((key) => key.startsWith('dweb.room-compensation.v1:'))!;
    expect(storage.values[compensationKey]).toEqual(
      expect.objectContaining({ roomId: 'reopen-room' }),
    );
    first.bridge.dispose();

    cold = false;
    const reopened = makeBridge({ roomCall, storage });
    await tick(20);
    expect(members.size).toBe(0);
    expect(storage.values[compensationKey]).toBeNull();
    reopened.bridge.dispose();
  });

  test('an already-absent durable compensation clears before a later join', async () => {
    const storage = memoryStorage();
    const compensationKey = 'dweb.room-compensation.v1:commons';
    storage.values[compensationKey] = {
      schema: 1,
      appId: 'commons',
      roomId: 'orphaned-room',
      clientId: 'room-client-orphaned',
      admissionToken: 'room-admission-orphaned',
      hostEpoch: 'host-epoch-orphaned',
    };
    const { mt, bridge, calls } = makeBridge({
      storage,
      roomCall: async (payload) => {
        if (payload.op === 'leave') return { ok: false, error: 'not-in-room' };
        if (payload.op === 'join') return {
          ok: true, did: 'did:key:zME', joined: payload.roomId,
          hostEpoch: 'host-epoch-0002', present: [],
          admissionToken: payload.roomAdmissionToken,
        };
        if (payload.op === 'join-ack') {
          return { ok: true, admissionToken: payload.roomAdmissionToken };
        }
        return { ok: true };
      },
    });
    await tick(20);
    expect(storage.values[compensationKey]).toBeNull();

    mt.drive(rpc('request-after-compensation', 'join', { roomId: 'next-room' }));
    await tick(20);
    expect(calls.map((call) => call.op)).toEqual(['leave', 'join', 'join-ack']);
    expect(mt.results().find((row) => row.id === 'request-after-compensation'))
      .toMatchObject({ ok: true, value: { joined: 'next-room' } });
    bridge.dispose();
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

  test('unknown op is rejected; dispose unsubscribes transport + host events', async () => {
    const { mt, bridge } = makeBridge();
    mt.drive(rpc('request-0007', 'nonsense'));
    await tick();
    expect(mt.results().find((r) => r.id === 'request-0007')).toMatchObject({ ok: false });
    expect(mt.hasHandler()).toBe(true);
    bridge.dispose();
    expect(mt.hasHandler()).toBe(false);
  });
});
