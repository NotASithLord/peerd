// @ts-check
// Pure retry shell for actor failures that prove no work began.

import { isKnownActorStartupFailure } from './offscreen-actor-channel-client.js';

const LEGACY_ACTOR_HOST_STARTUP_CODES = new Set([
  'actor_host_unavailable',
  'actor_host_not_ready',
  'actor_host_keepalive_failed',
  'actor_worker_spawn_failed',
  'actor_worker_start_timeout',
  'actor_worker_crashed',
  'actor_worker_message_error',
  'actor_worker_protocol_error',
]);

export const isActorHostStartupFailure = (/** @type {any} */ result) =>
  isKnownActorStartupFailure(result)
  || (result?.started === false && LEGACY_ACTOR_HOST_STARTUP_CODES.has(result?.code));

/**
 * @param {Object} deps
 * @param {() => Promise<any>} deps.run
 * @param {(result: any) => boolean} deps.isStartupFailure
 * @param {AbortSignal} [deps.signal]
 */
export const runActorWithStartupRetry = async ({ run, isStartupFailure, signal }) => {
  let result = await run();
  if (!isStartupFailure(result)) return { result, exhausted: false };
  if (result?.code === 'actor_host_load_timeout') return { result, exhausted: true };
  if (signal?.aborted) return { result: { ...result, aborted: true }, exhausted: false };
  result = await run();
  return { result, exhausted: isStartupFailure(result) };
};
