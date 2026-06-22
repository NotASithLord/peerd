import { describe, test, expect } from 'bun:test';
import { createDwebBridge } from '../../extension/peerd-distributed/apps/bridge.js';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

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
const makeBridge = ({ confirm = true }: { confirm?: boolean } = {}) => {
  const mt = mockTransport();
  const calls: any[] = [];
  let pushEvent: ((m: any) => void) | null = null;
  const swCall = async (type: string, payload: any = {}) => {
    if (type !== 'dweb/base/room') return { ok: true };
    calls.push(payload);
    switch (payload.op) {
      case 'join': return { ok: true, did: 'did:key:zME', joined: payload.roomId, present: [] };
      case 'publish': return { ok: true, id: 'e1', ts: 1 };
      case 'dm': return { ok: true, id: 'd1', ts: 2 };
      case 'presence': return { ok: true, present: [{ did: 'did:key:zBOB', meta: { name: 'bob' } }] };
      case 'history': return { ok: true, items: [] };
      case 'leave': return { ok: true, left: true };
      default: return { ok: true };
    }
  };
  const bridge = createDwebBridge({
    appId: 'commons', appName: 'commons', appDweb: { seed: 'commons' }, entryFile: 'index.html',
    transport: mt.transport,
    swCall,
    storage: { get: async () => ({}), set: async () => {} },
    confirmAction: async () => confirm,
    readAppFiles: async () => ({}),
    onHostEvent: (h: any) => { pushEvent = h; return () => { pushEvent = null; }; },
    launch: {},
  });
  return { mt, bridge, calls, push: (m: any) => pushEvent?.(m) };
};

describe('dwapp bridge (base-network rooms, transport-agnostic)', () => {
  test('hello replies over the injected transport', async () => {
    const { mt } = makeBridge();
    mt.drive({ peerd: 'dweb', id: 1, op: 'hello', args: {} });
    await tick();
    const [r] = mt.results();
    expect(r).toMatchObject({ peerd: 'dweb:result', id: 1, ok: true });
    expect(r.value).toMatchObject({ available: true, app: 'commons', joined: null });
  });

  test('join → publish relays room ops over swCall', async () => {
    const { mt, calls } = makeBridge();
    mt.drive({ peerd: 'dweb', id: 1, op: 'join', args: { roomId: 'peerd-global', name: 'ada' } });
    await tick();
    expect(mt.results().find((r) => r.id === 1)).toMatchObject({ ok: true, value: { joined: 'peerd-global', did: 'did:key:zME' } });

    mt.drive({ peerd: 'dweb', id: 2, op: 'publish', args: { topic: 'feed', data: { text: 'hi' } } });
    await tick();
    expect(calls.find((c) => c.op === 'publish')).toMatchObject({ roomId: 'peerd-global', topic: 'feed', data: { text: 'hi' } });
    expect(mt.results().find((r) => r.id === 2)).toMatchObject({ ok: true, value: { id: 'e1' } });
  });

  test('pushed host events are emitted to the app — filtered to our room + subscribed topics', async () => {
    const { mt, push } = makeBridge();
    mt.drive({ peerd: 'dweb', id: 1, op: 'join', args: { roomId: 'peerd-global', name: 'ada' } });
    await tick();
    mt.drive({ peerd: 'dweb', id: 2, op: 'subscribe', args: { topic: 'feed' } });
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
    mt.drive({ peerd: 'dweb', id: 1, op: 'join', args: { roomId: 'peerd-global', name: 'ada' } });
    await tick();
    expect(mt.results().find((r) => r.id === 1)).toMatchObject({ ok: false });
  });

  test('unknown op is rejected; dispose unsubscribes transport + host events', async () => {
    const { mt, bridge } = makeBridge();
    mt.drive({ peerd: 'dweb', id: 7, op: 'nonsense', args: {} });
    await tick();
    expect(mt.results().find((r) => r.id === 7)).toMatchObject({ ok: false });
    expect(mt.hasHandler()).toBe(true);
    bridge.dispose();
    expect(mt.hasHandler()).toBe(false);
  });
});
