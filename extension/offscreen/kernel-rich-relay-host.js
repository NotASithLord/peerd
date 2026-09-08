// @ts-check

import { callModel } from '/peerd-provider/controller.js';
import {
  foldProviderEvents,
  validateProviderCallArgs,
} from '/peerd-runtime/controller-model.js';
import {
  parseRuntimeRichAdmitProjection,
  parseRuntimeRichOpenInferenceValue,
  parseRuntimeRichOpenLocalValue,
  parseRuntimeRichReadInferenceValue,
  parseRuntimeRichReadLocalValue,
} from '/shared/kernel-runtime-policy.js';

const record = (/** @type {unknown} */ value) => value !== null
  && typeof value === 'object' && !Array.isArray(value)
  ? /** @type {Record<string,any>} */ (value) : null;
const message = (/** @type {unknown} */ value, /** @type {string} */ route) => {
  const input = record(value);
  if (!input || (input.type !== undefined && input.type !== route)) return null;
  const allowed = route === 'script/model-call'
    ? new Set(['type', 'ownerSessionId', 'runId', 'args', 'deadlineAt'])
    : new Set(['type', 'ownerSessionId', 'runId']);
  if (!Object.keys(input).every((key) => allowed.has(key))) return null;
  if (route === 'script/model-call' && input.deadlineAt !== undefined
      && !Number.isSafeInteger(input.deadlineAt)) return null;
  return input;
};
const complete = (/** @type {unknown} */ value) => Object.freeze({
  ok: true, outcomeKnown: true, value,
});
const failed = (/** @type {any} */ result) => Object.freeze({
  ok: false,
  code: typeof result?.code === 'string' ? result.code : 'runtime-rich-effect-failed',
  error: typeof result?.error === 'string' ? result.error : 'Operation outcome could not be confirmed.',
  outcomeKnown: result?.outcomeKnown === true,
  phase: 'run',
});
const effectError = (/** @type {any} */ result) => Object.assign(
  result?.code === 'model-egress-connect-failed'
    ? new TypeError(result?.error ?? result.code)
    : new Error(result?.error ?? result?.code ?? 'model egress failed'),
  {
    richEffectResult: result,
    code: result?.code,
    outcomeKnown: result?.outcomeKnown === true,
    ...(result?.retryable === false ? { retryable: false } : {}),
  },
);

/** @param {any} value */
const responseFrom = (value) => new Response(value.hasBody === true ? new ReadableStream({
  pull: value.pull,
  cancel: value.cancel,
}) : null, {
  status: value.status,
  statusText: value.statusText,
  headers: value.headers,
});

/** @param {{effects:any}} context @param {Record<string,string>} binding */
const createRichModelEgress = (context, binding) => Object.freeze({
  openInference: async (/** @type {any} */ request) => {
    const opened = await context.effects.call('rich.model.open-inference', {
      ...binding,
      providerId: request.providerId,
      modelId: request.modelId,
      nativeBody: request.nativeBody,
    });
    if (opened?.ok !== true || opened.outcomeKnown !== true) throw effectError(opened);
    const projection = parseRuntimeRichOpenInferenceValue(opened.value);
    if (!projection) throw effectError({
      code: 'runtime-rich-open-result-invalid', outcomeKnown: false,
    });
    const streamId = projection.streamId;
    let closed = false;
    const cancel = async () => {
      if (closed) return;
      closed = true;
      const result = await context.effects.call('rich.model.cancel-inference', {
        ...binding, streamId,
      });
      if (result?.ok !== true || result.outcomeKnown !== true) throw effectError(result);
    };
    return responseFrom({
      ...projection,
      pull: async (/** @type {ReadableStreamDefaultController<Uint8Array>} */ controller) => {
        if (closed) { controller.close(); return; }
        try {
          const result = await context.effects.call('rich.model.read-inference', {
            ...binding, streamId,
          });
          if (result?.ok !== true || result.outcomeKnown !== true) throw effectError(result);
          const next = parseRuntimeRichReadInferenceValue(result.value);
          if (!next) throw effectError({
            code: 'runtime-rich-read-result-invalid', outcomeKnown: false,
          });
          if (next.done) {
            closed = true;
            controller.close();
          } else controller.enqueue(next.chunk);
        } catch (cause) {
          closed = true;
          controller.error(cause);
        }
      },
      cancel,
    });
  },
  readModelInventory: async () => {
    throw new Error('model inventory is unavailable to script sub-calls');
  },
  readModelContext: async () => {
    throw new Error('model context lookup is unavailable to script sub-calls');
  },
  generateLocal: (/** @type {any} */ request) => (async function* () {
    const opened = await context.effects.call('rich.model.open-local', {
      ...binding,
      providerId: request.providerId,
      modelId: request.modelId,
      messages: request.messages,
      system: request.system,
      tools: request.tools ?? [],
      maxTokens: request.maxTokens,
    });
    if (opened?.ok !== true || opened.outcomeKnown !== true) throw effectError(opened);
    const projection = parseRuntimeRichOpenLocalValue(opened.value);
    if (!projection) throw effectError({
      code: 'runtime-rich-local-open-result-invalid', outcomeKnown: false,
    });
    const streamId = projection.streamId;
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      const result = await context.effects.call('rich.model.cancel-local', {
        ...binding, streamId,
      });
      if (result?.ok !== true || result.outcomeKnown !== true) throw effectError(result);
    };
    const abort = () => { void close(); };
    if (context.effects.signal.aborted) abort();
    else context.effects.signal.addEventListener('abort', abort, { once: true });
    try {
      while (!closed) {
        const result = await context.effects.call('rich.model.read-local', {
          ...binding, streamId,
        });
        if (result?.ok !== true || result.outcomeKnown !== true) throw effectError(result);
        const next = parseRuntimeRichReadLocalValue(result.value);
        if (!next) throw effectError({
          code: 'runtime-rich-local-read-result-invalid', outcomeKnown: false,
        });
        if (next.done) { closed = true; break; }
        yield next.token;
      }
    } finally {
      context.effects.signal.removeEventListener('abort', abort);
      await close();
    }
  })(),
});

