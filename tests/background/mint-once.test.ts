// Single-flight actor minting: concurrent mints of one key collapse onto one
// promise; a later mint after settlement starts fresh; distinct keys are independent.

import { describe, test, expect } from 'bun:test';
import { makeMintOnce } from '../../extension/background/mint-once.js';

describe('makeMintOnce', () => {
  test('concurrent mints of the SAME key run the fn once and share the result', async () => {
    const { mintOnce, _inFlightCount } = makeMintOnce();
    let calls = 0;
    let release: (v: string) => void = () => {};
    const fn = () => new Promise<string>((r) => { calls += 1; release = r; });
    const a = mintOnce('web:1', fn);
    const b = mintOnce('web:1', fn);
    expect(_inFlightCount()).toBe(1);
    release('sess-1');
    expect(await a).toBe('sess-1');
    expect(await b).toBe('sess-1');
    expect(calls).toBe(1);            // the racing second call did NOT re-run fn
    expect(_inFlightCount()).toBe(0); // entry cleared on settle
  });

  test('a mint AFTER the first settled runs fn again (no stale caching)', async () => {
    const { mintOnce } = makeMintOnce();
    let calls = 0;
    const fn = async () => { calls += 1; return `s${calls}`; };
    expect(await mintOnce('k', fn)).toBe('s1');
    expect(await mintOnce('k', fn)).toBe('s2');   // not deduped — the first already settled
    expect(calls).toBe(2);
  });

  test('distinct keys never collide', async () => {
    const { mintOnce } = makeMintOnce();
    const [a, b] = await Promise.all([
      mintOnce('web:1', async () => 'A'),
      mintOnce('web:2', async () => 'B'),
    ]);
    expect([a, b]).toEqual(['A', 'B']);
  });

  test('a rejected mint clears its entry so the next attempt can retry', async () => {
    const { mintOnce, _inFlightCount } = makeMintOnce();
    await expect(mintOnce('k', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(_inFlightCount()).toBe(0);
    expect(await mintOnce('k', async () => 'ok')).toBe('ok');
  });
});
