import { expect, test } from 'bun:test';
import { createLinkReservations } from '../../extension/peerd-distributed/transport/link-reservations.js';

test('routing saturation leaves transfer capacity inside the same aggregate ceiling', () => {
  const pool = createLinkReservations({ total: 16, transfer: 2 });
  const routing = Array.from({ length: 14 }, () => pool.acquire('routing'));
  expect(routing.every(Boolean)).toBe(true);
  expect(pool.acquire('routing')).toBeNull();
  const first = pool.acquire('content'); const second = pool.acquire('content');
  expect(first).not.toBeNull(); expect(second).not.toBeNull();
  expect(pool.snapshot().occupied).toBe(16);
  expect(pool.acquire('content')).toBeNull();
  first!.release();
  expect(pool.acquire('routing')).toBeNull();
  expect(pool.acquire('content')).not.toBeNull();
  expect(pool.snapshot().occupied).toBe(16);
});

test('late cancellation cannot release a replacement or another owner slot', () => {
  const pool = createLinkReservations({ total: 4, transfer: 1 });
  const old = pool.acquire('content')!;
  expect(old.release()).toBe(true);
  const current = pool.acquire('content')!;
  expect(old.release()).toBe(false);
  expect(pool.acquire('content')).toBeNull();
  expect(pool.snapshot().content).toBe(1);
  expect(current.release()).toBe(true);
  expect(pool.snapshot().content).toBe(0);
});

test('shutdown fences admission while preserving outstanding ownership until IO cleanup', () => {
  const pool = createLinkReservations({ total: 4, transfer: 1 });
  const route = pool.acquire('routing')!; const content = pool.acquire('content')!;
  pool.stop();
  expect(pool.acquire('routing')).toBeNull(); expect(pool.acquire('content')).toBeNull();
  expect(pool.snapshot().occupied).toBe(2);
  route.release(); content.release();
  expect(pool.snapshot().occupied).toBe(0);
  expect(pool.acquire('routing')).toBeNull();
});

test('invalid reservations cannot silently increase ceilings or invent a traffic role', () => {
  for (const limits of [{ total: 0, transfer: 0 }, { total: 4, transfer: 4 },
    { total: 4, transfer: -1 }, { total: Infinity, transfer: 1 }, { total: 4, transfer: 0.5 }]) {
    expect(() => createLinkReservations(limits)).toThrow();
  }
  const pool = createLinkReservations({ total: 16, transfer: 0 });
  expect(pool.acquire('content')).toBeNull();
  expect(() => pool.acquire('unknown' as 'content')).toThrow();
  expect(pool.snapshot().occupied).toBe(0);
});
