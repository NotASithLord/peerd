import { describe, expect, test } from 'bun:test';
import { createContentOwnership } from '../../extension/offscreen/content-ownership.js';

describe('content ownership', () => {
  test('shared bytes are released only after the last App owner leaves', () => {
    const ownership = createContentOwnership();
    expect(ownership.acquire('app-a', 'same-hash')).toBe(true);
    expect(ownership.acquire('app-b', 'same-hash')).toBe(true);
    expect(ownership.release('app-a', 'same-hash')).toEqual({ released: true, lastOwner: false });
    expect(ownership.hashesFor('app-b')).toEqual(['same-hash']);
    expect(ownership.release('app-b', 'same-hash')).toEqual({ released: true, lastOwner: true });
  });

  test('a failed duplicate install releases only its temporary claim', () => {
    const ownership = createContentOwnership();
    ownership.acquire('app-a', 'same-hash');
    ownership.acquire('install:1', 'same-hash');
    expect(ownership.release('install:1', 'same-hash')).toEqual({ released: true, lastOwner: false });
    expect(ownership.hashesFor('app-a')).toEqual(['same-hash']);
  });

  test('transferring a temporary claim is safe when the App already owns the hash', () => {
    const ownership = createContentOwnership();
    ownership.acquire('app-a', 'same-hash');
    ownership.acquire('update:1', 'same-hash');
    expect(ownership.transfer('update:1', 'app-a', 'same-hash')).toBe(true);
    expect(ownership.hashesFor('app-a')).toEqual(['same-hash']);
    expect(ownership.release('app-a', 'same-hash')).toEqual({ released: true, lastOwner: true });
  });
});
