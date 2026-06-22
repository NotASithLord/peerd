// @ts-check
// Ollama adapter — in-browser coverage.
//
// The bun suite (tests/peerd-provider/ollama-adapter.test.ts) pins the
// error mapping and /api/tags parse; THIS suite exercises the adapter's
// end-to-end streaming path in a real browser — text deltas, incremental
// tool_use fragments, and usage — through the SAME callModel-shaped
// generator the agent loop consumes, plus the request body actually sent
// on the wire (model id, stream flag, tools array).

import { describe, it, expect } from '../../framework.js';
import {
  callOllama,
  listOllamaModels,
  ollamaAdapter,
} from '/peerd-provider/adapters/ollama.js';
import { OllamaNotRunningError } from '/peerd-provider/errors.js';

/** @typedef {import('/peerd-provider/types.js').InternalMessage} InternalMessage */
/** @typedef {import('/peerd-provider/format/from-anthropic.js').ProviderEvent} ProviderEvent */
/** @typedef {Extract<ProviderEvent, { type: 'usage' }>} UsageEvent */
/** @typedef {Extract<ProviderEvent, { type: 'message-stop' }>} MessageStopEvent */
/** @typedef {Parameters<typeof callOllama>[0]} CallOllamaArgs */

// Minimal Response stand-in — the adapter reads only these fields off it.
/**
 * @param {ReadonlyArray<string>} lines
 * @returns {Response}
 */
const sseBody = (lines) => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(lines.join('')));
      controller.close();
    },
  });
  return /** @type {Response} */ (/** @type {unknown} */ (
    { ok: true, status: 200, headers: new Headers(), body, text: async () => '' }));
};

/** @param {AsyncGenerator<ProviderEvent>} gen */
const drain = async (gen) => {
  /** @type {ProviderEvent[]} */
  const events = [];
  for await (const ev of gen) events.push(ev);
  return events;
};

/**
 * @param {Partial<CallOllamaArgs>} [overrides]
 * @returns {CallOllamaArgs}
 */
const baseArgs = (overrides = {}) => ({
  /** @type {InternalMessage[]} */
  messages: [{ role: 'user', content: 'hi', id: 'u', when: 0 }],
  system: 'sys',
  safeFetch: async () => { throw new Error('safeFetch not set'); },
  ...overrides,
});

describe('callOllama — streaming through the OpenAI format layer', () => {
  it('streams text + incremental tool_use + usage like the other adapters', async () => {
    // why any: the captured request body is JSON.parse output of the
    // OpenAI-shaped wire payload — toOpenAiBody returns `object`, not a
    // structured type we own, so the field reads below are untyped by
    // nature (same rationale as the adapter's /api/tags parse).
    /** @type {any} */
    let sentBody = null;
    /** @type {CallOllamaArgs['safeFetch']} */
    const safeFetch = async (url, init) => {
      expect(url).toBe('http://localhost:11434/v1/chat/completions');
      sentBody = JSON.parse(/** @type {string} */ (init?.body));
      return sseBody([
        'data: {"choices":[{"delta":{"content":"Open"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"ing…"}}]}\n\n',
        // tool call streams in fragments, keyed by index
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"open_tab","arguments":""}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"url\\":\\"https://e"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"x.com\\"}"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":7}}\n\n',
        'data: [DONE]\n\n',
      ]);
    };
    const events = await drain(callOllama(baseArgs({
      safeFetch,
      model: 'qwen3:8b',
      tools: [{ name: 'open_tab', description: 'open a tab', schema: { type: 'object' } }],
    })));

    // Wire body: OpenAI shape with our model + streaming + tools.
    expect(sentBody.model).toBe('qwen3:8b');
    expect(sentBody.stream).toBe(true);
    expect(sentBody.tools.length).toBe(1);
    expect(sentBody.tools[0].function.name).toBe('open_tab');

    const types = events.map((e) => e.type);
    expect(types).toEqual([
      'text-delta', 'text-delta',
      'tool-use-start', 'tool-use-delta', 'tool-use-delta', 'tool-use-stop',
      'usage', 'message-stop',
    ]);
    const argJson = events
      .flatMap((e) => (e.type === 'tool-use-delta' ? [e.partialJson] : []))
      .join('');
    expect(JSON.parse(argJson)).toEqual({ url: 'https://ex.com' });
    expect(/** @type {MessageStopEvent} */ (events.at(-1)).stopReason).toBe('tool_use');
    const usageEvent = /** @type {UsageEvent} */ (events.find((e) => e.type === 'usage'));
    expect(usageEvent.usage.inputTokens).toBe(12);
  });

  it('maps connection-refused to the friendly OllamaNotRunningError', async () => {
    /** @type {unknown} */
    let thrown;
    try {
      await drain(callOllama(baseArgs({
        safeFetch: async () => { throw new TypeError('Failed to fetch'); },
        _sleep: async () => {}, // skip the single connect-retry backoff
      })));
    } catch (e) { thrown = e; }
    expect(thrown instanceof OllamaNotRunningError).toBe(true);
    // The whole point: the user sees the fix, not "Failed to fetch".
    const err = /** @type {OllamaNotRunningError} */ (thrown);
    expect(err.message.includes('ollama serve')).toBe(true);
    expect(err.message.includes('Failed to fetch')).toBe(false);
  });

  it('works without a getSecret at all (keyless contract)', async () => {
    const events = await drain(callOllama(baseArgs({
      safeFetch: async () => sseBody([
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
      // no getSecret on purpose
    })));
    expect(/** @type {ProviderEvent} */ (events.at(-1)).type).toBe('message-stop');
  });
});

describe('ollamaAdapter — registry descriptor', () => {
  it('declares the keyless + live-models markers the chassis keys off', () => {
    expect(ollamaAdapter.name).toBe('ollama');
    expect(ollamaAdapter.keyless).toBe(true);
    expect(ollamaAdapter.vaultSecretName).toBe(null);
    expect(ollamaAdapter.listModels).toBe(listOllamaModels);
  });
});
