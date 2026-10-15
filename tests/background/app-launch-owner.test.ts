import { expect, test } from 'bun:test';
import { createAppLaunchOwner } from '../../extension/shared/current-session-binding.js';

test('concurrent first opens share a persisted and bound owner without provider IO', async () => {
  const events: string[] = [];
  const records = new Set<string>();
  let current: string|null = null;
  const resolve = createAppLaunchOwner({
    current: async () => current,
    resolve: async id => records.has(id) ? id : null,
    create: async () => { events.push('create'); records.add('root'); return {sessionId:'root'}; },
    bind: async session => { events.push('bind'); current = session.sessionId; },
  });
  expect(await Promise.all([resolve(null), resolve(null)])).toEqual(['root', 'root']);
  expect(events).toEqual(['create', 'bind']);
  expect(await resolve(null)).toBe('root');
  expect(events).toEqual(['create', 'bind']);
});

test('an invalid explicit or current owner never gets replaced', async () => {
  let created = false;
  const resolve = createAppLaunchOwner({
    current: async () => 'missing', resolve: async () => null,
    create: async () => { created = true; return {sessionId:'new'}; }, bind: async () => {},
  });
  await expect(resolve('missing')).rejects.toThrow('app-owner-unavailable');
  await expect(resolve(null)).rejects.toThrow('app-owner-unavailable');
  expect(created).toBe(false);
});

test('a failed durable creation refuses every waiting launch', async () => {
  let bound = false;
  const resolve = createAppLaunchOwner({
    current: async () => null, resolve: async id => id,
    create: async () => { throw new Error('storage-failed'); },
    bind: async () => { bound = true; },
  });
  const results = await Promise.allSettled([resolve(null), resolve(null)]);
  expect(results.map(r => r.status)).toEqual(['rejected', 'rejected']);
  expect(bound).toBe(false);
});
