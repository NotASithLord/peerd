import { describe, test, expect } from 'bun:test';
import {
  parseLocalStream, callLocalWebgpu, setLocalGenerate, localWebgpuAdapter, LOCAL_MODEL_ID,
} from '../../extension/peerd-provider/adapters/local-webgpu.js';

// FEATURE-LOCAL-WEBGPU §3.4. The load-bearing piece is parsing Gemma's token
// stream into ProviderEvents — Transformers.js leaves <tool_call> parsing to us.
// These pin that translation against a MOCK stream (no WebGPU), so a real-format
// surprise from a load-test is a localized parser edit, not a rewrite.

const streamOf = (chunks: string[]) => (async function* () { for (const c of chunks) yield c; })();
const collect = async (gen: AsyncIterable<any>) => { const out: any[] = []; for await (const e of gen) out.push(e); return out; };

describe('parseLocalStream', () => {
  test('plain prose → text-delta only', async () => {
    const out = await collect(parseLocalStream(streamOf(['Hello ', 'world.'])));
    const text = out.filter((e) => e.type === 'text-delta').map((e) => e.text).join('');
    expect(text).toBe('Hello world.');
    expect(out.some((e) => e.type.startsWith('tool-use'))).toBe(false);
  });

  test('a <tool_call> block → tool-use start/delta/stop with name + arguments', async () => {
    const out = await collect(parseLocalStream(streamOf([
      '<tool_call>{"name":"click","arguments":{"ref":"e12"}}</tool_call>',
    ])));
    expect(out.find((e) => e.type === 'tool-use-start')).toMatchObject({ name: 'click' });
    const delta = out.find((e) => e.type === 'tool-use-delta');
    expect(JSON.parse(delta.partialJson)).toEqual({ ref: 'e12' });
    expect(out.some((e) => e.type === 'tool-use-stop')).toBe(true);
  });

  test('prose THEN a tool call → both, in order', async () => {
    const out = await collect(parseLocalStream(streamOf([
      'Let me click. <tool_call>{"name":"click","arguments":{"ref":"x"}}</tool_call>',
    ])));
    expect(out[0]).toMatchObject({ type: 'text-delta' });
    expect(out[0].text).toContain('Let me click.');
    expect(out.some((e) => e.type === 'tool-use-start')).toBe(true);
  });

  test('a tag split ACROSS token boundaries still parses', async () => {
    // the open/close tags + json arrive in awkward chunks
    const out = await collect(parseLocalStream(streamOf([
      'go <tool', '_call>{"name":"nav', 'igate","arguments":{"url":"/x"}}</tool', '_call> done',
    ])));
    expect(out.find((e) => e.type === 'tool-use-start')).toMatchObject({ name: 'navigate' });
    const text = out.filter((e) => e.type === 'text-delta').map((e) => e.text).join('');
    expect(text).toContain('go ');
    expect(text).toContain('done');
  });

  test('a malformed call block is surfaced as text, never throws', async () => {
    const out = await collect(parseLocalStream(streamOf(['<tool_call>{not json}</tool_call>'])));
    expect(out.every((e) => e.type === 'text-delta')).toBe(true);
    expect(out.map((e) => e.text).join('')).toContain('not json');
  });
});

describe('callLocalWebgpu', () => {
  test('not loaded → a single error event (no throw)', async () => {
    setLocalGenerate(null);
    const out = await collect(callLocalWebgpu({ messages: [], system: '' } as any));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'error' });
    expect(out[0].error).toContain('Local model');
  });

  test('streams events, then a synthetic usage + message-stop', async () => {
    setLocalGenerate(() => streamOf(['ok ', '<tool_call>{"name":"snapshot","arguments":{}}</tool_call>']));
    const out = await collect(callLocalWebgpu({ messages: [], system: 'sys' } as any));
    expect(out.some((e) => e.type === 'text-delta')).toBe(true);
    expect(out.some((e) => e.type === 'tool-use-start')).toBe(true);
    const usage = out.find((e) => e.type === 'usage');
    expect(usage.usage.outputTokens).toBe(2);            // two streamer chunks
    expect(usage.usage.inputTokens).toBe(0);             // prefill is local + free
    expect(out.at(-1)).toMatchObject({ type: 'message-stop' });
    setLocalGenerate(null);
  });
});

describe('localWebgpuAdapter descriptor', () => {
  test('keyless, zero-secret, defaultRunnerModel = the resident model', () => {
    expect(localWebgpuAdapter.keyless).toBe(true);
    expect(localWebgpuAdapter.vaultSecretName).toBe(null);
    expect(localWebgpuAdapter.defaultRunnerModel).toBe(LOCAL_MODEL_ID);
    expect(typeof localWebgpuAdapter.call).toBe('function');
  });
});
