// @ts-check
// peerd-runtime/ralph — Ralph-style persistent loop primitive.
//
// A loop that spawns FRESH-CONTEXT iterations against a plan file: read
// plan → pick ONE task → do it → run backpressure gates (WebVM
// lint/test/build + browser-native console/DOM) → commit → discard
// context → next. Persistence is the plan file + git/checkpoints, never
// a long-lived context window. Survives MV3 SW restarts (state in kv;
// each iteration independently resumable). See DESIGN.md.

export {
  // plan-file format (pure)
  parsePlan, serializePlan, pickNextTask, completeTask, failTask,
  isPlanExhausted, planSummary, EMPTY_PLAN, PLAN_KEY,
  // persisted plan store
  createPlanStore,
} from './plan-store.js';

export {
  // gate factories
  lintGate, testGate, buildGate,
  consoleCleanGate, domContainsGate,
  // the runner (gates.run() -> pass/fail)
  createGateRunner,
} from './gates.js';

export {
  createRalphLoop, decideNext, initLoopState,
  MAX_ITERATIONS, LOOP_STATE_KEY,
} from './loop.js';

export {
  // the SW-side driver: fresh-context runner + gates + checkpoint +
  // start/halt/status/reset/resume, all IO injected
  makeRalphDriver,
} from './driver.js';
