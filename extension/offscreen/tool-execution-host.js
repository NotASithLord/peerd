// @ts-check

import {
  TOOL_EXECUTION_PROTOCOL,
  createToolEffectQuota,
  parseToolExecutionRequest,
  toolExecutionResultAllowed,
} from '/shared/tool-execution-protocol.js';

const stopped = (
  /** @type {any} */ request,
  /** @type {string} */ code,
  /** @type {boolean} */ outcomeKnown,
  /** @type {boolean} */ effectEntered,
  /** @type {Record<string, unknown>} */ extra = {},
) => Object.freeze({
  protocol: TOOL_EXECUTION_PROTOCOL,
  executionId: request?.executionId ?? 'invalid',
  argsDigest: request?.argsDigest ?? '0'.repeat(64),
  ok: false,
  code,
  outcomeKnown,
  effectEntered,
  ...extra,
});

const projectedError = (/** @type {unknown} */ cause) => {
  const error = /** @type {{message?:unknown,code?:unknown,outcomeKind?:unknown,
   * outcomeKnown?:unknown,retryable?:unknown}} */ (cause);
  const code = typeof error?.code === 'string' && /^[a-z0-9][a-z0-9-]{0,127}$/.test(error.code)
    ? error.code : 'tool-execution-failed';
  return {
    code,
    error: typeof error?.message === 'string' && error.message.length <= 4_096
      ? error.message : 'Tool execution failed.',
    ...(typeof error?.retryable === 'boolean' ? { retryable: error.retryable } : {}),
  };
};

/**
 * Controller-side executor. Implementations receive `{projection, effects}`;
 * they never receive a kernel context or a generic method router.
 * @param {Object} deps
 * @param {ReturnType<import('/shared/tool-execution-protocol.js').compileToolEffectManifest>} deps.manifest
 * @param {Record<string,(args:unknown,context:{projection:unknown,signal:AbortSignal,
 *   deadlineAt:number,effects:Record<string,(payload:unknown)=>Promise<any>>})=>Promise<unknown>|unknown>} deps.implementations
 * @param {() => number} [deps.now]
 * @param {typeof setTimeout} [deps.setTimeoutFn]
 * @param {typeof clearTimeout} [deps.clearTimeoutFn]
 */
