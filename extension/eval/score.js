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
 *   cacheWriteTokens?: number, costUsd?: number, runnerCostUsd?: number,
 *   toolCalls?: number, toolErrors?: number, wastedTurns?: number,
 *   toolErrorsByName?: Record<string, number>, wastedByKind?: Record<string, number> }} TaskResult
 */

/** @param {number} n @param {number} [dp] */
const round = (n, dp = 2) => { const f = 10 ** dp; return Math.round(n * f) / f; };

/**
 * Sum the per-task `toolErrorsByName` maps into one suite rollup — which
 * tool failed, and how often, across the whole run. Ignores rows without the
 * field (early-return rows), so it's safe on a mixed result set.
 * @param {TaskResult[]} results
 * @returns {Record<string, number>}
 */
const rollupErrorsByName = (results) => {
  /** @type {Record<string, number>} */
  const out = {};
  for (const r of results) {
    const byName = r.toolErrorsByName;
    if (!byName || typeof byName !== 'object') continue;
    for (const [name, n] of Object.entries(byName)) {
      if (typeof n === 'number') out[name] = (out[name] ?? 0) + n;
    }
  }
  return out;
};

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
    // continuity with the emitted actor-cost events + the runnerModel A/B.
    avgRunnerTokens: avg(results, 'runnerTokens'),
    // Tool-outcome metrics (design 5): the harness can finally tell a call that
    // SUCCEEDED from one that FAILED, so an efficiency regression shows as data.
    // These sit ALONGSIDE passRate (the ground truth) — never replace it.
    avgToolErrors: avg(results, 'toolErrors'),
    avgToolCalls: avg(results, 'toolCalls'),
    // errors / total calls, summed suite-wide (not a mean of per-row rates) so a
    // task with more calls weighs proportionally. A fraction in [0,1]; 0 when no
    // calls ran. why sum/sum: a single-call task erroring shouldn't move the rate
    // as much as a 20-call task erroring five times.
    toolErrorRate: (() => {
      const errs = results.reduce((n, r) => n + (Number(r.toolErrors) || 0), 0);
      const calls = results.reduce((n, r) => n + (Number(r.toolCalls) || 0), 0);
      return calls ? round(errs / calls, 4) : 0;
    })(),
    avgWastedTurns: avg(results, 'wastedTurns'),
    toolErrorsByName: rollupErrorsByName(results),
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
    // Tool-outcome deltas (design 5) — negative = the fix reduced errors / wasted
    // work. A bench guard can block on toolErrorsDelta > 0 (opt-in, see
    // run-eval-bench.mjs) so a change that fixes pass-rate but doubles retries is
    // still visible.
    toolErrorsDelta: d('avgToolErrors'),
    toolErrorRateDelta: d('toolErrorRate', 4),
    wastedTurnsDelta: d('avgWastedTurns'),
  };
};

// --- wasted-turn heuristics (design 5b) ----------------------------------
//
// "Wasted turn" has no ground truth without a human, so this is an honest
// PROXY: three named, conservative heuristics over the task's tool transcript,
// each with a documented blind spot. The count is for spotting EFFICIENCY
// regressions build-over-build (did a fix make the agent thrash more?) — never
// a correctness signal (passRate stays the ground truth). Each heuristic is a
// separate key in `byKind` so a noisy one can be read (or ignored) on its own;
// `total` sums them and CAN over-count: a same-target read reissued with
// identical args trips both repeated-identical-call and truncation-forced-
// reread, and if that first read ERRORED it also trips error-then-retry — so one
// failed identical read-retry counts 3×. The overlap is deliberate; the
// heuristics measure different intents and `total` is a proxy, not a tally.

/**
 * A single tool call in the transcript: the tool name, the raw input (for
 * identity/target hashing), and the outcome (true = ok, false = errored,
 * undefined = never resolved). All optional but `name`.
 * @typedef {{ name: string, input?: unknown, ok?: boolean }} ToolCall
 */

// Read-ish tools whose repeat-on-the-same-target is the truncation-reread
// signal. A HEURISTIC allowlist — it drifts as tools are added; a read tool
// missing here is a false NEGATIVE (undercounts), never a false positive.
const READ_TOOLS = new Set(['read_file', 'read_memory', 'fetch_url', 'read_web_cache', 'read_state']);
// Arg keys tried, in order, as a read's "primary target" (the thing re-read).
const PRIMARY_ARG_KEYS = ['path', 'url', 'file', 'target', 'query', 'id', 'handle'];

