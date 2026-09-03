// @ts-check

/** @param {AbortSignal|undefined} signal @param {string} fallback */
export const abortError = (signal, fallback) => {
  const reason = /** @type {{name?:string,message?:string}|undefined} */ (signal?.reason);
  return reason?.name === 'AbortError' && signal?.reason instanceof Error
    ? signal.reason
    : new DOMException(reason?.message ?? fallback, 'AbortError');
};

/** @param {AbortSignal|undefined} signal @param {string} fallback */
export const throwIfAborted = (signal, fallback) => {
  if (signal?.aborted) throw abortError(signal, fallback);
};

/**
 * Start cancellation without letting a hostile/nonconforming stream delay the
 * caller's own refusal. Cleanup is observed but never owns lifecycle settlement.
 * @param {{cancel?:(reason?:unknown)=>unknown}|null|undefined} target
 * @param {unknown} [reason]
 */
export const cancelBestEffort = (target, reason) => {
  try { Promise.resolve(target?.cancel?.(reason)).catch(() => {}); }
  catch { /* cancellation is observation-only */ }
};

/**
 * Reject a blocked stream read immediately while observing late read/cancel
 * outcomes so they cannot re-enter the settled operation.
 * @param {any} reader
 * @param {AbortSignal|undefined} signal
 * @param {string} fallback
 */
export const readAbortableChunk = (reader, signal, fallback) => {
  if (!signal) return reader.read();
  if (signal.aborted) return Promise.reject(abortError(signal, fallback));
  return new Promise((resolve, reject) => {
    let settled = false;
    /** @param {(value:any)=>void} finish @param {any} value */
    const settle = (finish, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      finish(value);
    };
    const onAbort = () => {
      settle(reject, abortError(signal, fallback));
      cancelBestEffort(reader, signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    Promise.resolve(reader.read()).then(
      (value) => settle(resolve, value),
      (cause) => settle(reject, cause),
    );
  });
};
