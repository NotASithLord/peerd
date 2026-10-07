import { expect, test } from 'bun:test';
import { createGossip, MAX_GOSSIP_ORIGIN_BUCKETS } from '../../extension/peerd-distributed/gossip/topic.js';

// The mesh has already authenticated origin signatures at this seam. Exercise
// accounting directly so thousands of origins do not become a crypto benchmark.
const harness = (rateBurst = 2, ratePerSec = 1) => {
  let clock = 0, sequence = 0, delivered = 0, forwarded = 0;
  let receive: ((message: any) => Promise<void>) | null = null;
  const audits: string[] = [];
  const gossip = createGossip({
    mesh: {
      onEnvelope: (callback: typeof receive) => { receive = callback; return () => { receive = null; }; },
      broadcast: async () => { forwarded++; },
    },
    now: () => clock, rateBurst, ratePerSec, audit: type => { audits.push(type); },
  });
  gossip.subscribe('feed', () => { delivered++; });
  return {
    gossip, audits, clock: (time: number) => { clock = time; },
    counts: () => ({ delivered, forwarded }),
    send: async (origin: string) => {
      const before = delivered;
      const env = { v: 1, ch: 4, typ: 0, from: origin, ts: clock, id: String(++sequence),
        sig: `signature-${sequence}`, body: { topic: 'feed', data: 'payload' } };
      await receive?.({ env, via: 'authenticated-relay' });
      return { accepted: delivered > before, signature: env.sig };
    },
  };
};
const fill = async (h: ReturnType<typeof harness>) => {
  for (let i = 0; i < MAX_GOSSIP_ORIGIN_BUCKETS; i++) await h.send(`origin-${i}`);
};

test('origin churn refuses admission at capacity without forgiving existing rate debt', async () => {
  const h = harness(); await fill(h);
  expect(h.counts().delivered).toBe(MAX_GOSSIP_ORIGIN_BUCKETS);
  expect((await h.send('origin-0')).accepted).toBe(true);
  for (let i = 0; i < MAX_GOSSIP_ORIGIN_BUCKETS * 2; i++) await h.send(`churn-${i}`);
  expect(h.counts()).toEqual({ delivered: MAX_GOSSIP_ORIGIN_BUCKETS + 1, forwarded: MAX_GOSSIP_ORIGIN_BUCKETS + 1 });
  expect((await h.send('origin-0')).accepted).toBe(false);
  // Capacity must not deny an established identity its remaining allowance.
  expect((await h.send('origin-1')).accepted).toBe(true);
  h.clock(1_000);
  expect((await h.send('origin-0')).accepted).toBe(true);
  expect((await h.send('origin-0')).accepted).toBe(false);
  expect((await h.send('new-origin')).accepted).toBe(false);
  expect(h.audits).toContain('gossip_rate_limited');
  h.gossip.close();
});

test('expiry admits new identities only after full refill and denied attempts cannot prolong retention', async () => {
  const h = harness(1, 1); await fill(h);
  h.clock(999);
  expect((await h.send('origin-0')).accepted).toBe(false);
  expect((await h.send('new-origin')).accepted).toBe(false);
  h.clock(1_000);
  expect((await h.send('new-origin')).accepted).toBe(true);
  expect((await h.send('origin-0')).accepted).toBe(true);
  expect((await h.send('origin-0')).accepted).toBe(false);
  h.gossip.close();
});

test('refreshing an old origin moves its expiry behind older debts without blocking expired peers', async () => {
  const h = harness(2, 1); await fill(h);
  expect((await h.send('origin-0')).accepted).toBe(true);
  h.clock(1_000);
  expect((await h.send('origin-0')).accepted).toBe(true);
  h.clock(2_000);
  expect((await h.send('new-origin')).accepted).toBe(true);
  // origin-0 is retained, so one accrued token is available, not a reset burst.
  expect((await h.send('origin-0')).accepted).toBe(true);
  expect((await h.send('origin-0')).accepted).toBe(false);
  h.gossip.close();
});

test('clock rollback neither forgives debt nor delays the original refill horizon', async () => {
  const h = harness(1, 1);
  h.clock(5_000); expect((await h.send('origin')).accepted).toBe(true);
  h.clock(4_000); expect((await h.send('origin')).accepted).toBe(false);
  h.clock(5_999); expect((await h.send('origin')).accepted).toBe(false);
  h.clock(6_000); expect((await h.send('origin')).accepted).toBe(true);
  h.gossip.close();
});

test('zero refill keeps exhausted origins charged across churn and time', async () => {
  const h = harness(1, 0); await fill(h);
  h.clock(1_000_000_000);
  expect((await h.send('new-origin')).accepted).toBe(false);
  expect((await h.send('origin-0')).accepted).toBe(false);
  h.gossip.close();
});

test('invalid clock refuses admission and closure releases retained public state', async () => {
  const h = harness();
  h.clock(NaN); expect((await h.send('origin')).accepted).toBe(false);
  h.clock(0); const message = await h.send('origin');
  expect(message.accepted).toBe(true);
  expect(h.gossip.hasSeen(message.signature)).toBe(true);
  h.gossip.mute('muted-origin');
  h.gossip.close();
  expect(h.gossip.hasSeen(message.signature)).toBe(false);
  expect(h.gossip.isMuted('muted-origin')).toBe(false);
  expect((await h.send('after-close')).accepted).toBe(false);
});

test('retired gossip refuses captured callbacks, backfill and late signing completions', async () => {
  let receive!: (message: any) => Promise<void>, finish!: (value: any) => void;
  let forwarded = 0, delivered = 0, signed = 0;
  const pendingSignature = new Promise<any>(resolve => { finish = resolve; });
  const gossip = createGossip({ mesh: {
    onEnvelope: (callback: typeof receive) => { receive = callback; return () => {}; },
    sign: () => { signed++; return pendingSignature; },
    broadcast: async () => { forwarded++; },
  } });
  gossip.subscribe('feed', () => { delivered++; });
  const publishing = gossip.publish('feed', 'local');
  const env = { v: 1, ch: 4, typ: 0, from: 'origin', ts: 0, id: 'late', sig: 'late-signature', body: { topic: 'feed', data: 'late' } };
  gossip.close();
  await receive({ env, via: 'relay' });
  expect(gossip.ingest(env)).toBe(false);
  finish(env);
  await expect(publishing).rejects.toThrow('gossip-closed');
  await expect(gossip.publish('feed', 'after-close')).rejects.toThrow('gossip-closed');
  expect(signed).toBe(1); expect(forwarded).toBe(0); expect(delivered).toBe(0);
  expect(gossip.hasSeen(env.sig)).toBe(false);
});

test('a subscriber closing its owner prevents forwarding the just-delivered frame', async () => {
  let receive!: (message: any) => Promise<void>; let forwarded = 0;
  const gossip = createGossip({ mesh: {
    onEnvelope: (callback: typeof receive) => { receive = callback; return () => {}; },
    broadcast: async () => { forwarded++; },
  } });
  gossip.subscribe('feed', () => gossip.close());
  await receive({ env: { ch: 4, typ: 0, from: 'origin', ts: 0, id: 'close', sig: 'close-signature', body: { topic: 'feed', data: null } }, via: 'relay' });
  expect(forwarded).toBe(0); expect(gossip.hasSeen('close-signature')).toBe(false);
});
