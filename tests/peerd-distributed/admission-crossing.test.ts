import { createAdmissionGovernor } from '../../extension/peerd-distributed/transport/admission.js';
import { expect, test } from 'bun:test';
import { joinRoom } from '../../extension/peerd-distributed/transport/rooms.js';
import { memoryPair, createBufferedChannel } from '../../extension/peerd-distributed/transport/channel.js';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';

for (const saturated of [false, true]) test(`crossing relay dials retain one link with delayed closes (inbound saturated: ${saturated})`, async () => {
  const ids = await Promise.all([generateIdentity(), generateIdentity(), generateIdentity()]);
  const delayedCloses: Array<() => void> = [];
  const channels: any[] = [];
  const pending = new Map<string, any>();
  let next = 0;
  let accepted = 0;
  const transport = {
    async connect(_peer: any, { signaling }: any) {
      const [bindingA, bindingB] = memoryPair();
      let a: any, b: any;
      a = createBufferedChannel({ getSessionBinding: () => bindingA.getSessionBinding()!,
        send: msg => queueMicrotask(() => b.deliver(msg)),
        close: () => { a.signalClose(); delayedCloses.push(() => b.signalClose()); } });
      b = createBufferedChannel({ getSessionBinding: () => bindingB.getSessionBinding()!,
        send: msg => queueMicrotask(() => a.deliver(msg)),
        close: () => { b.signalClose(); delayedCloses.push(() => a.signalClose()); } });
      channels.push(a, b, bindingA, bindingB);
      const id = String(++next);
      pending.set(id, b);
      signaling.send({ type: 'offer', sdp: id });
      return a;
    },
    async accept({ offer, signal }: any) {
      if (offer.sdp === 'stall') return { channel: new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('closed')), { once: true })) };
      accepted++;
      const channel = pending.get(offer.sdp);
      pending.delete(offer.sdp);
      return { channel: Promise.resolve(channel) };
    },
  };
  const admission = createAdmissionGovernor({ active: 4, perScope: 2, reservedOutbound: 1 });
  const rooms = await Promise.all(ids.map(identity => joinRoom({ admission, roomId: 'cross', identity, url: null, transport })));
  try {
    for (const index of [0, 1]) {
      const [a, b] = memoryPair();
      rooms[index]!.mesh.addLink(a, ids[2]!.did);
      rooms[2]!.mesh.addLink(b, ids[index]!.did);
    }
    if (saturated) {
      // Occupy the higher DID room's entire unsolicited inbound allowance.
      const high = ids[0]!.did > ids[1]!.did ? 0 : 1;
      let off = () => {};
      const delivered = new Promise<void>(resolve => { off = rooms[high]!.mesh.onRelay(() => resolve()); });
      await rooms[2]!.mesh.relay(ids[high]!.did, ids[high]!.did, 'offer', 'stall', { type: 'offer', sdp: 'stall' });
      await delivered; off();
      expect(admission.stats().inbound).toBe(1);
    }
    // Both reservations exist before asynchronously signed offers reach broker.
    // A yielded outgoing call must wait for the replacing incoming handshake.
    await Promise.all([
      rooms[0]!.dialVia(ids[2]!.did, ids[1]!.did),
      rooms[1]!.dialVia(ids[2]!.did, ids[0]!.did),
    ]);
    expect(accepted).toBe(1);
    for (const close of delayedCloses.splice(0)) close();
    expect(rooms[0]!.mesh.hasLink(ids[1]!.did)).toBe(true);
    expect(rooms[1]!.mesh.hasLink(ids[0]!.did)).toBe(true);
  } finally {
    rooms.forEach(room => room.leave());
    channels.forEach(channel => channel.close());
    for (const close of delayedCloses.splice(0)) close();
  }
});
