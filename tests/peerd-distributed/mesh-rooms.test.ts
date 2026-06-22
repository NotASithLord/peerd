import { describe, test, expect } from 'bun:test';
import {
  signalingStep,
  initialSignalingState,
} from '../../extension/peerd-distributed/transport/signaling.js';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { memoryPair } from '../../extension/peerd-distributed/transport/channel.js';
import { createSession } from '../../extension/peerd-distributed/transport/session.js';
import { createRoomMesh, CTRL } from '../../extension/peerd-distributed/transport/mesh.js';
import { joinRoom } from '../../extension/peerd-distributed/transport/rooms.js';

// ---------------------------------------------------------------------------
// Fakes. The REAL reducer runs the fake node (same code as the Bun/CF
// shells); the fake transport swaps WebRTC bytes for memoryPair while
// keeping the exact connect/accept + signal() seam of the real transport.
// What's left untested here is live ICE — the honest Bun boundary
// (connect.js header), browser-verified instead.
// ---------------------------------------------------------------------------

const createFakeNode = () => {
  let state = initialSignalingState();
  const conns = new Map<string, FakeWS>();
  let nextId = 1;
  let dead = false;

  const step = (event: any) => {
    const r = signalingStep(state, event);
    state = r.state;
    for (const a of r.actions) {
      const ws = conns.get(a.connId);
      if (!ws) continue;
      if (a.t === 'send') ws._receive(JSON.stringify((a as any).msg));
      else ws.close();
    }
  };

  class FakeWS {
    onmessage: ((e: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readyState = 0;
    connId = String(nextId++);
    constructor(url: string) {
      if (dead) {
        queueMicrotask(() => { this.readyState = 3; this.onerror?.(); this.onclose?.(); });
        return;
      }
      const key = new URL(url).searchParams.get('key')!;
      conns.set(this.connId, this);
      queueMicrotask(() => {
        this.readyState = 1;
        step({ t: 'join', connId: this.connId, key });
      });
    }
    send(raw: string) {
      const m = JSON.parse(raw);
      if (m.t === 'signal') step({ t: 'signal', connId: this.connId, to: m.to, payload: m.payload });
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      conns.delete(this.connId);
      step({ t: 'leave', connId: this.connId });
      this.onclose?.();
    }
    _receive(data: string) { this.onmessage?.({ data }); }
  }

  return {
    WebSocket: FakeWS as any,
    // The kill-the-server beat: every socket drops, no new ones connect.
    kill: () => {
      dead = true;
      for (const ws of [...conns.values()]) { conns.delete(ws.connId); ws.readyState = 3; ws.onclose?.(); }
    },
  };
};

// One shared "ether" per test: offers reference a pending memoryPair so any
// instance's accept() can bind to it — stands in for the network.
const createFakeEther = () => {
  const pending = new Map<string, any>();
  let n = 0;
  // New trickle contract: signaling = { send, onRemote }. The fake pairs via
  // memoryPair (no real ICE), so it just relays the offer id and ignores
  // candidates/answer — the pair is already connected.
  const makeTransport = () => ({
    name: 'fake',
    canReach: () => 1,
    async connect(_peer: any, { signaling }: any) {
      const [local, remote] = memoryPair();
      const id = `offer-${n++}`;
      pending.set(id, remote);
      signaling.send({ type: 'offer', sdp: id });
      return local;
    },
    async accept({ offer, signaling }: any) {
      const remote = pending.get(offer.sdp);
      if (!remote) throw new Error(`fake transport: unknown offer ${offer.sdp}`);
      pending.delete(offer.sdp);
      signaling.send({ type: 'answer', sdp: offer.sdp });
      return { channel: Promise.resolve(remote) };
    },
  });
  return { makeTransport };
};

const URL_FAKE = 'ws://fake.node/rendezvous';

const join = (roomId: string, identity: any, node: any, ether: any, extra: any = {}) =>
  joinRoom({
    roomId,
    identity,
    url: URL_FAKE,
    WebSocket: node.WebSocket,
    transport: ether.makeTransport(),
    ...extra,
  });

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const didsOf = (room: any) => room.peers().map((p: any) => p.did).sort();

describe('rooms over the rendezvous (fake node, real reducer)', () => {
  test('three joiners form a full mesh', async () => {
    const node = createFakeNode();
    const ether = createFakeEther();
    const [a, b, c] = await Promise.all([generateIdentity(), generateIdentity(), generateIdentity()]);

    const ra = await join('r1', a, node, ether);
    const rb = await join('r1', b, node, ether);
    const rc = await join('r1', c, node, ether);
    await tick();

    expect(didsOf(ra)).toEqual([b.did, c.did].sort());
    expect(didsOf(rb)).toEqual([a.did, c.did].sort());
    expect(didsOf(rc)).toEqual([a.did, b.did].sort());
    ra.leave(); rb.leave(); rc.leave();
  });

  test('roster request answers with the asker excluded', async () => {
    const node = createFakeNode();
    const ether = createFakeEther();
    const [a, b, c] = await Promise.all([generateIdentity(), generateIdentity(), generateIdentity()]);
    const ra = await join('r2', a, node, ether);
    const rb = await join('r2', b, node, ether);
    const rc = await join('r2', c, node, ether);
    await tick();

    const roster = await rc.mesh.requestRoster(a.did);
    expect(roster.sort()).toEqual([a.did, b.did].sort()); // a + a's links, minus c
    ra.leave(); rb.leave(); rc.leave();
  });

  test('KILL THE SERVER: mesh survives; a newcomer joins through a member', async () => {
    const node = createFakeNode();
    const ether = createFakeEther();
    const [a, b, c, d] = await Promise.all([
      generateIdentity(), generateIdentity(), generateIdentity(), generateIdentity(),
    ]);
    const ra = await join('r3', a, node, ether);
    const rb = await join('r3', b, node, ether);
    const rc = await join('r3', c, node, ether);
    await tick();

    // The beat: the only server dies mid-session.
    node.kill();
    await tick();
    expect(ra.rendezvous()).toBe('connecting'); // reconnecting with backoff (was 'down') — mesh survives meanwhile
    expect(didsOf(ra)).toEqual([b.did, c.did].sort()); // links untouched

    // D arrives with ONE link to A (out-of-band — the invite-code shape),
    // then crawls the room through it: roster + relayed dials, no server.
    const rd = await joinRoom({ roomId: 'r3', identity: d, url: null, transport: ether.makeTransport() });
    const [chA, chD] = memoryPair();
    const [{ remoteDid: dSeenByA }] = await Promise.all([
      createSession({ channel: chA, identity: a }),
      createSession({ channel: chD, identity: d }),
    ]);
    ra.mesh.addLink(chA, dSeenByA);
    rd.mesh.addLink(chD, a.did);
    await rd.expandViaPeer(a.did);
    await tick();

    expect(didsOf(rd)).toEqual([a.did, b.did, c.did].sort());
    expect(didsOf(rb)).toContain(d.did); // b answered the relayed offer
    ra.leave(); rb.leave(); rc.leave(); rd.leave();
  });

  test('a member leaving is noticed by the mesh (channel close)', async () => {
    const node = createFakeNode();
    const ether = createFakeEther();
    const [a, b] = await Promise.all([generateIdentity(), generateIdentity()]);
    const ra = await join('r4', a, node, ether);
    const rb = await join('r4', b, node, ether);
    await tick();

    const gone: string[] = [];
    ra.onPeerGone(({ did }: any) => gone.push(did));
    rb.leave(); // closes b's channels → a's side signals close
    await tick();
    expect(gone).toEqual([b.did]);
    expect(ra.peers()).toHaveLength(0);
    ra.leave();
  });
});

describe('mesh boundary rules', () => {
  const linkedPair = async (meshX: any, idX: any, meshY: any, idY: any) => {
    const [cx, cy] = memoryPair();
    await Promise.all([
      createSession({ channel: cx, identity: idX }),
      createSession({ channel: cy, identity: idY }),
    ]);
    meshX.addLink(cx, idY.did);
    meshY.addLink(cy, idX.did);
    return [cx, cy];
  };

  test('an envelope claiming another sender on a direct channel is dropped', async () => {
    const [a, b, c] = await Promise.all([generateIdentity(), generateIdentity(), generateIdentity()]);
    const audits: any[] = [];
    const ma = createRoomMesh({ roomId: 'r', identity: a, audit: (t: string, d: any) => audits.push({ t, d }) });
    const mb = createRoomMesh({ roomId: 'r', identity: b });
    await linkedPair(ma, a, mb, b);

    const got: any[] = [];
    ma.onEnvelope((e: any) => got.push(e));

    // b signs an envelope AS ITSELF on ch=3 → delivered.
    const ok = await mb.sign(3, 0, { msg: 'hi' });
    mb.send(a.did, ok);
    await tick();
    expect(got).toHaveLength(1);

    // b replays one of C's envelopes (validly signed BY C) on its own
    // link → misattributed for a link-local channel → dropped + audited.
    const mc = createRoomMesh({ roomId: 'r', identity: c });
    const fromC = await mc.sign(3, 0, { msg: 'laundered' });
    mb.send(a.did, fromC);
    await tick();
    expect(got).toHaveLength(1);
    expect(audits.some((x) => x.t === 'peer_envelope_misattributed')).toBe(true);
    ma.close(); mb.close(); mc.close();
  });

  test('a tampered envelope fails verification and is dropped', async () => {
    const [a, b] = await Promise.all([generateIdentity(), generateIdentity()]);
    const ma = createRoomMesh({ roomId: 'r', identity: a });
    const mb = createRoomMesh({ roomId: 'r', identity: b });
    const [, cy] = await linkedPair(ma, a, mb, b);

    const got: any[] = [];
    ma.onEnvelope((e: any) => got.push(e));
    const env = await mb.sign(3, 0, { amount: 1 });
    cy.send({ ...env, body: { amount: 1_000_000 } }); // tamper after signing
    await tick();
    expect(got).toHaveLength(0);
    ma.close(); mb.close();
  });

  test('RELAY forwards one hop, only frames received from their signer', async () => {
    const [a, b, c] = await Promise.all([generateIdentity(), generateIdentity(), generateIdentity()]);
    const ma = createRoomMesh({ roomId: 'r', identity: a });
    const mb = createRoomMesh({ roomId: 'r', identity: b });
    const mc = createRoomMesh({ roomId: 'r', identity: c });
    await linkedPair(ma, a, mb, b); // a—b
    await linkedPair(ma, a, mc, c); // a—c   (b and c NOT linked)

    const cGot: any[] = [];
    mc.onRelay(({ env, via }: any) => cGot.push({ from: env.from, via, kind: env.body.kind }));

    await mb.relay(a.did, c.did, 'offer', 'sid-1', { type: 'offer', sdp: 'x' });
    // Poll for arrival rather than a single fixed tick: the relay is two async
    // Ed25519 hops (b→a verify+re-sign→c verify), which a single 20ms tick can
    // miss under CI load (flake). Still fails fast if the frame never arrives.
    for (let i = 0; i < 50 && cGot.length === 0; i += 1) await tick(10);
    expect(cGot).toEqual([{ from: b.did, via: a.did, kind: 'offer' }]);
    ma.close(); mb.close(); mc.close();
  });

  test('idle links are pinged, then dropped', async () => {
    const a = await generateIdentity();
    const gone: any[] = [];
    const ma = createRoomMesh({
      roomId: 'r', identity: a, pingIntervalMs: 30, idleTimeoutMs: 90,
    });
    ma.onPeerGone((g: any) => gone.push(g));
    // A link whose far side never answers: sends vanish, nothing arrives.
    const dummy = { send: () => {}, setHandler: () => {}, onClose: () => () => {}, close: () => {}, isClosed: () => false };
    ma.addLink(dummy as any, 'did:key:zDeadPeer');
    ma.start();
    await tick(200);
    ma.close();
    expect(gone.map((g) => g.why)).toContain('idle-timeout');
  });

  test('budget refuses links past the cap', async () => {
    const a = await generateIdentity();
    const ma = createRoomMesh({ roomId: 'r', identity: a, budget: 1 });
    const mk = () => ({ send: () => {}, setHandler: () => {}, onClose: () => () => {}, close: () => {}, isClosed: () => false });
    expect(ma.addLink(mk() as any, 'did:key:zOne')).toBe(true);
    expect(ma.addLink(mk() as any, 'did:key:zTwo')).toBe(false);
    expect(ma.peers()).toHaveLength(1);
    ma.close();
  });
});
