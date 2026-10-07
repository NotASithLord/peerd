import { expect, test } from 'bun:test';
import { createAdmissionBudget, validRoomKey } from '../../signaling-node/admission-budget.js';

test('room keys are exact, bounded UTF8, and never normalized into another room', () => {
  for (const key of ['peerd/base/1', '__proto__', 'private room', 'é'.repeat(128)]) expect(validRoomKey(key)).toBe(true);
  for (const key of ['', null, 'x'.repeat(257), 'é'.repeat(129), 'a\n', 'a\0', 'a\x7f']) expect(validRoomKey(key)).toBe(false);
});

test('room and process ingress reserve atomically with bounded counters and clock rollback', () => {
  let time = 0;
  const budget = createAdmissionBudget({ now: () => time, limits: {
    roomMessages: 2, processMessages: 3, roomIngressBytes: 8, processIngressBytes: 12,
  } });
  expect(budget.join('a')).toBe(true); const a = budget.reserveSocket('a')!;
  expect(budget.join('b')).toBe(true); const b = budget.reserveSocket('b')!;
  expect(budget.ingress('a', 4)).toBe(true); expect(budget.ingress('a', 4)).toBe(true);
  const before = budget.stats();
  expect(budget.ingress('a', 1)).toBe(false); expect(budget.stats()).toEqual(before);
  expect(budget.ingress('b', 4)).toBe(true); expect(budget.ingress('b', 0)).toBe(false);
  for (const size of [-1, NaN, Infinity, 1.2]) expect(budget.ingress('a', size)).toBe(false);
  time = 10_000; expect(budget.ingress('a', 1)).toBe(true);
  time = 0; expect(budget.ingress('a', 1)).toBe(true); expect(budget.ingress('a', 1)).toBe(false);
  a(); b(); expect(budget.stats().live).toBe(0);
});

test('key and disconnect churn retain spent windows and bounded maps; socket reservations release once', () => {
  let time = 0;
  const budget = createAdmissionBudget({ now: () => time, limits: { rooms: 2, sockets: 1, roomJoins: 2, processJoins: 4 } });
  expect(budget.join('a')).toBe(true); const release = budget.reserveSocket('a')!;
  expect(budget.reserveSocket('a')).toBeNull(); release(); release();
  expect(budget.join('a')).toBe(true); expect(budget.join('a')).toBe(false);
  expect(budget.join('b')).toBe(true); expect(budget.join('c')).toBe(false);
  expect(budget.stats()).toMatchObject({ rooms: 2, live: 0, joins: 4 });
  time = 10_000; expect(budget.join('c')).toBe(true); expect(budget.stats().rooms).toBe(1);
});

test('egress rejects whole batches before debit, reserves control headroom and never refunds failed sends', () => {
  const budget = createAdmissionBudget({ now: () => 0, limits: { roomEgressFrames: 5, roomControlFrames: 2,
    processEgressFrames: 8, processControlFrames: 2, roomEgressBytes: 100, roomControlBytes: 20,
    processEgressBytes: 160, processControlBytes: 20 } });
  budget.join('a'); budget.reserveSocket('a'); budget.join('b'); budget.reserveSocket('b');
  expect(budget.egress('a', 3, 80)).toBe(true);
  const before = budget.stats(); expect(budget.egress('a', 1, 1)).toBe(false); expect(budget.stats()).toEqual(before);
  expect(budget.egress('b', 2, 50)).toBe(true);
  expect(budget.egress('b', 2, 1)).toBe(false); // process data frame reserve
  expect(budget.egress('a', 2, 20, true)).toBe(true);
  expect(budget.egress('b', 1, 10, true)).toBe(true);
  expect(budget.egress('b', 1, 0, true)).toBe(false);
  expect(budget.stats().egressFrames).toBe(8);
});

test('invalid budgets cannot disable hard admission or create negative credit', () => {
  for (const limits of [{ rooms: 0 }, { processMessages: Infinity }, { surprise: 1 },
    { roomEgressFrames: 128 }, { roomMessages: -1 }]) expect(() => createAdmissionBudget({ limits })).toThrow();
});

test('room map refusals consume process attempts without allocating negative entries', () => {
  const budget = createAdmissionBudget({ now: () => 0, limits: { rooms: 1, processJoins: 3 } });
  expect(budget.join('a')).toBe(true);
  expect(budget.join('b')).toBe(false);
  expect(budget.join('c')).toBe(false);
  expect(budget.join('a')).toBe(false);
  expect(budget.stats()).toMatchObject({ rooms: 1, joins: 3, live: 0 });
});
