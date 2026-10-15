import { expect, test } from 'bun:test';
import { createAppLaunchOwner } from '../../extension/shared/current-session-binding.js';

const fixture = (initial: string|null = null, fail = false) => {
  let current = initial;
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
    sessionGet: async () => current,
    sessionSet: async (key: string, value: any) => { if (key === 'currentSessionId') current = value; },
    sessionDelete: async () => { current = null; },
  });
  return { resolve, creates: () => creates, current: () => current, records };
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
