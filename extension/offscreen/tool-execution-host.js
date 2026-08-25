// @ts-check

import {
  TOOL_EXECUTION_PROTOCOL,
  createToolEffectQuota,
  parseToolExecutionRequest,
  toolEffectLossSemantics,
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
    let pendingEffects = 0;
    let pendingIrreversible = 0;
    let settledIrreversible = false;
    let unknownIrreversible = false;
    const custody = () => {
      if (pendingIrreversible > 0 || unknownIrreversible) {
        return { outcomeKnown: false, retryable: false };
      }
      return {
        outcomeKnown: true,
        retryable: !settledIrreversible,
      };
    };
    const stoppedForLoss = (/** @type {string} */ code) => {
      const state = custody();
      return stopped(request, code, state.outcomeKnown, effectEntered, {
        retryable: state.retryable, phase: 'run',
      });
    };
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
        if (typeof options.kernelCall !== 'function') {
          return { ok: false, code: 'tool-effect-kernel-unavailable', outcomeKnown: true };
        }
        const admitted = quota.admit(effect.operation, effectPayload);
        if (admitted.ok !== true) return admitted;
        const replayable = effect.riskClass === 'read' || effect.riskClass === 'control';
        effectEntered = true;
        pendingEffects += 1;
        if (!replayable) pendingIrreversible += 1;
        let result;
        try { result = await options.kernelCall(effect.operation, effectPayload); }
        catch {
          const loss = toolEffectLossSemantics(effect.riskClass, 'during');
          result = {
            ok: false, code: 'tool-effect-kernel-lost',
            outcomeKnown: loss.outcomeKnown, retryable: loss.retryable,
          };
        } finally {
          pendingEffects = Math.max(0, pendingEffects - 1);
          if (!replayable) pendingIrreversible = Math.max(0, pendingIrreversible - 1);
        }
        const observed = quota.observe(effect.operation, result);
        if (observed.ok !== true) {
          const loss = toolEffectLossSemantics(effect.riskClass, 'during');
          if (!loss.outcomeKnown) unknownIrreversible = true;
          return {
            ...observed,
            outcomeKnown: loss.outcomeKnown,
            retryable: loss.retryable,
          };
        }
        if (result?.outcomeKnown !== true && !replayable) unknownIrreversible = true;
        if (!replayable && result?.outcomeKnown === true
            && (result?.ok === true || result?.retryable !== true)) settledIrreversible = true;
        if (!grantOpen || abort.signal.aborted || Number(options.deadlineAt) <= now()) {
          const loss = toolEffectLossSemantics(
            effect.riskClass, result?.outcomeKnown === true ? 'after' : 'during',
          );
          return {
            ok: false, code: 'tool-effect-grant-settled',
            outcomeKnown: loss.outcomeKnown, retryable: loss.retryable,
          };
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
        custody().outcomeKnown,
        effectEntered,
        { retryable: custody().retryable, phase: 'run' },
      ));
      abort.abort();
    }, Math.max(1, Number(options.deadlineAt) - now()));
    const abortedRun = new Promise((resolve) => {
      abort.signal.addEventListener('abort', () => resolve(stopped(
        request,
        'tool-execution-aborted',
        custody().outcomeKnown,
        effectEntered,
        { retryable: custody().retryable, phase: 'run' },
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
          if (unknownIrreversible) return stoppedForLoss('tool-effect-outcome-unknown');
          if (pendingEffects > 0) return stoppedForLoss('tool-effect-pending');
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
            : stoppedForLoss('tool-execution-result-invalid');
        })
        .catch((cause) => {
          const loss = custody();
          return stopped(request, projectedError(cause).code, loss.outcomeKnown, effectEntered, {
            ...projectedError(cause), retryable: loss.retryable, phase: 'run',
          });
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
