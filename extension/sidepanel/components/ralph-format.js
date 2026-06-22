// @ts-check
// Ralph status formatting — pure helpers for the chat view's Ralph
// panel. Pulled out of ralph-panel.js (no Mithril import, values in /
// values out) so the mapping logic is bun-testable without a browser —
// see tests/sidepanel/ralph-format.test.ts.

// LoopState statuses that mean "the loop is (or believes it is) running".
// 'paused' is in the LoopState typedef for forward-compat; nothing sets
// it today, but treating it as active keeps the panel honest if it ever
// appears.
export const RALPH_ACTIVE_STATUSES = Object.freeze(['planning', 'building', 'paused']);

/** @param {string|undefined} status */
export const isRalphActive = (status) =>
  status !== undefined && RALPH_ACTIVE_STATUSES.includes(status);

// Human labels for LoopState.status. 'building' reads as plain "running"
// — the phase distinction only matters during the one-off planning pass.
/** @type {Readonly<Record<string, string>>} */
const STATUS_LABELS = Object.freeze({
  planning: 'running · planning',
  building: 'running',
  paused: 'paused',
  halted: 'stopped',
  done: 'done',
  error: 'error',
  idle: 'idle',
});

/** @param {string|undefined} status */
export const ralphStatusLabel = (status) =>
  (status === undefined ? undefined : STATUS_LABELS[status]) ?? (status || 'unknown');

/**
 * Wall-clock elapsed since `startedAt`, compact: '42s', '3m 5s',
 * '2h 14m'. Clamps negative (clock skew / bogus state) to '0s'.
 *
 * @param {number} startedAt ms since epoch
 * @param {number} [now]
 */
export const formatElapsed = (startedAt, now = Date.now()) => {
  const secs = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
};

/**
 * Plan progress line from a planSummary() shape
 * ({ total, pending, 'in-progress', done, blocked }). Null when there's
 * no plan yet — the panel just omits the segment.
 *
 * @param {{ total?: number, done?: number, blocked?: number } | null | undefined} summary
 */
export const formatTaskProgress = (summary) => {
  if (!summary || !summary.total) return null;
  const done = summary.done ?? 0;
  const blocked = summary.blocked ?? 0;
  return `${done}/${summary.total} tasks${blocked ? ` · ${blocked} blocked` : ''}`;
};

/**
 * One narrative line for a ralph/* loop event (the shapes
 * peerd-runtime/ralph/loop.js emits via onEvent). Returns null for
 * bookkeeping events (ralph/state) and unknown types so callers can
 * skip them when picking "the last thing worth showing".
 *
 * @param {{ type?: string } & Record<string, any>} ev
 * @returns {string | null}
 */
export const describeRalphEvent = (ev) => {
  if (!ev || typeof ev.type !== 'string') return null;
  switch (ev.type) {
    case 'ralph/started':   return 'run started';
    case 'ralph/resumed':   return `resumed at iteration ${ev.iteration ?? 0}`;
    case 'ralph/iteration':
      return ev.phase === 'planning'
        ? 'planning pass — drafting the task plan'
        : `working on: ${ev.title ?? ev.taskId ?? 'next task'}`;
    case 'ralph/gates':     return ev.pass ? 'gates passed' : 'gates failed';
    case 'ralph/committed': return `committed: ${ev.title ?? ev.taskId ?? 'task'}`;
    case 'ralph/retry':     return `retrying: ${ev.reason ?? 'gate failed'}`;
    case 'ralph/blocked':   return `task blocked: ${ev.reason ?? 'gate failed'}`;
    case 'ralph/refused':   return `refused: ${ev.reason ?? 'not allowed'}`;
    case 'ralph/done':      return 'plan complete';
    case 'ralph/halted':    return 'stopped';
    case 'ralph/error':     return `error: ${ev.error ?? 'unknown'}`;
    default:                return null; // ralph/state etc. — bookkeeping
  }
};

/**
 * The most recent narratable event from the side panel's bounded ralph
 * log (newest last), or null when nothing in the window narrates.
 *
 * @param {Array<object> | null | undefined} log
 */
export const lastRalphNote = (log) => {
  if (!Array.isArray(log)) return null;
  for (let i = log.length - 1; i >= 0; i--) {
    const note = describeRalphEvent(log[i]);
    if (note) return note;
  }
  return null;
};
