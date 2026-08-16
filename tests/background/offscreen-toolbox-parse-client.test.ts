import { describe, expect, test } from 'bun:test';
import { makeOffscreenToolboxParseClient } from '../../extension/background/offscreen-toolbox-parse-client.js';

describe('offscreen toolbox parse client', () => {
  test('starts the exact host and forwards the candidate without rewriting it', async () => {
    const calls: unknown[] = [];
    const parse = makeOffscreenToolboxParseClient({
      ensureOffscreen: async () => { calls.push('ensure'); },
      sendMessage: async (message) => { calls.push(message); return { ok: true }; },
    });
    await parse('tables', 'export const rows = [];');
    expect(calls).toEqual([
      'ensure',
      { type: 'toolbox/parse-check', name: 'tables', body: 'export const rows = [];' },
    ]);
  });

  test('fails closed with the parser host error', async () => {
    const parse = makeOffscreenToolboxParseClient({
      ensureOffscreen: async () => {},
      sendMessage: async () => ({ ok: false, error: 'JavaScript syntax error: unexpected token' }),
    });
    await expect(parse('bad', 'return 1;')).rejects.toThrow('JavaScript syntax error');
  });
});