export const createToolExecutionHost = ({
  manifest,
  implementations,
  now = Date.now,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
}) => {
  if (!manifest || !implementations || typeof implementations !== 'object') {
    throw new TypeError('tool-execution-host-invalid');
  }
  const toolNames = Object.keys(manifest.tools ?? {});
  if (toolNames.length !== Object.keys(implementations).length
      || toolNames.some((name) => !Object.hasOwn(implementations, name)
        || typeof implementations[name] !== 'function')) {
    throw new TypeError('tool-execution-host-incomplete');
  }
  const dispatch = async (/** @type {unknown} */ payload, /** @type {{
   * signal:AbortSignal,authority?:any,deadlineAt?:number,
   * kernelCall?:(operation:string,payload:unknown)=>Promise<any>
   * }} */ options) => {
    const request = parseToolExecutionRequest(payload, manifest);
    if (!request) return stopped(null, 'tool-execution-request-invalid', true, false);
    const authority = options?.authority;
    if (!authority || authority.ownerId !== request.runId
        || authority.sessionId !== request.sessionId
        || authority.target !== `tool:${request.toolName}`
        || authority.replayClass !== 'E') {
      return stopped(request, 'tool-execution-authority-invalid', true, false);
    }
    if (!options?.signal || options.signal.aborted
        || !Number.isSafeInteger(options.deadlineAt) || Number(options.deadlineAt) <= now()) {
      return stopped(request, 'tool-execution-grant-invalid', true, false);
    }
    const implementation = implementations[request.toolName];
    if (typeof implementation !== 'function') {
      return stopped(request, 'tool-execution-unimplemented', true, false);
    }
    const quota = createToolEffectQuota(request.policy);
    const abort = new AbortController();
    let grantOpen = true;
    let effectEntered = false;
    let unknownEffect = false;
    let pendingEffects = 0;
    const onAbort = () => abort.abort();
    options.signal.addEventListener('abort', onAbort, { once: true });
    const effects = Object.fromEntries(request.policy.effects.map((/** @type {any} */ effect) => [
      effect.method,
      async (/** @type {unknown} */ effectPayload) => {
        if (!grantOpen || abort.signal.aborted || Number(options.deadlineAt) <= now()) {
          return { ok: false, code: 'tool-effect-grant-settled', outcomeKnown: true };
        }
        if (pendingEffects >= quota.pendingCap) {
          return { ok: false, code: 'tool-effect-concurrency-exhausted', outcomeKnown: true };
        }
        const admitted = quota.admit(effect.operation, effectPayload);
        if (admitted.ok !== true) return admitted;
        if (typeof options.kernelCall !== 'function') {
          return { ok: false, code: 'tool-effect-kernel-unavailable', outcomeKnown: true };
        }
        effectEntered = true;
        pendingEffects += 1;
        let result;
        try { result = await options.kernelCall(effect.operation, effectPayload); }
        catch { result = { ok: false, code: 'tool-effect-kernel-lost', outcomeKnown: false }; }
        finally { pendingEffects = Math.max(0, pendingEffects - 1); }
        const observed = quota.observe(effect.operation, result);
        if (observed.ok !== true) {
          unknownEffect = true;
          return observed;
        }
        if (result?.outcomeKnown !== true) unknownEffect = true;
        if (!grantOpen || abort.signal.aborted || Number(options.deadlineAt) <= now()) {
          return { ok: false, code: 'tool-effect-grant-settled', outcomeKnown: false };
        }
        return result;
      },
    ]));
    Object.freeze(effects);
    let finish = (/** @type {any} */ _result) => {};
    const stoppedRun = new Promise((resolve) => { finish = resolve; });
    const deadlineTimer = setTimeoutFn(() => {
      finish(stopped(
        request,
        'tool-execution-deadline-expired',
        !effectEntered,
        effectEntered,
        { retryable: !effectEntered, phase: 'run' },
      ));
      abort.abort();
    }, Math.max(1, Number(options.deadlineAt) - now()));
    const abortedRun = new Promise((resolve) => {
      abort.signal.addEventListener('abort', () => resolve(stopped(
        request,
        'tool-execution-aborted',
        !effectEntered,
        effectEntered,
        { retryable: !effectEntered, phase: 'run' },
      )), { once: true });
    });
    try {
      const execution = Promise.resolve()
        .then(() => implementation(request.args, {
          projection: request.projection,
          signal: abort.signal,
          deadlineAt: Number(options.deadlineAt),
          effects,
        }))
        .then((value) => {
          if (unknownEffect) {
            return stopped(request, 'tool-effect-outcome-unknown', false, true, {
              retryable: false, phase: 'run',
            });
          }
          const result = {
            protocol: TOOL_EXECUTION_PROTOCOL,
            executionId: request.executionId,
            argsDigest: request.argsDigest,
            ok: true,
            outcomeKnown: true,
            effectEntered,
            value,
          };
          return toolExecutionResultAllowed(result, request.policy.resultBytes)
            ? Object.freeze(result)
            : stopped(request, 'tool-execution-result-invalid', !effectEntered, effectEntered, {
              retryable: !effectEntered, phase: 'run',
            });
        })
        .catch((cause) => {
          const error = /** @type {{outcomeKind?:unknown,outcomeKnown?:unknown}} */ (cause);
          const completed = error?.outcomeKind === 'effect-completed'
            && error?.outcomeKnown === true;
          return stopped(
            request,
            projectedError(cause).code,
            !effectEntered || completed,
            effectEntered,
            { ...projectedError(cause), retryable: !effectEntered },
          );
        });
      return await Promise.race([execution, stoppedRun, abortedRun]);
    } finally {
      grantOpen = false;
      abort.abort();
      clearTimeoutFn(deadlineTimer);
      options.signal.removeEventListener('abort', onAbort);
    }
  };
  return Object.freeze({ dispatch });
};
