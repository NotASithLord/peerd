import { expect, test } from 'bun:test';
import { createPresence } from '../../extension/peerd-distributed/gossip/presence.js';
import { createGossip } from '../../extension/peerd-distributed/gossip/topic.js';

test('autonomous presence owns a late signing failure after gossip shutdown', async () => {
  let resolve!: (env: any) => void, entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const signed = new Promise<any>(r => { resolve = r; });
  let broadcasts = 0;
  const gossip = createGossip({ mesh: {
    onEnvelope: () => () => {},
    sign: () => { entered(); return signed; },
    broadcast: async () => { broadcasts++; },
  } });
  const presence = createPresence({ gossip, selfDid: 'self' });
  presence.start(); await started;
  presence.close(); gossip.close();
  resolve({ sig: 'late-signature' });
  await new Promise(r => setTimeout(r, 0));
  expect(broadcasts).toBe(0);
  expect(gossip.hasSeen('late-signature')).toBe(false);
});

test('scheduled failure is retried while explicit announcement failures remain observable', async () => {
  let attempts = 0, recovered!: () => void;
  const nextBeat = new Promise<void>(r => { recovered = r; });
  const presence = createPresence({ selfDid: 'self', heartbeatMs: 10,
    gossip: {
      subscribe: () => () => {},
      publish: async () => { attempts++; if (attempts === 1) throw new Error('link-lost'); recovered(); },
    } });
  presence.start();
  try { await nextBeat; expect(attempts).toBeGreaterThanOrEqual(2); }
  finally { presence.close(); }
  const explicit = createPresence({ selfDid: 'self', gossip: {
    subscribe: () => () => {}, publish: async () => { throw new Error('explicit-publication-failed'); },
  } });
  await expect(explicit.announce()).rejects.toThrow('explicit-publication-failed');
  explicit.close();
});
