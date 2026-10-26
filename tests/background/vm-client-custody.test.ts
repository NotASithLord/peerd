import { describe, expect, test } from 'bun:test';
import { createVmClient } from '../../extension/background/vm-client.js';
import { HOST_EFFECT_OUTCOME } from '../../extension/background/host-effect-verdict.js';

const success = { ok: true, result: { stdout: '', stderr: '', exitCode: 0, durationMs: 1 } };
const exited = { ok: false, shellExited: true, error: 'VMNotReadyError: shell not ready' };
const stopped = { ok: false, error: 'persistent shell exited (3); command outcome unknown' };
const harness = (plan: (object | 'hang')[], now = 1, failReboot = false) => {
  let ensures = 0;
  const calls: { tabId: number; message: any }[] = [];
  const events: string[] = [];
  const registry = { get: async (id: string) => ({ id }) };
  const tracker = {
    getTabId: () => 7,
    ensureTab: async () => { if (++ensures > 1 && failReboot) throw new Error('boot timed out'); return 7; },
    markReloading: (id: string) => { events.push(`mark:${id}`); },
    reloadTab: async (id: string) => { events.push(`reload:${id}`); return true; },
  };
  const client = createVmClient({
    registry: registry as any, tracker: tracker as any, now: () => now,
    messageTimeoutMs: 15, readyProbeMs: 15, idleProbeMs: 1000,
    sendTabMessage: async (tabId, message) => {
      const index = calls.length;
      calls.push({ tabId, message }); events.push((message as any).type);
      return plan[index] === 'hang' ? new Promise(() => {}) : plan[index];
    },
  });
  return { client, calls, events };
};
const failure = (pending: Promise<unknown>) => pending.then(() => null, (error: any) => error);

describe('VM client command custody', () => {
  test('dead-shell refusals preserve the queue without reload or replay', async () => {
    const h = harness([exited, exited, success]);
    const bytes = new TextEncoder().encode('café 日本 ✓ 🚀 ħ ‧');
    const results = await Promise.all([
      failure(h.client.run('pwd', { vmId: 'vm-a' })),
      failure(h.client.writeFile('/tmp/café.txt', bytes, { vmId: 'vm-a' })),
    ]);
    for (const error of results) {
      expect(error).toMatchObject({ outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: false });
      expect(HOST_EFFECT_OUTCOME.vmExecution.rejected(error)).toBe('not-performed');
    }
    expect(h.events).toEqual(['vm/run', 'vm/write-file']);
    expect(h.calls.map(({ tabId, message }) => [tabId, message.vmId])).toEqual([[7, 'vm-a'], [7, 'vm-a']]);
    expect(h.calls[0].message.cmd).toBe('pwd');
    expect(h.calls[1].message.path).toBe('/tmp/café.txt');
    expect(new Uint8Array(atob(h.calls[1].message.b64).split('').map((char) => char.charCodeAt(0)))).toEqual(bytes);
  });

  test('a dead-shell write stops with its exact path and bytes', async () => {
    const h = harness([exited, { ok: true }]);
    const bytes = new TextEncoder().encode('日本 ✓ 🚀');
    const error = await failure(h.client.writeFile('/tmp/café.txt', bytes, { vmId: 'vm-a' }));
    expect(error).toMatchObject({ outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: false });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].message.path).toBe('/tmp/café.txt');
    expect(new Uint8Array(atob(h.calls[0].message.b64).split('').map((char) => char.charCodeAt(0)))).toEqual(bytes);
    expect(h.events).toEqual(['vm/write-file']);
  });

  test('one proven dead-shell refusal stops with known no effect', async () => {
    const h = harness([exited, exited, success]);
    const error = await failure(h.client.run('pwd', { vmId: 'vm-a' }));
    expect(error).toMatchObject({ outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: false });
    expect(HOST_EFFECT_OUTCOME.vmExecution.rejected(error)).toBe('not-performed');
    expect(h.calls).toHaveLength(1);
    expect(h.events).toEqual(['vm/run']);
  });

  test('an idle dead-shell probe stops before reload and command dispatch', async () => {
    const h = harness([{ ok: true, ready: false, shellExited: true }, success], 50_000, true);
    const error = await failure(h.client.run('printf x >> counter', { vmId: 'vm-a' }));
    expect(error).toMatchObject({ outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: false });
    expect(error.message).toContain('command was not sent');
    expect(HOST_EFFECT_OUTCOME.vmExecution.rejected(error)).toBe('not-performed');
    expect(h.calls).toHaveLength(1);
    expect(h.events).toEqual(['vm/is-ready']);
  });

  test('a channel timeout stays unknown after one send', async () => {
    const h = harness(['hang', exited]);
    const error = await failure(h.client.run('printf x >> counter', { vmId: 'vm-a' }));
    expect(error?.message).toContain('timed out');
    expect(HOST_EFFECT_OUTCOME.vmExecution.rejected(error)).toBe('unknown');
    expect(h.calls).toHaveLength(1);
    expect(h.events).toEqual(['vm/run']);
  });

  for (const reply of [stopped, { ok: false, error: 'VMRunTimeoutError: cmd timed out' }, { ok: false, error: 'write failed' }]) {
    test(`does not replay an unproved failure: ${reply.error}`, async () => {
      const h = harness([reply, success]);
      const error = await failure(h.client.run('printf x >> counter; exit 3', { vmId: 'vm-a' }));
      expect(HOST_EFFECT_OUTCOME.vmExecution.rejected(error)).toBe('unknown');
      expect(h.calls).toHaveLength(1);
      expect(h.events).toEqual(['vm/run']);
    });
  }

  test('isReady reports a dead shell without reload', async () => {
    const h = harness([{ ok: true, ready: false }]);
    expect(await h.client.isReady({ vmId: 'vm-a' })).toBe(false);
    expect(h.events).toEqual(['vm/is-ready']);
  });

  test('an idle probe can reload before the first command dispatch', async () => {
    const h = harness([{ ok: true, ready: false }, success], 50_000);
    await h.client.run('pwd', { vmId: 'vm-a' });
    expect(h.events).toEqual(['vm/is-ready', 'mark:vm-a', 'reload:vm-a', 'vm/run']);
  });
});
