// @ts-check
// Lazy sealed-Worker handler for the orchestrator controller. The tiny prompt
// runtime imports this fixed package-local module only after a turn.run commit.

import { runUserTurn } from '/peerd-runtime/controller-turn.js';

const isRecord = (/** @type {unknown} */ value) => value !== null
  && typeof value === 'object' && !Array.isArray(value);

const parseJson = (/** @type {unknown} */ value, /** @type {string} */ label) => {
  if (typeof value !== 'string') throw new Error(`${label} wire payload is invalid`);
  try { return JSON.parse(value); }
  catch { throw new Error(`${label} wire payload is invalid`); }
};

const TOOL_RPC_CONCURRENCY = 64;

/**
 * Backpressure large read-only waves before they enter private-channel
 * custody. This narrows resource use without reducing the loop's batch size.
 * @param {AbortSignal} signal
 */
const makeToolBackpressure = (signal) => {
  let active = 0;
  /** @type {Array<{resolve:()=>void,reject:(cause:unknown)=>void}>} */
  const waiting = [];
  const drain = () => {
    if (signal.aborted) {
      const cause = new DOMException('controller turn aborted', 'AbortError');
      while (waiting.length > 0) waiting.shift()?.reject(cause);
      return;
    }
    while (active < TOOL_RPC_CONCURRENCY && waiting.length > 0) {
      active += 1;
      waiting.shift()?.resolve();
    }
  };
  signal.addEventListener('abort', drain, { once: true });
  return async (/** @type {()=>Promise<any>} */ operation) => {
    if (signal.aborted) throw new DOMException('controller turn aborted', 'AbortError');
    if (active >= TOOL_RPC_CONCURRENCY) {
      await new Promise((resolve, reject) => {
        waiting.push({ resolve: () => resolve(undefined), reject });
      });
    } else {
      active += 1;
    }
    try { return await operation(); }
    finally { active = Math.max(0, active - 1); drain(); }
  };
};

const turnValue = async (
  /** @type {(operation:string, payload:unknown)=>Promise<any>} */ kernelCall,
  /** @type {string} */ operation,
  /** @type {unknown} */ payload,
  /** @type {() => void} */ markUnknown,
) => {
  const result = await kernelCall(operation, payload);
  if (result?.ok === true) return result.value;
  if (result?.outcomeKnown !== true) markUnknown();
  const error = new Error(result?.error ?? result?.code ?? `kernel ${operation} failed`);
  Object.assign(error, {
    code: result?.code ?? 'kernel-call-failed',
    outcomeKnown: result?.outcomeKnown === true,
  });
  throw error;
};

/** @param {unknown} value */
const isTurnPayload = (value) => {
  if (!isRecord(value)) return false;
  const input = /** @type {Record<string, any>} */ (value);
  return typeof input.runId === 'string' && input.runId.length >= 8 && input.runId.length <= 512
    && typeof input.sessionId === 'string' && input.sessionId.length > 0
    && input.sessionId.length <= 512
    && typeof input.ctxJson === 'string'
    && typeof input.toolsJson === 'string'
    && isRecord(input.classifications);
};

/**
 * Production turn handler. All non-pure operations are reverse RPCs into the
 * exact run-scoped authority closure in controller-turn-bridge.js.
 * @param {unknown} payload
 * @param {{ signal: AbortSignal, authority?: unknown,
 *   kernelCall?: (operation:string, payload:unknown)=>Promise<any> }} options
 */
