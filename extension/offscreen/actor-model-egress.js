// @ts-check
// Worker-side view of the isolated actor's model authority. Provider adapters
// keep request/response semantics in this heap; the service worker owns the
// fixed destination, credential, transport limits, and response stream.

const failureFrom = (/** @type {any} */ result, /** @type {string} */ fallback) => {
  const error = result?.code === 'model-egress-connect-failed'
    ? new TypeError(result?.error ?? result.code)
    : new Error(result?.error ?? result?.code ?? fallback);
  Object.assign(error, {
    code: result?.code ?? fallback,
    outcomeKnown: result?.outcomeKnown === true,
    ...(result?.retryable === false ? { retryable: false } : {}),
  });
  return error;
};

/**
 * @param {Object} deps
 * @param {(request:{providerId:string,modelId:string,nativeBody:object})=>Promise<any>} deps.openInference
 * @param {(request:{streamId:string})=>Promise<any>} deps.readInferenceChunk
 * @param {(request:{streamId:string})=>Promise<any>} deps.cancelInference
 * @param {(request:any)=>Promise<any>} [deps.openLocalGeneration]
 * @param {(request:{streamId:string})=>Promise<any>} [deps.readLocalGeneration]
 * @param {(request:{streamId:string})=>Promise<any>} [deps.cancelLocalGeneration]
 * @param {(request:{providerId:string,modelId:string})=>Promise<any>} [deps.readModelContext]
 */
export const createActorModelEgress = ({
  openInference, readInferenceChunk, cancelInference,
  openLocalGeneration, readLocalGeneration, cancelLocalGeneration,
  readModelContext = async () => ({
    ok: false, code: 'actor-model-context-unavailable', outcomeKnown: true,
  }),
}) => {
  const checked = async (/** @type {Promise<any>} */ pending, /** @type {string} */ fallback) => {
    const result = await pending;
    if (result?.ok !== true) throw failureFrom(result, fallback);
    return result.value;
  };

  return Object.freeze({
    openInference: async (/** @type {any} */ request) => {
      const opened = await checked(openInference({
        providerId: request.providerId,
        modelId: request.modelId,
        nativeBody: request.nativeBody,
      }), 'actor-model-open-failed');
      if (typeof opened?.streamId !== 'string' || opened.streamId.length === 0) {
        throw new Error('actor model egress returned no stream');
      }
      const streamId = opened.streamId;
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        await checked(cancelInference({ streamId }), 'actor-model-cancel-failed').catch(() => {});
      };
      const abort = () => { void close(); };
      if (request.signal?.aborted) abort();
      else request.signal?.addEventListener('abort', abort, { once: true });
      const body = opened.hasBody === true ? new ReadableStream({
        pull: async (controller) => {
          if (closed) { controller.close(); return; }
          try {
            const next = await checked(
              readInferenceChunk({ streamId }), 'actor-model-read-failed',
            );
            if (next?.done === true) {
              closed = true;
              request.signal?.removeEventListener('abort', abort);
              controller.close();
              return;
            }
            if (!(next?.chunk instanceof Uint8Array)) {
              throw new Error('actor model egress returned an invalid chunk');
            }
            controller.enqueue(next.chunk);
          } catch (cause) {
            closed = true;
            request.signal?.removeEventListener('abort', abort);
            controller.error(cause);
          }
        },
        cancel: close,
      }) : null;
      if (!body) request.signal?.removeEventListener('abort', abort);
      return new Response(body, {
        status: Number(opened.status),
        statusText: typeof opened.statusText === 'string' ? opened.statusText : '',
        headers: opened.headers && typeof opened.headers === 'object' ? opened.headers : {},
      });
    },
    readModelInventory: async () => {
      throw Object.assign(new Error('actor model inventory authority is unavailable'), {
        code: 'actor-model-inventory-unavailable', outcomeKnown: true,
      });
    },
    readModelContext: async (/** @type {any} */ request) => {
      const value = await checked(readModelContext({
        providerId: request.providerId, modelId: request.modelId,
      }), 'actor-model-context-failed');
      if (value == null) return new Response(null, { status: 204 });
      return new Response(value?.body instanceof Uint8Array ? value.body : null, {
        status: Number(value?.status),
        statusText: typeof value?.statusText === 'string' ? value.statusText : '',
        headers: value?.headers && typeof value.headers === 'object' ? value.headers : {},
      });
    },
    generateLocal: (/** @type {any} */ request) => (async function* () {
      if (!openLocalGeneration || !readLocalGeneration || !cancelLocalGeneration) {
        throw Object.assign(new Error('local model authority is unavailable to isolated actors'), {
          code: 'local-model-authority-unavailable', outcomeKnown: true,
        });
      }
      const opened = await checked(openLocalGeneration({
        providerId: request.providerId,
        modelId: request.modelId,
        messages: request.messages,
        system: request.system,
        tools: request.tools ?? [],
        maxTokens: request.maxTokens,
      }), 'actor-model-local-open-failed');
      const streamId = opened?.streamId;
      if (typeof streamId !== 'string' || !streamId) {
        throw new Error('actor local model egress returned no stream');
      }
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        await checked(cancelLocalGeneration({ streamId }), 'actor-model-local-cancel-failed')
          .catch(() => {});
      };
      const abort = () => { void close(); };
      if (request.signal?.aborted) abort();
      else request.signal?.addEventListener('abort', abort, { once: true });
      try {
        while (!closed) {
          const next = await checked(
            readLocalGeneration({ streamId }), 'actor-model-local-read-failed',
          );
          if (next?.done === true) { closed = true; break; }
          if (typeof next?.token !== 'string') {
            throw new Error('actor local model egress returned an invalid token');
          }
          yield next.token;
        }
      } finally {
        request.signal?.removeEventListener('abort', abort);
        await close();
      }
    })(),
  });
};