/** @param {unknown} input @param {{effects:any}} context */
export const dispatchKernelRichRelay = async (input, context) => {
  const request = record(input);
  const route = request?.route;
  if ((route !== 'script/model-call' && route !== 'script-run/abort')
      || !context?.effects?.signal || context.effects.signal.aborted
      || typeof context.effects.call !== 'function') {
    return { ok: false, code: 'runtime-rich-relay-invalid', outcomeKnown: true };
  }
  const body = message(request?.message, route);
  if (!body || typeof body.ownerSessionId !== 'string' || !body.ownerSessionId
      || typeof body.runId !== 'string' || !body.runId) {
    return complete({ ok: false, error: route === 'script/model-call'
      ? 'provider: unknown or finished run'
      : 'script_run_abort_unknown_finished_or_foreign_run' });
  }
  if (route === 'script-run/abort') {
    const result = await context.effects.call('rich.script.abort', {
      ownerSessionId: body.ownerSessionId, runId: body.runId,
    });
    return result?.ok === true && result.outcomeKnown === true
      ? complete({ ok: true }) : failed(result);
  }
  let call;
  try { call = validateProviderCallArgs(body.args); }
  catch (cause) {
    return complete({
      ok: false,
      error: /** @type {{message?:string}} */ (cause)?.message ?? String(cause),
    });
  }
  const admitted = await context.effects.call('rich.script.admit', {
    ownerSessionId: body.ownerSessionId,
    runId: body.runId,
    maxTokens: call.maxTokens,
    requestedModel: call.model ?? null,
  });
  if (admitted?.ok !== true || admitted.outcomeKnown !== true) return failed(admitted);
  const projection = parseRuntimeRichAdmitProjection(admitted.value);
  if (!projection) return failed({ code: 'runtime-rich-admission-invalid', outcomeKnown: false });
  const provider = projection.providerId;
  const model = projection.modelId;
  const binding = {
    token: projection.token,
    ownerSessionId: body.ownerSessionId,
    runId: body.runId,
  };
  const events = [];
  let providerFailure = null;
  try {
    for await (const event of callModel({
      provider,
      model,
      system: call.system ?? '',
      messages: /** @type {any} */ (call.messages),
      maxTokens: call.maxTokens,
      signal: context.effects.signal,
      modelEgress: createRichModelEgress(context, binding),
    })) events.push(event);
  } catch (cause) {
    const effectResult = /** @type {any} */ (cause)?.richEffectResult;
    if (effectResult) providerFailure = failed(effectResult);
    else providerFailure = complete({
      ok: false,
      error: context.effects.signal.aborted ? 'aborted'
        : (/** @type {{message?:string}} */ (cause)?.message ?? String(cause)),
    });
  }
  const folded = foldProviderEvents(events);
  const rawUsage = folded.usage ?? {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
  };
  const settled = await context.effects.call('rich.model.observe-usage', {
    ...binding,
    providerId: provider,
    modelId: model,
    usage: rawUsage,
  });
  if (settled?.ok !== true || settled.outcomeKnown !== true) return failed(settled);
  if (providerFailure) return providerFailure;
  const usage = folded.usage ? {
    inputTokens: folded.usage.inputTokens,
    outputTokens: folded.usage.outputTokens,
  } : null;
  if (context.effects.signal.aborted) {
    return complete({ ok: false, error: 'aborted', ...(usage ? { usage } : {}) });
  }
  if (folded.error !== undefined) {
    return complete({ ok: false, error: folded.error, ...(usage ? { usage } : {}) });
  }
  return complete({
    ok: true,
    value: {
      text: folded.text,
      model,
      ...(folded.stopReason === undefined ? {} : { stopReason: folded.stopReason }),
      ...(usage ? { usage } : {}),
    },
  });
};
