// @ts-check
// Named controller-side view of the worker's fixed model authority. Provider
// adapters receive Response objects, but cannot choose a destination, headers,
// credential, method, or fetch option.

/** @param {any} value */
const responseFromProjection = (value) => {
  if (value == null) return new Response(null, { status: 204 });
  const body = value?.body instanceof Uint8Array ? value.body : null;
  return new Response(body, {
    status: Number(value?.status),
    statusText: typeof value?.statusText === 'string' ? value.statusText : '',
    headers: value?.headers && typeof value.headers === 'object' ? value.headers : {},
  });
};

/**
 * @param {Object} deps
 * @param {(operation:string,payload:unknown)=>Promise<any>} deps.call
 */
export const createControllerModelEgress = ({ call }) => {
  if (typeof call !== 'function') throw new TypeError('controller-model-egress-config-invalid');
  // The turn runtime's named RPC wrapper validates the authority envelope and
  // returns only its value. Keeping one unwrapping point preserves unknown
  // outcome classification and avoids a second transport-shaped path here.
  const checked = (/** @type {string} */ operation, /** @type {unknown} */ payload) =>
    call(operation, payload);
  return Object.freeze({
    openInference: async (/** @type {any} */ request) => {
      const opened = await checked('turn.model.open-inference', {
        providerId: request.providerId,
        modelId: request.modelId,
        nativeBody: request.nativeBody,
      });
      if (typeof opened?.streamId !== 'string') {
        throw new Error('model egress returned no stream');
      }
      const streamId = opened.streamId;
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        request.signal?.removeEventListener('abort', abort);
        await checked('turn.model.cancel-inference', { streamId }).catch(() => {});
      };
      const abort = () => { void close(); };
      if (request.signal?.aborted) abort();
      else request.signal?.addEventListener('abort', abort, { once: true });
      const body = opened.hasBody === true ? new ReadableStream({
        pull: async (controller) => {
          if (closed) { controller.close(); return; }
          try {
            const next = await checked('turn.model.read-inference', { streamId });
            if (next?.done === true) {
              closed = true;
              request.signal?.removeEventListener('abort', abort);
              controller.close();
              return;
            }
            if (!(next?.chunk instanceof Uint8Array)) {
              throw new Error('model egress returned an invalid chunk');
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
      if (!body) void close();
      return new Response(body, {
        status: Number(opened.status),
        statusText: typeof opened.statusText === 'string' ? opened.statusText : '',
        headers: opened.headers && typeof opened.headers === 'object' ? opened.headers : {},
      });
    },
    readModelInventory: async (/** @type {any} */ request) => responseFromProjection(
      await checked('turn.model.read-inventory', { providerId: request.providerId }),
    ),
    readModelContext: async (/** @type {any} */ request) => responseFromProjection(
      await checked('turn.model.read-context', {
        providerId: request.providerId, modelId: request.modelId,
      }),
    ),
    generateLocal: (/** @type {any} */ request) => (async function* () {
      const opened = await checked('turn.model.open-local', {
        providerId: request.providerId,
        modelId: request.modelId,
        messages: request.messages,
        system: request.system,
        tools: request.tools ?? [],
        maxTokens: request.maxTokens,
      });
      if (typeof opened?.streamId !== 'string') {
        throw new Error('local model egress returned no stream');
      }
      const streamId = opened.streamId;
      let closed = false;
      const close = async () => {
        if (closed) return;
        closed = true;
        await checked('turn.model.cancel-local', { streamId }).catch(() => {});
      };
      const abort = () => { void close(); };
      if (request.signal?.aborted) abort();
      else request.signal?.addEventListener('abort', abort, { once: true });
      try {
        while (!closed) {
          const next = await checked('turn.model.read-local', { streamId });
          if (next?.done === true) { closed = true; break; }
          if (typeof next?.token !== 'string') {
            throw new Error('local model egress returned an invalid token');
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
