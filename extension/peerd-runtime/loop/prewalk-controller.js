// @ts-check
// peerd-runtime/loop/prewalk-controller — the imperative shell around the pure
// prewalk policy (prewalk.js). Owns the four lifecycle side effects (arm a
// run, flip planning→executing when the gate fires, apply the model swap at a
// turn boundary, restore the planner at run end) as a factory with every IO
// INJECTED, so the whole lifecycle is Bun-testable with fakes — the seam the
// original inline-in-the-SW version left uncovered (and where a real bug hid:
// stale-cleanup gated behind the enabled flag; the arm/restore clobber race).
//
// Design (post-review):
//   - The SESSION RECORD is the single source of truth (session.prewalk).
//     There is NO parallel in-memory Set — the old one could desync from the
//     record (leak entries, miss swaps after an SW restart). The swap gate
//     instead keys on `goalRunner.isActive(sid)`, the authoritative in-memory
//     run signal a swap can only ever matter under.
//   - "Is the run gone?" is `!isActive && !isPersisted`: isActive is the live
//     map; isPersisted is the durable goal-runs mirror (survives an SW restart
//     and a vault-lock PAUSE). Consulting both means a not-yet-resumed or
//     paused run is NEVER mistaken for a dead one and wrongly restored
//     mid-run.
//   - restore() is a no-op while a run isActive for the session, so a
//     superseding run's fresh arm can't be clobbered by the previous run's
//     fire-and-forget run-end restore.
//   - arm() ALWAYS clears stale state first (a crashed run's leftovers),
//     THEN gates the re-arm on the setting — so a disabled setting can never
//     leave a prior run's executor state stranded on the record.

import { armPrewalk, shouldPrewalkSwap, markPrewalkSwapped, resolvePrewalkExecutor } from './prewalk.js';

/**
 * @typedef {Object} PrewalkControllerDeps
 * @property {{ get: (id: string) => Promise<any>, setPrewalk: (id: string, state: any, modelPatch?: any) => Promise<any>, update: (id: string, patch: any) => Promise<any> }} sessions
 * @property {{ isActive: (id: string) => boolean, isPersisted?: (id: string) => Promise<boolean> }} goalRunner
 *   isActive — the live in-memory run map. isPersisted — the durable mirror
 *   (optional; absent → treated as false, i.e. in-memory only).
 * @property {{ get: () => { prewalkEnabled?: boolean, prewalkExecutorModel?: string } }} settings
 * @property {() => Array<{ name?: string, defaultRunnerModel?: string }>} listProviders
 * @property {(name: string) => ({ sideEffect?: string } | undefined)} getTool
 * @property {(entry: { type: string, sessionId?: string, details?: object }) => unknown} [appendAudit]
 * @property {(text: string) => void} [postChatNote]
 * @property {() => number} [now]
 */

