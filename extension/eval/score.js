// @ts-check
// eval/score — pure scoring + aggregation for the task harness.
//
// The runner produces a `result` per task; this aggregates them into a
// scorecard. Kept pure (values in, values out) so it's unit-testable
// without a browser — the harness's own logic is held to the same bar it
// holds peerd to.

/**
 * @typedef {{ id: string, pass: boolean, detail?: string, error?: string|null,
 *   steps?: number, tokens?: number, durationMs?: number, tools?: string[],
 *   inputTokens?: number, outputTokens?: number, cacheReadTokens?: number,
 *   cacheWriteTokens?: number, costUsd?: number, runnerCostUsd?: number }} TaskResult
 */

/** @param {number} n @param {number} [dp] */
const round = (n, dp = 2) => { const f = 10 ** dp; return Math.round(n * f) / f; };

/**
 * Average a numeric field across results, ignoring missing values.
 * @param {Record<string, unknown>[]} results
 * @param {string} key
 * @param {number} [dp]
 */
const avg = (results, key, dp = 2) => {
  const vals = /** @type {number[]} */ (results.map((r) => r[key]).filter((v) => typeof v === 'number'));
  if (!vals.length) return 0;
  return round(vals.reduce((a, b) => a + b, 0) / vals.length, dp);
};

/**
 * Roll a set of TaskResults into a scorecard. passRate is the headline
 * number — the single metric that turns "does it work?" into data.
 *
 * why the token SPLIT: a single collapsed "tokens" number conflates cheap
 * cache-reads (re-reading the cached system-prompt + tool schemas each turn,
 * billed at ~10% of input) with full-price fresh input/output. That hides
 * whether a high number is a DOLLAR problem (optimize) or a context-window
 * problem (the static block is large but cached). So we surface each bucket,
 * the fresh total (input+output — the real-cost / context-pressure proxy),
 * and the actual USD cost computed client-side from the local pricing table.
 * @param {TaskResult[]} results
 */
export const aggregate = (results) => {
  const total = results.length;
  const passed = results.filter((r) => r.pass).length;
  return {
    total,
    passed,
    failed: total - passed,
    passRate: total ? Math.round((passed / total) * 1000) / 10 : 0, // one decimal %
    avgSteps: avg(results, 'steps'),
    avgTokens: avg(results, 'tokens'),                              // total (all four buckets) — kept for continuity
    avgInputTokens: avg(results, 'inputTokens'),
    avgOutputTokens: avg(results, 'outputTokens'),
    avgCacheReadTokens: avg(results, 'cacheReadTokens'),
    avgCacheWriteTokens: avg(results, 'cacheWriteTokens'),
    // input+output — full-price, the real $ + context-pressure driver. Averaged
    // PER ROW (not sum-of-bucket-averages) so it stays correct even if a row
    // ever carries one bucket but not the other — score.js owns its own math
    // rather than depending on the caller filling both.
    avgFreshTokens: avg(results.map((r) => ({ fresh: (r.inputTokens || 0) + (r.outputTokens || 0) })), 'fresh'),
    // Web actor spend (the offloaded page work). Page mechanics live OFF the
    // main context in the actor — so main fresh/cache should be low and this is
    // where the a11y work lives. Tracking it keeps the scorecard honest (the
    // offload isn't free, it's relocated). Field name stays `runnerTokens` for
    // continuity with the emitted subagent-cost events + the runnerModel A/B.
    avgRunnerTokens: avg(results, 'runnerTokens'),
    avgCostUsd: avg(results, 'costUsd', 5),                         // MAIN-loop $ (the chat model orchestrating) from the local pricing table
    // The RUNNER's own $ — the model under A/B test. $0 for a local/on-device
    // runner (priced at the zero-rate card), real $ for a cloud runner. This is
    // what makes "local is free" visible: a free local runner reads $0 here.
    avgRunnerCostUsd: avg(results, 'runnerCostUsd', 5),
    // Total a task actually costs you = main loop + runner. Per-row sum so it's
    // correct even if a row carries one but not the other.
    avgTotalCostUsd: avg(results.map((r) => ({ t: (r.costUsd || 0) + (r.runnerCostUsd || 0) })), 't', 5),
    avgDurationMs: avg(results, 'durationMs'),
    failures: results.filter((r) => !r.pass).map((r) => ({ id: r.id, detail: r.detail, error: r.error })),
  };
};

/**
 * Delta between two scorecards (each from `aggregate`) — the regression
 * signal. `before` is the baseline (e.g. last good run), `after` the current
 * run. This is what turns "did my prompt/model change help or hurt?" into an
 * answer instead of eyeballing two scorecards side by side.
 *
 * Per-task transitions are derived from the `failures` id sets each card
 * carries: a task that newly appears in `after.failures` is a REGRESSION (was
 * passing, now isn't — the thing to block on); one that left is a FIX. This
 * assumes a STABLE suite across the two runs (the normal case — same tasks.js).
 * A task present in only one run shows up as a one-sided regression/fix, which
 * is the honest read of "the suite changed too."
 *
 * Numeric deltas are `after − before`, and lead with the two a quality/
 * efficiency change is meant to move: passRate (higher = better) and
 * avgFreshTokens + avgCostUsd (lower = better — so a NEGATIVE cost delta is
 * the win). Kept pure (values in, values out) like the rest of this module.
 *
 * @param {ReturnType<typeof aggregate>} before
 * @param {ReturnType<typeof aggregate>} after
 */
export const compare = (before, after) => {
  const beforeFails = new Set((before?.failures ?? []).map((f) => f.id));
  const afterFails = new Set((after?.failures ?? []).map((f) => f.id));
  /** @param {keyof ReturnType<typeof aggregate>} key @param {number} [dp] */
  const d = (key, dp = 2) => round((Number(after?.[key]) || 0) - (Number(before?.[key]) || 0), dp);
  return {
    // The headline pair: what newly broke, and what newly works.
    regressions: [...afterFails].filter((id) => !beforeFails.has(id)),
    fixes: [...beforeFails].filter((id) => !afterFails.has(id)),
    passRateDelta: d('passRate', 1),
    // input+output — the real $ + context-pressure driver; the number a
    // token-efficiency change is meant to move. Negative = leaner.
    freshTokensDelta: d('avgFreshTokens'),
    runnerTokensDelta: d('avgRunnerTokens'),
    // Negative = cheaper. 5dp so a sub-cent improvement isn't rounded to $0.
    costUsdDelta: d('avgCostUsd', 5),
    stepsDelta: d('avgSteps'),
    durationMsDelta: d('avgDurationMs'),
  };
};

// --- check helpers (used by task `check` functions) ----------------------

/** @param {unknown} haystack @param {unknown} needle */
export const includesCI = (haystack, needle) =>
  typeof haystack === 'string' && typeof needle === 'string'
  && haystack.toLowerCase().includes(needle.toLowerCase());

/**
 * Did the agent use any of these tools this turn? Lets a check assert the
 * agent took the RIGHT PATH (e.g. used `get` to inspect rather than guessing
 * from prior knowledge, or `js_run` to actually compute) — the same discipline
 * get-count/get-framework already key on, factored out for reuse.
 */
/** @param {unknown} tools @param {unknown} names */
export const usedAny = (tools, names) =>
  Array.isArray(tools) && Array.isArray(names) && names.some((n) => tools.includes(n));

/** Pass result with a detail string. @param {string} [detail] */
export const ok = (detail) => ({ pass: true, detail });
/** @param {string} [detail] */
export const no = (detail) => ({ pass: false, detail });
