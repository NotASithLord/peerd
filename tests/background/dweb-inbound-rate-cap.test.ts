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

  test('SLIDING window — no ~2x burst across the hour boundary (fixed-window weakness)', () => {
    // Regression for the audit finding: a FIXED window admits perHourGlobal in
    // the last seconds AND another full perHourGlobal right after an abrupt
    // reset. A sliding window caps the TRUE rate at perHourGlobal per rolling
    // hour, so straddling the boundary must NOT double the admits.
    const c = clock();
    const cap = makeDwebInboundRateCap({ now: c.now });
    // Fill the window near the end of the first hour.
    for (let i = 0; i < 30; i += 1) expect(cap.allow(`did:a${i}`)).toBe(true);
    expect(cap.allow('did:a-extra')).toBe(false);
    // Advance PAST a fixed 1h window edge but keep the earlier admits inside a
    // rolling hour (only +30s). A fixed window would reset and admit 30 more.
    c.advance(30_000);
    let burst = 0;
    for (let i = 0; i < 30; i += 1) if (cap.allow(`did:b${i}`)) burst += 1;
    expect(burst).toBe(0); // sliding window: the earlier 30 still count
    // Once the earliest admits truly age out (>1h), capacity returns normally.
    c.advance(3_600_001);
    expect(cap.allow('did:c')).toBe(true);
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