/**
 * Order-independent JSON key for an args object, so `{a:1,b:2}` and `{b:2,a:1}`
 * hash the same. Pure; recurses through arrays/objects.
 * @param {unknown} v @returns {string}
 */
const stableStringify = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const obj = /** @type {Record<string, unknown>} */ (v);
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
};

/**
 * The primary target of a read call — the first present of PRIMARY_ARG_KEYS,
 * else the whole args key. Looser than a full-args hash on purpose: a paging
 * reread that only bumped an offset still shares a target.
 * @param {unknown} input
 */
const primaryArg = (input) => {
  if (!input || typeof input !== 'object') return stableStringify(input);
  const obj = /** @type {Record<string, unknown>} */ (input);
  for (const k of PRIMARY_ARG_KEYS) if (k in obj) return `${k}=${stableStringify(obj[k])}`;
  return stableStringify(obj);
};

/**
 * Count wasted turns over a tool transcript. Pure (values in, values out) so
 * it's Bun-testable against synthetic transcripts. Returns a `total` plus the
 * per-heuristic `byKind` breakdown.
 * @param {ToolCall[]} transcript
 * @returns {{ total: number, byKind: { repeatedIdenticalCall: number, errorThenRetry: number, truncationForcedReread: number } }}
 */
export const wastedTurns = (transcript) => {
  const calls = Array.isArray(transcript) ? transcript : [];

  // repeated-identical-call: the SAME {tool, full-args} issued more than once —
  // each extra copy is a retry that changed nothing. blind spot: a legitimately
  // idempotent repeat (polling a status that changed server-side, re-reading a
  // page that updated) reads as waste — we can't see the world between calls.
  /** @type {Map<string, number>} */
  const identity = new Map();
  for (const c of calls) {
    const key = `${c.name}\u0000${stableStringify(c.input ?? null)}`;
    identity.set(key, (identity.get(key) ?? 0) + 1);
  }
  let repeatedIdenticalCall = 0;
  for (const n of identity.values()) if (n > 1) repeatedIdenticalCall += n - 1;

  // error-then-retry: a failed call immediately followed by the SAME tool on the
  // next step (the model reacting to a bad error by re-poking it). blind spot:
  // only the IMMEDIATE next step and only the same tool NAME — a retry after an
  // intervening tool, or via a different tool, is invisible (undercounts).
  let errorThenRetry = 0;
  for (let i = 0; i < calls.length - 1; i++) {
    if (calls[i].ok === false && calls[i + 1].name === calls[i].name) errorThenRetry++;
  }

  // truncation-forced-reread: a READ tool re-issued against the same primary
  // target. Approximation — design 4's paged/truncation marker isn't wired yet,
  // so we can't confirm the FIRST read was actually truncated; absent that
  // marker every same-target reread counts. blind spot: over-counts a deliberate
  // fresh reread of changed content; overlaps repeated-identical-call.
  /** @type {Set<string>} */
  const readTargets = new Set();
  let truncationForcedReread = 0;
  for (const c of calls) {
    if (!READ_TOOLS.has(c.name)) continue;
    const key = `${c.name}\u0000${primaryArg(c.input)}`;
    if (readTargets.has(key)) truncationForcedReread++;
    readTargets.add(key);
  }

  return {
    total: repeatedIdenticalCall + errorThenRetry + truncationForcedReread,
    byKind: { repeatedIdenticalCall, errorThenRetry, truncationForcedReread },
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
 * from prior knowledge, or `script` to actually compute) — the same discipline
 * get-count/get-framework already key on, factored out for reuse.
 */
/** @param {unknown} tools @param {unknown} names */
export const usedAny = (tools, names) =>
  Array.isArray(tools) && Array.isArray(names) && names.some((n) => tools.includes(n));

/** Pass result with a detail string. @param {string} [detail] */
export const ok = (detail) => ({ pass: true, detail });
/** @param {string} [detail] */
export const no = (detail) => ({ pass: false, detail });