export const runControllerTurn = async (payload, options) => {
  if (!isTurnPayload(payload) || typeof options.kernelCall !== 'function') {
    return { ok: false, code: 'turn-payload-invalid', outcomeKnown: true };
  }
  const input = /** @type {Record<string, any>} */ (payload);
  const authority = /** @type {Record<string, any>} */ (options.authority ?? {});
  if (authority.sessionId !== input.sessionId || authority.target !== 'orchestrator-turn'
      || authority.replayClass !== 'E') {
    return { ok: false, code: 'turn-authority-invalid', outcomeKnown: true };
  }
  const kernelCall = options.kernelCall;
  const ctx = parseJson(input.ctxJson, 'turn context');
  const tools = parseJson(input.toolsJson, 'turn tools');
  if (!isRecord(ctx) || !Array.isArray(tools)) {
    return { ok: false, code: 'turn-payload-invalid', outcomeKnown: true };
  }
  const withToolSlot = makeToolBackpressure(options.signal);
  const runId = input.runId;
  let nestedUnknown = false;
  let abortFinalized = false;
  const rpc = (/** @type {string} */ operation, /** @type {unknown} */ value) =>
    turnValue(kernelCall, operation, { runId, value }, () => { nestedUnknown = true; });
  /** @type {Set<Promise<unknown>>} */
  const advisory = new Set();
  const trackAdvisory = (/** @type {Promise<unknown>} */ promise) => {
    advisory.add(promise);
    promise.finally(() => advisory.delete(promise)).catch(() => {});
    return promise;
  };
  let classifications = /** @type {Record<string, any>} */ ({ ...input.classifications });
  /** @type {string|null} */
  let modelId = null;
  const cancelModel = async () => {
    const closing = modelId;
    modelId = null;
    if (closing && !options.signal.aborted) {
      await rpc('turn.model.cancel', { modelId: closing }).catch(() => {});
    }
  };
  const callModel = async function* (/** @type {Record<string, any>} */ args) {
    const {
      getSecret: _getSecret, safeFetch: _safeFetch, signal: _signal, ...modelRequest
    } = args;
    const opened = await rpc('turn.model.open', { requestJson: JSON.stringify(modelRequest) });
    modelId = opened?.modelId;
    if (typeof modelId !== 'string') throw new Error('kernel model stream did not open');
    try {
      while (true) {
        const next = await rpc('turn.model.next', { modelId });
        if (next?.done === true) return;
        yield next?.event;
      }
    } finally { await cancelModel(); }
  };
  const sessions = {
    get: async (/** @type {string} */ sessionId) => parseJson(
      await rpc('turn.session.get', { sessionId }), 'session',
    ),
    appendMessage: async (/** @type {string} */ sessionId, /** @type {unknown} */ message) =>
      parseJson(await rpc('turn.session.append', {
        sessionId, messageJson: JSON.stringify(message),
      }), 'session'),
    updateAssistantMessage: (
      /** @type {string} */ sessionId,
      /** @type {string} */ messageId,
      /** @type {unknown} */ patch,
    ) => rpc('turn.session.update-assistant', {
      sessionId, messageId, patchJson: JSON.stringify(patch),
    }),
    setTrimSummary: (/** @type {string} */ sessionId, /** @type {unknown} */ state) =>
      rpc('turn.session.set-trim', { sessionId, stateJson: JSON.stringify(state) }),
  };
  try {
    for await (const event of runUserTurn({
      ...ctx,
      sessionId: input.sessionId,
      tools,
      signal: options.signal,
      sessions,
      callModel,
      getSecret: async () => { throw new Error('credential access is kernel-owned'); },
      safeFetch: async () => { throw new Error('egress is kernel-owned'); },
      getSystemPrompt: () => rpc('turn.prompt.get', {}),
      appendAudit: (/** @type {unknown} */ entry) =>
        trackAdvisory(rpc('turn.audit.append', { entry })),
      refreshTools: async () => {
        const refreshed = await rpc('turn.tools.refresh', {});
        classifications = isRecord(refreshed?.classifications)
          ? { ...refreshed.classifications } : {};
        return typeof refreshed?.toolsJson === 'string'
          ? parseJson(refreshed.toolsJson, 'turn tools') : [];
      },
      toolDispatch: (/** @type {unknown} */ call) => withToolSlot(async () => {
        const result = parseJson(await rpc('turn.tool.dispatch', {
          callJson: JSON.stringify(call),
        }), 'tool result');
        if (result?.outcomeKnown === false) nestedUnknown = true;
        return result;
      }),
      finalizeAbort: async (/** @type {any} */ value) => {
        await rpc('turn.abort.finalize', value);
        abortFinalized = true;
      },
      classifyToolCall: (/** @type {string} */ name) => classifications[name] ?? null,
      enrichTrimSummary: (/** @type {unknown} */ request) => {
        trackAdvisory(rpc('turn.trim.enrich', { request })).catch(() => {});
      },
    })) {
      try { await rpc('turn.event', { eventJson: JSON.stringify(event) }); }
      catch (cause) {
        if (!options.signal.aborted) throw cause;
      }
    }
    if (advisory.size > 0) await Promise.allSettled([...advisory]);
    await rpc('turn.finalize', {});
    if (nestedUnknown) throw new Error('a dispatched kernel operation has an unknown outcome');
    if (options.signal.aborted && !abortFinalized) {
      throw Object.assign(new Error('controller turn aborted before finalization'), {
        outcomeKnown: false,
      });
    }
    return { ok: true, outcomeKnown: true };
  } catch (cause) {
    const detail = /** @type {{code?:string,outcomeKnown?:boolean,retryable?:boolean}} */ (cause);
    return {
      ok: false,
      code: detail?.outcomeKnown === false && typeof detail.code === 'string' ? detail.code
        : options.signal.aborted ? 'controller-call-aborted'
        : detail?.code ?? 'turn-run-failed',
      outcomeKnown: detail?.outcomeKnown === false ? false
        : options.signal.aborted && !abortFinalized ? false : !nestedUnknown,
      ...(detail?.retryable === false ? { retryable: false } : {}),
      error: cause instanceof Error ? cause.message : String(cause),
    };
  } finally {
    await cancelModel();
  }
};
