// @ts-check
// Lazy sealed-Worker handler for the orchestrator controller. The tiny prompt
// runtime imports this fixed package-local module only after a turn.run commit.

import { runUserTurn } from '/peerd-runtime/controller-turn.js';
import { hydrateToolDescriptors } from '/peerd-runtime/semantic.js';
import { controllerHostsTool } from '/shared/controller-tool-manifest.js';

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
 * @param {((request:unknown,options:{signal:AbortSignal,authority:unknown,
 *   deadlineAt:number,kernelCall:(operation:string,payload:unknown)=>Promise<any>})=>
 *   Promise<any>)|undefined} executeToolCall
 */
const runControllerTurnWith = async (payload, options, executeToolCall) => {
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
  const toolProjection = parseJson(input.toolsJson, 'turn tools');
  if (!isRecord(ctx) || !Array.isArray(toolProjection)) {
    return { ok: false, code: 'turn-payload-invalid', outcomeKnown: true };
  }
  const tools = hydrateToolDescriptors(toolProjection, ctx.runtimeCapabilities);
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
        if (typeof refreshed?.toolsJson !== 'string') return [];
        const projection = parseJson(refreshed.toolsJson, 'turn tools');
        if (!Array.isArray(projection)) throw new Error('turn tools wire payload is invalid');
        return hydrateToolDescriptors(projection, ctx.runtimeCapabilities);
      },
      toolDispatch: (/** @type {unknown} */ call) => withToolSlot(async () => {
        const legacyDispatch = async () => parseJson(await rpc('turn.tool.dispatch', {
          callJson: JSON.stringify(call),
        }), 'tool result');
        if (typeof executeToolCall !== 'function') {
          if (controllerHostsTool(/** @type {any} */ (call)?.name)) {
            throw Object.assign(new Error('controller tool executor unavailable'), {
              code: 'controller-tool-executor-unavailable', outcomeKnown: true,
            });
          }
          const result = await legacyDispatch();
          if (result?.outcomeKnown === false) nestedUnknown = true;
          return result;
        }
        const prepared = await rpc('turn.tool.prepare', {
          callJson: JSON.stringify(call),
        });
        if (prepared?.mode === 'legacy') {
          if (controllerHostsTool(/** @type {any} */ (call)?.name)) {
            throw Object.assign(new Error('controller tool preparation unavailable'), {
              code: 'controller-tool-preparation-unavailable', outcomeKnown: true,
            });
          }
          const result = await legacyDispatch();
          if (result?.outcomeKnown === false) nestedUnknown = true;
          return result;
        }
        if (prepared?.mode === 'result') {
          const result = parseJson(prepared.resultJson, 'tool result');
          if (result?.outcomeKnown === false) nestedUnknown = true;
          return result;
        }
        if (prepared?.mode !== 'execute' || typeof prepared.requestJson !== 'string'
            || !Number.isSafeInteger(prepared.deadlineAt)) {
          throw new Error('kernel tool preparation is invalid');
        }
        const request = parseJson(prepared.requestJson, 'tool execution request');
        if (!isRecord(request) || typeof request.executionId !== 'string'
            || typeof request.argsDigest !== 'string'
            || !Number.isSafeInteger(request.turnGeneration)
            || typeof request.toolName !== 'string') {
          throw new Error('kernel tool execution request is invalid');
        }
        let execution;
        try {
          execution = await executeToolCall(request, {
            signal: options.signal,
            authority: {
              ownerId: runId,
              sessionId: input.sessionId,
              target: `tool:${request.toolName}`,
              replayClass: 'E',
            },
            deadlineAt: prepared.deadlineAt,
            kernelCall: (operation, effectPayload) => rpc('turn.tool.effect', {
              executionId: request.executionId,
              argsDigest: request.argsDigest,
              turnGeneration: request.turnGeneration,
              operation,
              effectPayload,
            }),
          });
        } catch {
          execution = {
            protocol: request.protocol,
            executionId: request.executionId,
            argsDigest: request.argsDigest,
            ok: false,
            code: 'tool-execution-host-lost',
            error: 'Tool execution interrupted.',
            outcomeKnown: true,
            effectEntered: false,
            retryable: true,
            phase: 'run',
          };
        }
        const result = parseJson(await rpc('turn.tool.settle', {
          executionId: request.executionId,
          argsDigest: request.argsDigest,
          turnGeneration: request.turnGeneration,
          resultJson: JSON.stringify(execution),
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

/**
 * Bind a lazy local tool executor without placing its implementation graph in
 * the default turn module. The plain export remains the compatibility path.
 * @param {{executeToolCall?:(request:unknown,options:{signal:AbortSignal,
 *   authority:unknown,deadlineAt:number,
 *   kernelCall:(operation:string,payload:unknown)=>Promise<any>})=>Promise<any>}} [deps]
 */
export const createControllerTurnRuntime = ({ executeToolCall } = {}) => Object.freeze({
  runControllerTurn: (/** @type {unknown} */ payload, /** @type {any} */ options) =>
    runControllerTurnWith(payload, options, executeToolCall),
});

export const runControllerTurn = (
  /** @type {unknown} */ payload,
  /** @type {{signal:AbortSignal,authority?:unknown,
   * kernelCall?:(operation:string,payload:unknown)=>Promise<any>}} */ options,
) =>
  runControllerTurnWith(payload, options, undefined);
