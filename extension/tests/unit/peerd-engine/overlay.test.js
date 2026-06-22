// @ts-check
// IDB overlay — read/write/reset roundtrip.
//
// Uses a fresh in-memory IDB factory per test via the indexedDB shim
// the test framework provides (the real browser IDB is namespaced by
// origin; the tests run from the extension origin so they share state
// — we randomize the dbname-equivalent via reset() between tests).

import { describe, it, expect } from '../../framework.js';
import { openOverlay } from '/peerd-engine/index.js';

describe('openOverlay', () => {
  it('writes a block and reads it back', async () => {
    const overlay = await openOverlay();
    await overlay.reset();   // start clean
    const fresh = await openOverlay();
    await fresh.write(0, new Uint8Array([1, 2, 3, 4]));
    const got = /** @type {Uint8Array} */ (await fresh.read(0));
    expect(got instanceof Uint8Array).toBe(true);
    expect(got.length).toBe(4);
    expect(got[0]).toBe(1);
    expect(got[3]).toBe(4);
    fresh.close();
  });

  it('returns null for an unwritten block', async () => {
    const overlay = await openOverlay();
    await overlay.reset();
    const fresh = await openOverlay();
    expect(await fresh.read(999)).toBe(null);
    fresh.close();
  });

  it('persists writes across open/close cycles', async () => {
    const overlay = await openOverlay();
    await overlay.reset();

    const a = await openOverlay();
    await a.write(7, new Uint8Array([42]));
    a.close();

    const b = await openOverlay();
    const got = await b.read(7);
    expect(got?.[0]).toBe(42);
    b.close();
  });

  it('reset() drops every block', async () => {
    const a = await openOverlay();
    await a.write(1, new Uint8Array([9]));
    await a.write(2, new Uint8Array([9]));
    await a.reset();

    const b = await openOverlay();
    expect(await b.read(1)).toBe(null);
    expect(await b.read(2)).toBe(null);
    b.close();
  });

  it('overwrites a block when the same index is written twice', async () => {
    const overlay = await openOverlay();
    await overlay.reset();
    const fresh = await openOverlay();
    await fresh.write(3, new Uint8Array([1]));
    await fresh.write(3, new Uint8Array([2, 2]));
    const got = /** @type {Uint8Array} */ (await fresh.read(3));
    expect(got.length).toBe(2);
    expect(got[0]).toBe(2);
    fresh.close();
  });
});
