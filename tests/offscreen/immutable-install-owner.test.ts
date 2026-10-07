import { test, expect } from 'bun:test';
import { createImmutableInstallOwner } from '../../extension/offscreen/immutable-install-owner.js';

test('two Home tabs share one live install and unknown outcomes cannot retry on absence', async () => {
  const owner = createImmutableInstallOwner(); let resolve!: (value:any)=>void; let calls = 0;
  const operation = () => { calls++; return new Promise(done => { resolve = done; }); };
  const one = owner.run('address', null, operation); const two = owner.run('address', null, operation);
  expect(one).toBe(two); await Promise.resolve(); expect(calls).toBe(1);
  resolve({ ok: true, app: { id: 'a' } }); await one;
  const error = Object.assign(new Error('lost receipt'), { outcomeKnown: false });
  await expect(owner.run('unknown', null, async () => { throw error; })).rejects.toBe(error);
  await expect(owner.run('unknown', null, async () => { calls++; })).rejects.toBe(error);
  expect(calls).toBe(1);
  expect(await owner.run('unknown', { id: 'receipt' }, operation)).toEqual({ ok: true, app: { id: 'receipt' } });
});

test('successful ownership does not cache deleted Apps and saturation refuses without eviction', async () => {
  const owner = createImmutableInstallOwner(); let calls = 0;
  const operation = async () => ({ ok: true, app: { id: String(++calls) } });
  expect((await owner.run('deleted', null, operation)).app.id).toBe('1');
  expect((await owner.run('deleted', null, operation)).app.id).toBe('2');
  for (let i = 0; i < 64; i++) await owner.run(String(i), null, async () => {
    throw Object.assign(new Error('unknown'), { outcomeKnown: false });
  }).catch(() => {});
  await expect(owner.run('extra', null, operation)).rejects.toThrow('reconciliation');
  await expect(owner.run('0', null, operation)).rejects.toThrow('unknown');
  expect(calls).toBe(2);
});
