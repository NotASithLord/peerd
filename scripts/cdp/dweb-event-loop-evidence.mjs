// Harness-only renderer timer lateness. No production code or remote telemetry.
// why: fixed histogram storage lets an overnight run retain every observation
// without an unbounded sample list. Delays include OS scheduling/throttling.
/** @param {{now?: () => number, timers?: any}} [options] */
export const createEventLoopObservation = ({ now = () => performance.now(), timers = globalThis } = {}) => {
  const intervalMs = 100;
  const upperBoundsMs = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384];
  const buckets = Array(upperBoundsMs.length + 1).fill(0);
  const startedAtMs = now();
  let expectedAt = startedAtMs + intervalMs;
  let samples = 0, totalDelayMs = 0, maxDelayMs = 0, stopped = false;
  let timer;
  const tick = () => {
    if (stopped) return;
    const observedAt = now();
    const delay = Math.max(0, observedAt - expectedAt);
    const index = upperBoundsMs.findIndex(bound => delay <= bound);
    buckets[index < 0 ? upperBoundsMs.length : index]++;
    samples++;
    totalDelayMs += delay;
    maxDelayMs = Math.max(maxDelayMs, delay);
    // why: a stall produces one delayed observation, not a catch-up burst.
    expectedAt = observedAt + intervalMs;
    timer = timers.setTimeout(tick, intervalMs);
  };
  timer = timers.setTimeout(tick, intervalMs);
  return {
    snapshot: () => ({ scope: 'controlled-renderer', intervalMs, startedAtMs,
      observedAtMs: now(), samples, totalDelayMs, maxDelayMs,
      upperBoundsMs: [...upperBoundsMs], buckets: [...buckets], stopped }),
    stop: () => { stopped = true; timers.clearTimeout(timer); },
  };
};
