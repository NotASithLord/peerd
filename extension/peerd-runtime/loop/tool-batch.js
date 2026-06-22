// @ts-check
// Tool-batch scheduling — the pure half of concurrent tool dispatch.
//
// When a single assistant turn carries several tool_use blocks, the loop
// wants to run the independent ones concurrently without ever letting two
// side effects interleave. This module owns the SCHEDULING decision as a
// pure function (functional core); the agent loop keeps the IO (events,
// dispatch, persistence).
//
// The rule, deliberately conservative:
//   - the caller supplies `isConcurrencySafe(toolUse)` — in production
//     that's derived from the EXISTING permission classification
//     (classifyAction/decideAction in permissions/policy.js): READ-class
//     calls are safe; anything that writes, or would need a confirmation
//     round-trip, is not.
//   - only CONSECUTIVE safe calls group into one concurrent wave. A safe
//     call that the model emitted AFTER an unsafe one is NOT hoisted past
//     it — the model may have sequenced "click, then read the result"
//     on purpose, and reordering would break that causality. Order
//     between waves is exactly the model's emitted order.
//   - unsafe calls each form their own single-call sequential wave, so
//     confirmation round-trips can never race each other (stacked
//     confirm modals are a UX failure).

/**
 * @template {{ id: string, name: string }} T
 * @typedef {{ concurrent: boolean, calls: T[] }} ToolWave
 *   One scheduling unit. `concurrent: true` waves (always 2+ calls) may
 *   dispatch via Promise.all/asCompleted; sequential waves run one call.
 */

/**
 * Partition a turn's tool_use blocks into ordered dispatch waves.
 *
 * Pure: no IO, no clock. The flattened wave order always equals the input
 * order, which is what lets the loop persist tool_result blocks in the
 * model's emitted order regardless of completion order.
 *
 * @template {{ id: string, name: string }} T
 * @param {ReadonlyArray<T>} toolUses          in the model's emitted order
 * @param {(toolUse: T) => boolean} isConcurrencySafe
 *   Predicate; a throw counts as "not safe" (fail toward serial — the
 *   pre-existing, always-correct behavior).
 * @returns {ToolWave<T>[]}
 */
export const partitionToolBatch = (toolUses, isConcurrencySafe) => {
  /** @type {ToolWave<any>[]} */
  const waves = [];
  /** @type {ToolWave<any> | null} */
  let run = null;
  for (const tu of toolUses ?? []) {
    let safe = false;
    try { safe = isConcurrencySafe(tu) === true; }
    catch { safe = false; }
    if (safe) {
      if (run) {
        run.calls.push(tu);
      } else {
        run = { concurrent: true, calls: [tu] };
        waves.push(run);
      }
    } else {
      run = null;
      waves.push({ concurrent: false, calls: [tu] });
    }
  }
  // why: a one-call "concurrent" wave is just a sequential call — mark it
  // so, to keep the loop's two branches honest and assertions simple.
  for (const w of waves) {
    if (w.calls.length === 1) w.concurrent = false;
  }
  return waves;
};
