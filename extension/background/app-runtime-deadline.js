// @ts-check

export const APP_RUNTIME_DEADLINE_MS = 13_000;
export const APP_RUNTIME_TIMEOUT_ERROR = 'app_runtime_call_timed_out_outcome_unknown';

/**
 * Relay one App runtime operation with an independent service-worker deadline.
 * A timeout poisons this tab generation before requesting a reload: the old
 * document may still finish the operation, so no next call may overlap it.
 *
 * @param {{
 *   tabId:number,
 *   message:any,
 *   send:(tabId:number,message:any)=>Promise<any>,
 *   reload:(tabId:number)=>Promise<any>,
 *   poisoned:Set<number>,
 *   signal?:AbortSignal,
 *   timeoutMs?:number,
 *   setTimer?:(fn:()=>void,ms:number)=>any,
 *   clearTimer?:(timer:any)=>void,
 * }} input
 */
export const relayAppRuntimeCall = async ({
  tabId, message, send, reload, poisoned, signal,
  timeoutMs = APP_RUNTIME_DEADLINE_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) => {
  if (poisoned.has(tabId)) {
    return { ok: false, error: 'app_runtime_generation_poisoned', outcomeKnown: false, outcomeKind: 'transport-lost' };
  }
  if (signal?.aborted) {
    return { ok: false, error: 'app_runtime_call_aborted_before_dispatch', outcomeKnown: true, outcomeKind: 'pre-effect-failure' };
  }
  /** @type {any} */ let timer;
  let recoveryIssued = false;
  /** @type {(() => void)|undefined} */ let onAbort;
  const poisonAndReload = () => {
    if (recoveryIssued) return;
    recoveryIssued = true;
    poisoned.add(tabId);
    Promise.resolve(reload(tabId)).catch(() => {});
  };
  try {
    return await Promise.race([
      Promise.resolve().then(() => send(tabId, message)),
      new Promise((resolve) => {
        timer = setTimer(() => {
          poisonAndReload();
          resolve({ ok: false, error: APP_RUNTIME_TIMEOUT_ERROR, outcomeKnown: false, outcomeKind: 'transport-lost' });
          // Reload is recovery, not part of the response deadline. The poison
          // remains until the replacement document completes tab-ready.
        }, timeoutMs);
      }),
      new Promise((resolve) => {
        if (!signal) return;
        onAbort = () => {
          // Once send() was admitted, cancellation cannot prove whether the
          // App handled it. Poison the whole document generation before the
          // caller can start another action.
          poisonAndReload();
          resolve({ ok: false, error: 'app_runtime_call_aborted_outcome_unknown', outcomeKnown: false, outcomeKind: 'transport-lost' });
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimer(timer);
    if (onAbort && signal) signal.removeEventListener('abort', onAbort);
  }
};
