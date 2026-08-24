import { describe, expect, test } from 'bun:test';
import {
  makeUiRuntimeClient,
  uiMessageIsRead,
} from '../../extension/shared/ui-runtime-client.js';

describe('bounded UI runtime client', () => {
  test('classifies reads without granting mutations replay safety', () => {
    for (const type of [
      'state/get', 'contacts/list', 'apps/repository/history', 'dweb/base/status',
      'models/options', 'openrouter/models',
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
});
