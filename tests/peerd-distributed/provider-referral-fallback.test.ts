import { test, expect } from 'bun:test';
import { generateIdentity } from '../../extension/peerd-distributed/identity/keypair.js';
import { nodeIdOf } from '../../extension/peerd-distributed/dht/distance.js';
import { createDhtStore } from '../../extension/peerd-distributed/dht/store.js';
import { createDhtNode } from '../../extension/peerd-distributed/dht/node.js';
import { makeDhtDialer } from '../../extension/peerd-distributed/transport/dht-dialer.js';

test('provider lookup retains an alternate responder when the first broker cannot reach the seeder', async () => {
  const [reader, provider, first, second] = await Promise.all(Array.from({ length: 4 }, () => generateIdentity()));
  const node = createDhtNode({ identity: reader, selfId: await nodeIdOf(reader.did), store: createDhtStore(),
    rpc: async () => ({ t: 'PROVIDERS', providers: [provider.did], nodes: [] }),
  });
  await node.learn(first.did);
  await node.learn(second.did);
  const contacts = await node.findProviderContacts('ab'.repeat(32));
  expect(contacts).toHaveLength(1);
  const stale = contacts[0].hints.broker;
  const reachable = stale === first.did ? second.did : first.did;
  const links = new Set([first.did, second.did]);
  const attempts: string[] = [];
  // The DHT and dialer are real; only the already-authenticated room's IO is
  // injected. A stale provider index does not imply its broker still has an edge.
  const room = { mesh: { hasLink: (did: string) => links.has(did),
    requestRoster: async (broker: string) => broker === reachable ? [provider.did] : [] },
    dialVia: async (broker: string, target: string) => {
      attempts.push(broker);
      if (broker !== reachable) throw new Error('target no longer linked');
      expect(target).toBe(provider.did);
      links.add(target);
    },
  } as unknown as Parameters<typeof makeDhtDialer>[0];
  expect(await makeDhtDialer(room)(contacts[0])).toBe(true);
  expect(attempts).toEqual([reachable]);
  expect(links.has(provider.did)).toBe(true);
});

test('a stalled roster cannot delay a responsive alternate and its request is cancelled after success', async () => {
  let stalledSignal: AbortSignal | undefined;
  const links = new Set(['stalled', 'useful']);
  const room = { mesh: { hasLink: (did: string) => links.has(did),
    requestRoster: (broker: string, { signal }: { signal: AbortSignal }) => {
      if (broker === 'useful') return Promise.resolve(['target']);
      stalledSignal = signal;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } }, dialVia: async (_broker: string, target: string) => { links.add(target); },
  } as unknown as Parameters<typeof makeDhtDialer>[0];
  expect(await makeDhtDialer(room)({ did: 'target', hints: { broker: 'stalled' }, brokers: ['stalled', 'useful'] })).toBe(true);
  expect(stalledSignal?.aborted).toBe(true);
});

test('cancellation stops all roster requests before any relay dial', async () => {
  const controller = new AbortController();
  const signals: AbortSignal[] = [];
  let dials = 0;
  const room = { mesh: { hasLink: (did: string) => did !== 'target',
    requestRoster: (_broker: string, { signal }: { signal: AbortSignal }) => {
      signals.push(signal);
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    } }, dialVia: async () => { dials++; },
  } as unknown as Parameters<typeof makeDhtDialer>[0];
  const operation = makeDhtDialer(room)({ did: 'target', brokers: ['a', 'b', 'c', 'd'] }, { signal: controller.signal });
  expect(signals).toHaveLength(3);
  controller.abort();
  expect(await operation).toBe(false);
  expect(signals.every(signal => signal.aborted)).toBe(true);
  expect(dials).toBe(0);
});

test('provider routes are bounded local responders, not hints supplied on the wire', async () => {
  const [reader, provider, ...brokers] = await Promise.all(Array.from({ length: 10 }, () => generateIdentity()));
  const node = createDhtNode({ identity: reader, selfId: await nodeIdOf(reader.did), store: createDhtStore(),
    rpc: async () => ({ t: 'PROVIDERS', providers: [provider.did], nodes: [
      { did: provider.did, brokers: ['forged'], hints: { broker: 'forged', brokers: ['forged'] } },
    ] }),
  });
  for (const broker of brokers) await node.learn(broker.did);
  const contacts = await node.findProviderContacts('ab'.repeat(32));
  expect(contacts).toHaveLength(1);
  expect(contacts[0].brokers).toHaveLength(3);
  expect(new Set(contacts[0].brokers).size).toBe(3);
  expect(contacts[0].brokers?.every(did => brokers.some(broker => broker.did === did) || did === provider.did)).toBe(true);
  expect(contacts[0].brokers).not.toContain('forged');
});


test('content referral fallback preserves the caller lease after roster cleanup', async () => {
  const caller = new AbortController();
  let rosterSignal: AbortSignal | undefined;
  let leaseSignal: AbortSignal | null | undefined;
  let released = false;
  const room = {
    contentTransfersEnabled: true,
    mesh: {
      hasLink: (did: string) => did === 'stale' || did === 'useful',
      hasContentLink: () => false,
      requestRoster: async (broker: string, {signal}: {signal: AbortSignal}) => {
        rosterSignal = signal;
        return broker === 'useful' ? ['target'] : [];
      },
    },
    acquireContentVia: async (broker: string, target: string, options: {signal: AbortSignal, leaseSignal?: AbortSignal|null}) => {
      expect(broker).toBe('useful');
      expect(target).toBe('target');
      expect(options.signal.aborted).toBe(false);
      leaseSignal = options.leaseSignal;
      return {release(){ released = true; }};
    },
  } as unknown as Parameters<typeof makeDhtDialer>[0];
  const lease = await makeDhtDialer(room).acquireContent!({did:'target',brokers:['stale','useful']},{signal:caller.signal});
  expect(rosterSignal?.aborted).toBe(true);
  expect(leaseSignal).toBe(caller.signal);
  expect(leaseSignal?.aborted).toBe(false);
  expect(released).toBe(false);
  lease.release();
  expect(released).toBe(true);
});
