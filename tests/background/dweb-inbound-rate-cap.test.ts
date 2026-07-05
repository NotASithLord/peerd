// The dweb agent's inbound wake rate cap: per-did minute cap + global hour cap,
// sliding windows, and dead-did eviction — all driven by an injected clock.

import { describe, test, expect } from 'bun:test';
import { makeDwebInboundRateCap } from '../../extension/background/dweb-inbound-rate-cap.js';

const clock = (start = 1_000_000) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
};

describe('makeDwebInboundRateCap — per-did minute cap', () => {
  test('admits 3 wakes from one did, then blocks the 4th within the minute', () => {
    const c = clock();
    const cap = makeDwebInboundRateCap({ now: c.now });
    expect(cap.allow('did:a')).toBe(true);
    expect(cap.allow('did:a')).toBe(true);
    expect(cap.allow('did:a')).toBe(true);
    expect(cap.allow('did:a')).toBe(false);   // 4th in the same minute
  });

  test('the per-did window slides — after 60s the did admits again', () => {
    const c = clock();
    const cap = makeDwebInboundRateCap({ now: c.now });
    cap.allow('did:a'); cap.allow('did:a'); cap.allow('did:a');
    expect(cap.allow('did:a')).toBe(false);
    c.advance(61_000);
    expect(cap.allow('did:a')).toBe(true);    // old timestamps aged out
  });

  test('one did being capped does not block a different did', () => {
    const c = clock();
    const cap = makeDwebInboundRateCap({ now: c.now });
    cap.allow('did:a'); cap.allow('did:a'); cap.allow('did:a');
    expect(cap.allow('did:a')).toBe(false);
    expect(cap.allow('did:b')).toBe(true);
  });
});

describe('makeDwebInboundRateCap — global hour cap', () => {
  test('blocks past 30 wakes across many dids within the hour', () => {
    const c = clock();
    const cap = makeDwebInboundRateCap({ now: c.now });
    let admitted = 0;
    // 30 distinct dids, one wake each (well under the per-did cap) → 30 admits.
    for (let i = 0; i < 40; i += 1) if (cap.allow(`did:${i}`)) admitted += 1;
    expect(admitted).toBe(30);
    expect(cap.allow('did:fresh')).toBe(false);   // global cap hit
  });

  test('the global window resets after an hour', () => {
    const c = clock();
    const cap = makeDwebInboundRateCap({ now: c.now });
    for (let i = 0; i < 30; i += 1) cap.allow(`did:${i}`);
    expect(cap.allow('did:x')).toBe(false);
    c.advance(3_600_001);
    expect(cap.allow('did:x')).toBe(true);
  });
});

describe('makeDwebInboundRateCap — eviction', () => {
  test('dids whose timestamps all aged out are swept, bounding the map', () => {
    const c = clock();
    const cap = makeDwebInboundRateCap({ now: c.now });
    cap.allow('did:old');
    expect(cap._liveDids()).toBe(1);
    c.advance(61_000);
    cap.allow('did:new');           // admit sweeps the stale did:old
    expect(cap._liveDids()).toBe(1);
  });
});
