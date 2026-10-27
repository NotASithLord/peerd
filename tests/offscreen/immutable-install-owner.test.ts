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

test('cancel before commit aborts retrieval, fences effects and permits a distinct retry', async () => {
  const owner = createImmutableInstallOwner(); let control: any; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); let effects = 0;
  const result = owner.run('address', null, async current => {
    control = current; await gate; current.beginCommit(); effects++; return { ok: true };
  }).catch(error => error);
  await Promise.resolve();
  const attempt = owner.status('address')!;
  expect(attempt.cancellable).toBe(true);
  expect(owner.cancel('address', attempt.id).ok).toBe(true);
  expect(control.signal.aborted).toBe(true);
  expect(owner.status('address')?.phase).toBe('cancelling');
  release(); const error = await result;
  expect(error.name).toBe('AbortError'); expect(error.outcomeKnown).toBe(true);
  expect(effects).toBe(0); expect(owner.status('address')).toBeNull();
  let finish!: () => void; const waiting = new Promise<void>(resolve => { finish = resolve; });
  const retry = owner.run('address', null, async current => { await waiting; current.beginCommit(); return { ok: true }; });
  expect(owner.status('address')?.id).not.toBe(attempt.id);
  expect(owner.cancel('address', attempt.id).ok).toBe(false);
  finish(); expect((await retry).ok).toBe(true);
});

test('commit and unknown receipts are never cancellable or silently retryable', async () => {
  const owner = createImmutableInstallOwner(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const unknown = Object.assign(new Error('commit receipt lost'), { outcomeKnown: false });
  const result = owner.run('address', null, async current => {
    current.beginCommit(); await gate; throw unknown;
  }).catch(error => error);
  await Promise.resolve(); const attempt = owner.status('address')!;
  expect(attempt.phase).toBe('committing'); expect(attempt.cancellable).toBe(false);
  expect(owner.cancel('address', attempt.id).ok).toBe(false);
  release(); expect(await result).toBe(unknown);
  expect(owner.status('address')?.phase).toBe('unknown');
  expect(owner.cancel('address', attempt.id).ok).toBe(false);
  await expect(owner.run('address', null, async () => ({ ok: true }))).rejects.toBe(unknown);
});

test('progress snapshots omit arbitrary payloads and stop changing after cancellation', async () => {
  const owner = createImmutableInstallOwner(); let control: any; let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const result = owner.run('address', null, async current => { control = current; await wait; current.beginCommit(); }).catch(error => error);
  await Promise.resolve();
  control.progress({ phase: 'chunk', done: 2, total: 4, payload: 'peer text' });
  const snapshot = owner.status('address')!;
  expect(snapshot.progress).toEqual({ phase: 'chunk', done: 2, total: 4 });
  snapshot.progress.done = 99;
  expect(owner.status('address')?.progress.done).toBe(2);
  control.progress({ phase: 'peer text', done: 0, total: 4 });
  expect(owner.status('address')?.progress.phase).toBe('chunk');
  owner.cancel('address', snapshot.id);
  control.progress({ phase: 'verifying' });
  expect(owner.status('address')?.progress.phase).toBe('chunk');
  release(); expect((await result).name).toBe('AbortError');
});
