type ResponseLike = Response | any;

export const makeModelEgress = (overrides: Record<string, unknown> = {}) => ({
  openInference: async () => { throw new Error('openInference not set'); },
  readModelInventory: async () => { throw new Error('readModelInventory not set'); },
  readModelContext: async () => { throw new Error('readModelContext not set'); },
  generateLocal: (_args: unknown): AsyncIterable<string> => (async function* () {
    throw new Error('generateLocal not set');
  })(),
  ...overrides,
}) as {
  openInference: (args: any) => Promise<ResponseLike>;
  readModelInventory: (args: any) => Promise<ResponseLike>;
  readModelContext: (args: any) => Promise<ResponseLike>;
  generateLocal: (args: any) => AsyncIterable<string>;
};

type ProviderEvent = Record<string, any>;
type ModelCall = (args: { signal?: AbortSignal }) => AsyncIterable<ProviderEvent>;

const encoder = new TextEncoder();
const sse = (event: string, payload: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

/**
 * Test-only exact egress authority. It converts scripted semantic events into
 * Anthropic wire bytes so controller tests exercise the real adapter and the
 * production open/read/cancel protocol instead of reviving raw callModel RPC.
 */
export const makeScriptedProviderAuthority = (
  modelCall: () => ModelCall | null,
  inspectRequest: (request: any, grant: any) => void = () => {},
) => {
  let sequence = 0;
  const streams = new Map<string, {
    owner: object;
    iterator: AsyncIterator<ProviderEvent>;
    indexes: Map<string, number>;
    nextIndex: number;
  }>();
  const failure = (code: string, error = code) => ({
    ok: false, code, error, outcomeKnown: true,
  });
  return {
    openInference: async (request: any, grant: any) => {
      if (request?.providerId !== 'anthropic'
          || !grant?.permits?.(request.providerId, request.modelId)) {
        return failure('model-egress-request-invalid');
      }
      const call = modelCall();
      if (!call) return failure('scripted-model-call-missing');
      inspectRequest(request, grant);
      const streamId = `scripted-stream-${++sequence}`;
      streams.set(streamId, {
        owner: grant.owner,
        iterator: call({ signal: grant.signal })[Symbol.asyncIterator](),
        indexes: new Map(),
        nextIndex: 0,
      });
      return {
        ok: true, outcomeKnown: true,
        value: {
          streamId, status: 200, statusText: 'OK',
          headers: { 'content-type': 'text/event-stream' }, hasBody: true,
        },
      };
    },
    readInferenceChunk: async ({ streamId }: any, grant: any) => {
      const stream = streams.get(streamId);
      if (!stream || stream.owner !== grant?.owner) {
        return failure('model-egress-stream-invalid');
      }
      try {
        const next = await stream.iterator.next();
        if (next.done) {
          streams.delete(streamId);
          return { ok: true, outcomeKnown: true, value: { done: true } };
        }
        const event = next.value;
        let wire = '';
        if (event.type === 'text-delta') {
          wire = sse('content_block_delta', {
            index: 0, delta: { type: 'text_delta', text: event.text },
          });
        } else if (event.type === 'tool-use-start') {
          const index = stream.nextIndex++;
          stream.indexes.set(event.id, index);
          wire = sse('content_block_start', {
            index,
            content_block: { type: 'tool_use', id: event.id, name: event.name, input: {} },
          });
        } else if (event.type === 'tool-use-delta') {
          wire = sse('content_block_delta', {
            index: stream.indexes.get(event.id),
            delta: { type: 'input_json_delta', partial_json: event.partialJson },
          });
        } else if (event.type === 'tool-use-stop') {
          wire = sse('content_block_stop', { index: stream.indexes.get(event.id) });
        } else if (event.type === 'usage') {
          const usage = event.usage ?? {};
          wire = sse('message_start', { message: { usage: {
            input_tokens: usage.inputTokens ?? 0,
            output_tokens: 0,
            cache_read_input_tokens: usage.cacheReadTokens ?? 0,
            cache_creation_input_tokens: usage.cacheWriteTokens ?? 0,
          } } }) + sse('message_delta', {
            delta: {}, usage: { output_tokens: usage.outputTokens ?? 0 },
          });
        } else if (event.type === 'message-stop') {
          wire = sse('message_delta', {
            delta: { stop_reason: event.stopReason }, usage: {},
          }) + sse('message_stop', {});
        } else if (event.type === 'error') {
          wire = sse('error', { error: { message: event.error } });
        }
        return {
          ok: true, outcomeKnown: true,
          value: { done: false, chunk: encoder.encode(wire) },
        };
      } catch (cause) {
        streams.delete(streamId);
        return failure(
          'scripted-provider-failed',
          cause instanceof Error ? cause.message : String(cause),
        );
      }
    },
    cancelInference: async ({ streamId }: any, grant: any) => {
      const stream = streams.get(streamId);
      if (!stream || stream.owner !== grant?.owner) {
        return failure('model-egress-stream-invalid');
      }
      streams.delete(streamId);
      await stream.iterator.return?.();
      return { ok: true, outcomeKnown: true, value: null };
    },
    readModelInventory: async () => ({ ok: true, outcomeKnown: true, value: null }),
    readModelContext: async () => ({ ok: true, outcomeKnown: true, value: null }),
    openLocalGeneration: async () => failure('local-model-authority-unavailable'),
    readLocalGeneration: async () => failure('local-model-authority-unavailable'),
    cancelLocalGeneration: async () => failure('local-model-authority-unavailable'),
    closeOwner: async (owner: object) => {
      for (const [streamId, stream] of streams) {
        if (stream.owner !== owner) continue;
        streams.delete(streamId);
        await stream.iterator.return?.();
      }
    },
    activeStreams: () => streams.size,
  };
};
