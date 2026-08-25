// @ts-check

import { formatDelta, isoSecondsZ, parseDuration } from './now.js';

const WAIT_MAX_MS = 60 * 60 * 1000;
const abortError = () => new DOMException('wait_until aborted', 'AbortError');

/** @param {number} ms @param {AbortSignal|undefined} signal */
const wait = (ms, signal) => {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(undefined);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
};

/**
 * @param {{when?:unknown}} args
 * @param {{signal?:AbortSignal,now?:()=>number,
 *   wait?:(ms:number,signal?:AbortSignal)=>Promise<unknown>}} [options]
 */
export const executeWaitUntil = async (args, {
  signal,
  now = Date.now,
  wait: waitFor = wait,
} = {}) => {
  const { when } = args;
  if (typeof when !== 'string' || !when) {
    return { ok: false, error: 'wait_until requires a duration or ISO timestamp string.' };
  }
  const parsed = Date.parse(when);
  const duration = parseDuration(when);
  const targetMs = Number.isFinite(parsed) ? parsed
    : Number.isFinite(duration) ? now() + duration : null;
  if (targetMs === null) {
    return { ok: false, error: `wait_until: could not parse "${when}" as a duration or ISO timestamp.` };
  }
  const durationMs = Math.max(0, targetMs - now());
  if (durationMs > WAIT_MAX_MS) {
    return {
      ok: false,
      error: `wait_until refuses to block for more than ${formatDelta(WAIT_MAX_MS)} (asked: ${formatDelta(durationMs)}).`,
    };
  }
  await waitFor(durationMs, signal);
  return {
    ok: true,
    content: JSON.stringify({
      waited: formatDelta(durationMs), waitedMs: durationMs,
      resumedAt: isoSecondsZ(now()),
    }, null, 2),
  };
};
