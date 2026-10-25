import { expect, test } from 'bun:test';
import { createAppLaunchOwner } from '../../extension/shared/current-session-binding.js';

const fixture = (initial: string|null = null, fail = false, pending: Record<string, unknown> = {}) => {
  const cache = new Map<string, unknown>(Object.entries(pending));
  if (initial) cache.set('currentSessionId', initial);
  let creates = 0;
  const records = new Map<string, any>();
  const resolve = createAppLaunchOwner({
    get: async (id: string) => records.get(id),
    create: async (options: any) => {
      creates++;
      if (fail) throw new Error('storage-failed');
      const session = { ...options, sessionId: 'root' };
      records.set('root', session);
      return session;
    },
  }, {
    sessionGet: async (key: string) => cache.get(key),
    sessionSet: async (key: string, value: any) => { cache.set(key, value); },
    sessionDelete: async (key: string) => { cache.delete(key); },
  });
  return { resolve, creates: () => creates, current: () => cache.get('currentSessionId') ?? null, records, cache };
};

test('concurrent first opens share a persisted and bound owner without provider IO', async () => {
  const f = fixture();
  expect(await Promise.all([f.resolve(null), f.resolve(null)])).toEqual(['root', 'root']);
  expect(f.creates()).toBe(1);
  expect(f.current()).toBe('root');
  expect(await f.resolve(null)).toBe('root');
  expect(f.creates()).toBe(1);
});

test('an invalid explicit or current owner never gets replaced', async () => {
  const f = fixture('missing');
  await expect(f.resolve('missing')).rejects.toThrow('app-owner-unavailable');
  await expect(f.resolve(null)).rejects.toThrow('app-owner-unavailable');
  expect(f.creates()).toBe(0);
});

test('a failed durable creation refuses every waiting launch', async () => {
  const f = fixture(null, true);
  const results = await Promise.allSettled([f.resolve(null), f.resolve(null)]);
  expect(results.map(r => r.status)).toEqual(['rejected', 'rejected']);
  expect(f.current()).toBeNull();
});

test.each([
  { label: 'Plan', mode: 'plan', confirm: false, expected: { permissionMode: 'plan', confirmActions: false } },
  { label: 'Act with confirmation', mode: 'act', confirm: true, expected: { permissionMode: 'act', confirmActions: true } },
  { label: 'unset defaults', mode: undefined, confirm: undefined, expected: { permissionMode: 'act', confirmActions: false } },
  { label: 'invalid null values', mode: null, confirm: null, expected: { permissionMode: 'plan', confirmActions: true } },
  { label: 'invalid values', mode: 'invalid', confirm: 'off', expected: { permissionMode: 'plan', confirmActions: true } },
])('first App owner keeps $label without provider fields', async ({ mode, confirm, expected }) => {
  const f = fixture(null, false, { currentPermissionMode: mode, currentConfirmActions: confirm });
  expect(await Promise.all([f.resolve(null), f.resolve(null)])).toEqual(['root', 'root']);
  expect(f.creates()).toBe(1);
  expect(f.records.get('root')).toEqual({ ...expected, sessionId: 'root' });
  expect(Object.fromEntries(f.cache)).toEqual({
    currentSessionId: 'root', currentPermissionMode: expected.permissionMode,
    currentConfirmActions: expected.confirmActions,
  });
  f.cache.set('currentPermissionMode', 'act');
  f.cache.set('currentConfirmActions', false);
  expect(await f.resolve(null)).toBe('root');
  expect(f.records.get('root')).toEqual({ ...expected, sessionId: 'root' });
  expect(f.creates()).toBe(1);
});
