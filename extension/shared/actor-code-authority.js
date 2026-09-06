// @ts-check
// Fixed limits and validation for the one actors.call authority operation.

export const ACTORS_CALL_MAX_TIMEOUT_MS = 240_000;
export const ACTORS_CALL_DEFAULT_TIMEOUT_MS = 120_000;
export const ACTORS_ADDRESS_MAX_CHARS = 2_048;
export const ACTORS_GOAL_MAX_CHARS = 32_768;
export const ACTORS_TRACE_TARGET_MAX_CHARS = 256;
export const ACTORS_TRACE_ERROR_MAX_CHARS = 4_096;
export const ACTORS_RUN_MAX_OPS = 50;

const bounded = (/** @type {unknown} */ value, /** @type {string} */ label,
  /** @type {number} */ limit) => {
  if (typeof value !== 'string' || value.length > limit || value.trim().length === 0) {
    throw Object.assign(new Error(`${label} must be a non-empty string of at most ${limit} characters`), {
      outcomeKnown: true,
    });
  }
  return value;
};

/** Validate the exact run-bound delegation operation at the authority wall. */
export const validateActorCodeCall = (/** @type {unknown} */ value) => {
  const request = /** @type {any} */ (value);
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw Object.assign(new Error('actors.call request must be an object'), { outcomeKnown: true });
  }
  const allowed = new Set(['to', 'goal', 'timeoutMs', 'oneShot']);
  if (!Object.keys(request).every((key) => allowed.has(key))) {
    throw Object.assign(new Error('actors.call request contains an unknown field'), { outcomeKnown: true });
  }
  const to = bounded(request.to, 'actors.call address', ACTORS_ADDRESS_MAX_CHARS);
  const goal = bounded(request.goal, 'actors.call message', ACTORS_GOAL_MAX_CHARS);
  const timeoutMs = typeof request.timeoutMs === 'number' && request.timeoutMs > 0
    ? Math.min(request.timeoutMs, ACTORS_CALL_MAX_TIMEOUT_MS)
    : undefined;
  return Object.freeze({
    to, goal,
    ...(timeoutMs ? { timeoutMs } : {}),
    ...(request.oneShot === true ? { oneShot: true } : {}),
  });
};

/** Settle the exact awaited delegation without exposing mailbox custody. */
export const settleActorCodeCall = (
  /** @type {{ok:boolean,content?:string,error?:string}} */ result,
  /** @type {{timedOut:boolean,aborted?:boolean,timeoutMs:number,to:string}} */ state,
) => {
  if (state.timedOut) return {
    ok: /** @type {const} */ (false), error: `actors.call: timed out after ${state.timeoutMs}ms awaiting '${state.to}'`,
  };
  if (state.aborted) return {
    ok: /** @type {const} */ (false), error: `actors.call: aborted (Stop) while awaiting '${state.to}'`,
  };
  if (result.ok) return { ok: /** @type {const} */ (true), reply: result.content ?? null, failed: false };
  const error = String(result.error ?? 'actor call failed');
  if (error.startsWith('message_actor:')) return { ok: /** @type {const} */ (false), error };
  return { ok: /** @type {const} */ (true), reply: error, failed: true };
};
