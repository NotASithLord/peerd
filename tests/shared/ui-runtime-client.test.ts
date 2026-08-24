import { describe, expect, test } from 'bun:test';
import {
  makeUiRuntimeClient,
  redrawForRuntimeMessage,
  settleUiEffect,
  uiMessageIsRead,
} from '../../extension/shared/ui-runtime-client.js';

describe('bounded UI runtime client', () => {
  test('classifies reads without granting mutations replay safety', () => {
    for (const type of [
      'state/get', 'contacts/list', 'apps/repository/history', 'dweb/base/status',
      'models/options', 'openrouter/models', 'composer/files', 'composer/tabs',
      'memory/export', 'memory/suggestions', 'local-model/catalog', 'local-model/probe',
      'session/debugBundle', 'session/contextSnapshots', 'import/inspect', 'app/get-meta',
      'vault/prfStatus', 'pod/get-meta', 'vm/get-meta', 'transfer/inspectImport',
      'export/artifact',
    ]) {
      expect(uiMessageIsRead(type)).toBe(true);
    }
    for (const type of ['agent/send', 'contacts/set', 'apps/repository/push', 'dweb/base/install']) {
      expect(uiMessageIsRead(type)).toBe(false);
    }
  });

  test('a never-settling read times out known-safe while an effect stays unknown', async () => {
    const client = makeUiRuntimeClient({
      browser: { runtime: { sendMessage: async () => new Promise(() => {}) } },
      readTimeoutMs: 5, effectTimeoutMs: 5, longEffectTimeoutMs: 5,
    });
    await expect(client.send({ type: 'apps/list' })).rejects.toMatchObject({
      code: 'ui-runtime-timeout', outcomeKnown: true,
    });
    await expect(client.send({ type: 'apps/delete' })).rejects.toMatchObject({
      code: 'ui-runtime-timeout', outcomeKnown: false, retryable: false,
    });
  });

  test('runtime rejection is bounded human copy and never leaks transport detail', async () => {
    const client = makeUiRuntimeClient({
      browser: { runtime: { sendMessage: async () => { throw new Error('private epoch H-123'); } } },
      readTimeoutMs: 50, effectTimeoutMs: 50, longEffectTimeoutMs: 50,
    });
    const failure = await client.send({ type: 'agent/send' }).catch((cause) => cause);
    expect(failure).toMatchObject({
      code: 'ui-runtime-transport-lost', outcomeKnown: false, retryable: false,
    });
    expect(failure.message).not.toContain('H-123');
  });

  test('late settlement after the deadline cannot change the returned outcome', async () => {
    let resolve!: (value: unknown) => void;
    const client = makeUiRuntimeClient({
      browser: { runtime: { sendMessage: () => new Promise((done) => { resolve = done; }) } },
      readTimeoutMs: 5, effectTimeoutMs: 5, longEffectTimeoutMs: 5,
    });
    const result = client.send({ type: 'settings/update' }).catch((cause) => cause);
    await new Promise((done) => setTimeout(done, 10));
    resolve({ ok: true });
    await expect(result).resolves.toMatchObject({ outcomeKnown: false });
  });

  test('artifact export is a long read', async () => {
    let delay = 0;
    const client = makeUiRuntimeClient({
      browser: { runtime: { sendMessage: async () => new Promise(() => {}) } },
      readTimeoutMs: 5,
      effectTimeoutMs: 10,
      longEffectTimeoutMs: 25,
      setTimeoutFn: ((callback: () => void, timeout?: number) => {
        delay = timeout ?? 0;
        return setTimeout(callback, 0);
      }) as typeof setTimeout,
    });
    await expect(client.send({ type: 'export/artifact' })).rejects.toMatchObject({
      code: 'ui-runtime-timeout', outcomeKnown: true,
    });
    expect(delay).toBe(25);
  });

  test('ignored controls settle rejected effects', async () => {
    let caught = false;
    const failure = Promise.reject(new Error('lost')).catch((cause) => {
      caught = true;
      throw cause;
    });
    expect(settleUiEffect(failure)).toBeUndefined();
    await Promise.resolve();
    await Promise.resolve();
    expect(caught).toBe(true);
  });

  test('only deltas use animation-frame redraws', () => {
    let scheduled = 0;
    let synced = 0;
    const redraw = Object.assign(() => { scheduled += 1; }, {
      sync: () => { synced += 1; },
    });

    redrawForRuntimeMessage(redraw, { type: 'turn/delta' });
    redrawForRuntimeMessage(redraw, { type: 'turn/spawned-delta' });
    redrawForRuntimeMessage(redraw, { type: 'turn/streaming', streaming: true });
    redrawForRuntimeMessage(redraw, { type: 'turn/streaming', streaming: false });
    redrawForRuntimeMessage(redraw, { type: 'state' });

    expect(scheduled).toBe(2);
    expect(synced).toBe(3);
  });
});
