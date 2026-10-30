// Optional sustained transport qualification; never changes production defaults.
export const soakOptions = value => {
  if (value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['durationMs', 'intervalMs'].includes(key))) {
    throw new Error('soak accepts only durationMs and intervalMs');
  }
  const { durationMs, intervalMs = 30_000 } = value;
  if (!Number.isSafeInteger(durationMs) || durationMs < 60_000 || durationMs > 24 * 60 * 60_000
    || !Number.isSafeInteger(intervalMs) || intervalMs < 1000 || intervalMs > 60_000 || intervalMs > durationMs) {
    throw new Error('Invalid bounded soak duration or interval');
  }
  return { durationMs, intervalMs };
};

// Idle observations are separate from the connected workload. Keep this phase
// short and require the collector rather than silently recording empty evidence.
export const idleBaselineOptions = (value, resourceMetrics) => {
  if (value === undefined) return null;
  if (resourceMetrics !== true) throw new Error('idleBaseline requires resourceMetrics: true');
  const options = soakOptions(value);
  if (options.durationMs > 300_000 || options.intervalMs < 30_000) {
    throw new Error('Idle baseline must be at most five minutes with samples at least thirty seconds apart');
  }
  return options;
};

// why: keep checkpoints bounded even overnight, while preserving every failed
// attempt and the number of completed cycles. A failed probe ends qualification.
export const runSoak = async ({ options, probe, save, now, sleep }) => {
  const start = now();
  const evidence = { ...options, completed: false, cycles: 0, elapsedMs: 0, samples: [] };
  let pendingSample;
  let probeStarted;
  await save(evidence);
  try {
    for (;;) {
      const before = now();
      probeStarted = before;
      pendingSample = { cycle: evidence.cycles + 1, elapsedMs: before - start, probeMs: 0, stages: [] };
      // Fixed names and one observation per stage bound both successful and
      // failed receipts. Keep timing separate from operation return values.
      const timed = async (name, operation) => {
        if (!['mesh', 'gossip', 'fetch', 'paths', 'resources'].includes(name)
          || pendingSample.stages.some(stage => stage.name === name)) throw new Error('Invalid soak timing stage');
        const stage = { name, ms: 0, ok: false };
        pendingSample.stages.push(stage);
        const began = now();
        try {
          const value = await operation();
          stage.ok = true;
          return value;
        } finally { stage.ms = now() - began; }
      };
      await probe(timed);
      const after = now();
      evidence.cycles += 1;
      evidence.elapsedMs = after - start;
      pendingSample.elapsedMs = evidence.elapsedMs;
      pendingSample.probeMs = after - before;
      evidence.samples.push(pendingSample);
      pendingSample = null;
      if (evidence.samples.length > 32) evidence.samples.shift();
      // A final successful probe must begin after the requested duration. A
      // slow first probe or an elapsed timer alone cannot certify a soak.
      if (before - start >= options.durationMs) evidence.completed = true;
      await save(evidence);
      if (evidence.completed) return evidence;
      await sleep(Math.min(options.intervalMs, Math.max(0, options.durationMs - (now() - start))));
    }
  } catch (error) {
    evidence.completed = false;
    evidence.elapsedMs = now() - start;
    if (pendingSample) {
      pendingSample.elapsedMs = evidence.elapsedMs;
      pendingSample.probeMs = now() - probeStarted;
      evidence.failedSample = pendingSample;
    }
    evidence.error = error.message;
    await save(evidence);
    throw error;
  }
};
