import { describe, expect, test } from 'bun:test';
import { createActorModelEgress } from '../../extension/offscreen/actor-model-egress.js';

describe('isolated actor model egress', () => {
  test('pulls inference chunks without buffering provider events', async () => {
    const reads: string[] = [];
    const egress = createActorModelEgress({
      openInference: async () => ({
        ok: true,
        value: {
          streamId: 'stream-1', status: 200, statusText: 'OK',
          headers: { 'content-type': 'text/event-stream' }, hasBody: true,
        },
      }),
      readInferenceChunk: async ({ streamId }) => {
        reads.push(streamId);
        return reads.length === 1
          ? { ok: true, value: { done: false, chunk: new TextEncoder().encode('data: one\n\n') } }
          : { ok: true, value: { done: true } };
      },
      cancelInference: async () => ({ ok: true, value: null }),
    });

    const response = await egress.openInference({
      providerId: 'anthropic', modelId: 'model',
      nativeBody: { model: 'model', stream: true },
    });
    expect(await response.text()).toBe('data: one\n\n');
    expect(reads).toEqual(['stream-1', 'stream-1']);
  });

  test('cancels the exact stream when provider consumption stops', async () => {
    const cancelled: string[] = [];
    const egress = createActorModelEgress({
      openInference: async () => ({
        ok: true,
        value: { streamId: 'stream-cancel', status: 200, headers: {}, hasBody: true },
      }),
      readInferenceChunk: async () => new Promise(() => {}),
      cancelInference: async ({ streamId }) => {
        cancelled.push(streamId);
        return { ok: true, value: null };
      },
    });
    const response = await egress.openInference({
      providerId: 'openai', modelId: 'model', nativeBody: {},
    });
    await response.body?.cancel();
    expect(cancelled).toEqual(['stream-cancel']);
  });

  test('reports local WebGPU as an exact unavailable authority', async () => {
    const egress = createActorModelEgress({
      openInference: async () => ({ ok: false }),
      readInferenceChunk: async () => ({ ok: false }),
      cancelInference: async () => ({ ok: false }),
    });
    let failure: any = null;
    try { await egress.generateLocal({})[Symbol.asyncIterator]().next(); }
    catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: 'local-model-authority-unavailable' });
  });
});
