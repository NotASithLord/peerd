import { expect, test } from 'bun:test';
import { createDurableRoomBudget, ROOM_BUDGET_KEY } from '../../signaling-node/durable-room-budget.js';

const durable = () => {
  const values = new Map<string, any>();
  let tail = Promise.resolve();
  const storage = { transaction(run: (tx: any) => Promise<any>) {
    const result = tail.then(async () => {
      const staged = new Map(values);
      const result = await run({ get: async (key: string) => structuredClone(staged.get(key)),
        put: async (key: string, value: any) => staged.set(key, structuredClone(value)) });
      values.clear(); for (const [key, value] of staged) values.set(key, value);
      return result;
    });
    tail = result.then(() => {}, () => {}); return result;
  } };
  return { storage, values };
};

test('independent room owners debit a single durable transaction record without lost credit', async () => {
  const f = durable();
  const make = () => createDurableRoomBudget(f.storage, { now: () => 0, limits: { roomMessages: 2, roomIngressBytes: 5 } });
  const results = await Promise.all([make().ingress(3), make().ingress(2), make().ingress(1)]);
  expect(results).toEqual([true, true, false]);
  expect(f.values.get(ROOM_BUDGET_KEY).used).toMatchObject({ messages: 2, ingressBytes: 5 });
  expect(await make().ingress(0)).toBe(false);
});

test('join credit, backward-clock clamp and expiry survive reconstructed budget owners', async () => {
  const f = durable(); let time = 0;
  const make = () => createDurableRoomBudget(f.storage, { now: () => time, limits: { roomJoins: 1 } });
  expect(await make().join()).toBe(true); expect(await make().join()).toBe(false);
  time = 10_000; expect(await make().join()).toBe(true);
  time = 0; expect(await make().join()).toBe(false);
  expect(f.values.size).toBe(1);
});

test('whole egress batch commits atomically and preserves final control credit', async () => {
  const f = durable(); const make = () => createDurableRoomBudget(f.storage, { now: () => 0,
    limits: { roomEgressFrames: 4, roomControlFrames: 1, roomEgressBytes: 10, roomControlBytes: 2 } });
  expect(await make().egress(3, 8)).toBe(true);
  const before = structuredClone(f.values.get(ROOM_BUDGET_KEY));
  expect(await make().egress(2, 1, true)).toBe(false);
  expect(f.values.get(ROOM_BUDGET_KEY)).toEqual(before);
  expect(await make().egress(1, 2, true)).toBe(true);
  expect(await make().egress(1, 0, true)).toBe(false);
  expect(await make().egress(0, 0)).toBe(true);
});

test('corrupt or foreign durable state never silently grants a fresh window', async () => {
  const f = durable(); const make = () => createDurableRoomBudget(f.storage, { now: () => 100_000 });
  await make().join(); const valid = f.values.get(ROOM_BUDGET_KEY);
  for (const invalid of [null, {}, { ...valid, version: 2 }, { ...valid, clock: NaN },
    { ...valid, epoch: -1 }, { ...valid, windowMs: 1 }, { ...valid, extra: true },
    Object.assign([], valid), { ...valid, used: Object.assign([], valid.used) },
    { ...valid, used: { ...valid.used, extra: 1 } },
    { ...valid, used: { ...valid.used, joins: Number.MAX_SAFE_INTEGER } }, { ...valid, used: { ...valid.used, joins: -1 } }]) {
    f.values.set(ROOM_BUDGET_KEY, invalid);
    await expect(make().join()).rejects.toThrow('persisted room budget');
    expect(f.values.get(ROOM_BUDGET_KEY)).toEqual(invalid);
  }
});

test('transaction failure grants no credit and invalid debit inputs never reach storage', async () => {
  let calls = 0;
  const budget = createDurableRoomBudget({ transaction: async () => { calls++; throw new Error('unavailable'); } });
  await expect(budget.ingress(1)).rejects.toThrow('unavailable');
  for (const value of [-1, Infinity, NaN, 0.5]) await expect(budget.ingress(value)).rejects.toThrow('invalid room debit');
  expect(calls).toBe(1);
});