/** @param {PrewalkControllerDeps} deps */
export const makePrewalkController = ({
  sessions, goalRunner, settings, listProviders, getTool,
  appendAudit = () => {}, postChatNote = () => {}, now = () => 0,
}) => {
  const audit = (/** @type {string} */ type, /** @type {string} */ sessionId, /** @type {object} */ details) => {
    try { Promise.resolve(appendAudit({ type, sessionId, details })).catch(() => {}); } catch { /* audit is best-effort */ }
  };

  /** Is a run for this session alive OR persisted (mid-restart / paused)? */
  const runOwnsSession = async (/** @type {string} */ sid) => {
    if (goalRunner?.isActive?.(sid)) return true;
    try { return !!(await goalRunner?.isPersisted?.(sid)); } catch { return false; }
  };

  /**
   * Arm a fresh goal run (called by startGoalRun, before driving). ALWAYS
   * clears any stale state first (restoring the planner model), then re-arms
   * only when the setting is on and a distinct executor resolves.
   * @param {string} sessionId
   */
  const armForRun = async (sessionId) => {
    try {
      if (!sessionId) return;
      let session = await sessions.get(sessionId);
      if (!session) return;
      // Stale cleanup is UNCONDITIONAL — a crashed prior run must not strand
      // executor state on the record just because prewalk is now off.
      if (session.prewalk) {
        session = await sessions.setPrewalk(sessionId, null, {
          provider: session.prewalk.plannerProvider, model: session.prewalk.plannerModel,
        });
        if (!session) return;
      }
      if (!settings.get().prewalkEnabled) return;
      const provider = listProviders().find((p) => p.name === session.provider);
      const executor = resolvePrewalkExecutor({ settings: settings.get(), provider });
      const armed = armPrewalk(session, executor, now());
      if (!armed) return;
      await sessions.setPrewalk(sessionId, armed);
      audit('prewalk_armed', sessionId, { executorProvider: armed.executorProvider, executorModel: armed.executorModel });
    } catch (e) {
      console.warn('[prewalk] arm failed', e);
    }
  };

  /**
   * Turn-boundary reconcile (turn-driver, main sessions only): restore a truly
   * dead run's planner, or apply the pending executor swap. Returns the
   * (possibly updated) session record the turn should run on.
   * @param {any} session
   */
  const reconcile = async (session) => {
    const pw = session?.prewalk;
    if (!pw) return session;
    const sid = session.sessionId;
    // Only restore when NO run owns the session — never when it's merely
    // not-yet-resumed after a restart or vault-lock-paused (isPersisted true).
    if (!(await runOwnsSession(sid))) {
      const restored = await sessions.setPrewalk(sid, null, { provider: pw.plannerProvider, model: pw.plannerModel });
      audit('prewalk_restored', sid, { reason: 'stale', plannerModel: pw.plannerModel });
      return restored;
    }
    if (pw.phase === 'executing'
        && (session.provider !== pw.executorProvider || session.model !== pw.executorModel)) {
      const swapped = await sessions.update(sid, { provider: pw.executorProvider, model: pw.executorModel });
      audit('prewalk_swap_applied', sid, { executorProvider: pw.executorProvider, executorModel: pw.executorModel });
      try { postChatNote(`Prewalk: plan landed — continuing on ${pw.executorModel}.`); } catch { /* UI-only */ }
      return swapped;
    }
    return session;
  };

  /**
   * Per-tool-call swap gate (turn-driver toolDispatch): a successful mutating
   * call during the planning phase, with a committed plan, flips the phase.
   * Gated on isActive — a swap only matters inside a live run, and that gate
   * needs no parallel bookkeeping to stay consistent with the run lifecycle.
   * The model swap itself lands at the next reconcile (turn boundary).
   * @param {{ sessionId?: string|null, name?: string, ok?: boolean }} arg
   */
  const maybeSwap = async ({ sessionId, name, ok }) => {
    if (!sessionId || ok !== true || !goalRunner?.isActive?.(sessionId)) return;
    const session = await sessions.get(sessionId);
    const pw = session?.prewalk;
    if (!shouldPrewalkSwap({
      prewalk: pw,
      todosCount: session?.todos?.length ?? 0,
      toolName: String(name ?? ''),
      sideEffect: getTool(String(name ?? ''))?.sideEffect,
      ok: true,
    })) return;
    await sessions.setPrewalk(sessionId, markPrewalkSwapped(pw, now()));
    audit('prewalk_swapped', sessionId, { trigger: name, executorProvider: pw.executorProvider, executorModel: pw.executorModel });
  };

  /**
   * Run-end restore. A NO-OP while a run isActive for the session, so a
   * superseding run's fresh arm is never clobbered by the ended run's
   * fire-and-forget restore. Any missed restore self-heals at the next
   * reconcile (which sees no run owns the session).
   * @param {string} sessionId
   */
  const restoreForRun = async (sessionId) => {
    try {
      if (!sessionId || goalRunner?.isActive?.(sessionId)) return;
      const session = await sessions.get(sessionId);
      const pw = session?.prewalk;
      if (!pw) return;
      await sessions.setPrewalk(sessionId, null, { provider: pw.plannerProvider, model: pw.plannerModel });
      audit('prewalk_restored', sessionId, { reason: 'run-end', plannerModel: pw.plannerModel, swapped: !!pw.swappedAt });
    } catch (e) {
      console.warn('[prewalk] restore failed', e);
    }
  };

  return { armForRun, reconcile, maybeSwap, restoreForRun };
};
