// @ts-check
// Async subagents (DESIGN-11) — non-blocking spawn + push-back reintegration.
//
// Extracted from the service worker so the orchestration is UNIT-TESTABLE
// (functional core, imperative shell): every IO surface is injected, so a Bun
// test can drive the spawn → settle → drain → re-enter flow with mocks and
// reproduce the failure modes the live SW couldn't (the re-spawn runaway).
//
// spawn_subagent's async path: register the child in a per-parent map, fire
// spawnSubagent FIRE-AND-FORGET, and return a handle immediately. On completion
// the child's result re-enters the PARENT session as ONE coalesced synthetic
// wake turn, pushed via turnSlots.runWhenIdle so it never aborts the parent's
// live turn (DECISIONS #20). In-session only; a child lost to SW death is
// reported `interrupted` on the next drain.
//
// RUNAWAY GUARD (the live bug): a wake turn can make the model re-spawn, whose
// child wakes again → unbounded loop (it opened/closed research tabs until the
// browser had to be force-quit). Two bounds stop it: a per-parent OUTSTANDING
// cap (concurrency) and a per-parent LIFETIME cap (total spawns ever) — past
// the lifetime cap the spawn is refused with a clear "stop, likely a loop"
// message, so the model can't keep the cycle going.

/**
 * @param {Object} deps
 * @param {(req: object) => Promise<{ result?: string, sessionId?: string|null, exceeded?: boolean, refused?: boolean }>} deps.spawnSubagent
 *   The bound child runner (resolves when the child's whole loop finishes).
 * @param {{ runWhenIdle: (sessionId: string, fn: () => void) => void, isBusy: (sessionId: string) => boolean }} deps.turnSlots
 * @param {(opts: { userText: string, sessionId: string, synthetic: boolean }) => Promise<unknown>} deps.reenter
 *   Re-enter a session with a (synthetic) turn — the SW's runAgentTurn.
 * @param {() => Promise<string|null>} deps.getActiveSessionId
 * @param {() => boolean} deps.isVaultLocked
 * @param {(opts: { origin: string, tool: string, body: string, retrievedAt?: string }) => string} deps.wrapUntrusted
 * @param {(ev: object) => void} deps.forwardEvent  live event forwarder (side panel)
 * @param {(count: number) => void} deps.notify     generic, content-free notification
 * @param {(parentSessionId: string) => void} [deps.onTasksChanged]
 *   Fired on every task status transition (spawn/settle/cancel/deliver) so a UI
 *   can mirror the live task list. No-op by default (tests omit it).
 * @param {() => number} [deps.now]
 * @param {{ outstanding?: number, lifetime?: number, resultChars?: number, ringLines?: number, rateCap?: number, rateWindowMs?: number }} [deps.caps]
 * @param {(...args: unknown[]) => void} [deps.log]  injected logger (console in the SW, silent in tests)
 */
export const makeAsyncSubagents = (deps) => {
  const {
    spawnSubagent, turnSlots, reenter, getActiveSessionId, isVaultLocked,
    wrapUntrusted, forwardEvent, notify, now = Date.now, caps = {},
    // Mirror the live task list to a UI on each status transition. No-op in
    // tests / headless contexts that don't render it.
    onTasksChanged = () => {},
    // Injected hook (console in the SW, silent in tests). Only the runaway
    // guard (REFUSED) logs now — a rare, worth-seeing event.
    log = () => {},
  } = deps;
  const OUTSTANDING_CAP = caps.outstanding ?? 4;
  // Runaway guard: a re-spawn loop fires in a tight burst, so cap spawns per
  // WINDOW (not per session-lifetime — that would penalise a long, legit chat
  // that spawns many over time). Past RATE_CAP within RATE_WINDOW_MS → refuse.
  const RATE_CAP = caps.rateCap ?? 8;
  const RATE_WINDOW_MS = caps.rateWindowMs ?? 60_000;
  const RESULT_CHARS = caps.resultChars ?? 16 * 1024;
  const RING_LINES = caps.ringLines ?? 12;

  /**
   * One tracked async child. Mutated in place across spawn → settle → deliver.
   * @typedef {Object} ChildEntry
   * @property {string} taskId
   * @property {string} task
   * @property {'running' | 'done' | 'cancelled'} status
   * @property {string} result
   * @property {boolean} exceeded
   * @property {boolean} interrupted
   * @property {string | null} childSessionId
   * @property {boolean} reintegrated
   * @property {string[]} ring
   */

  /** @type {Map<string, Map<string, ChildEntry>>} parentSessionId -> Map<taskId, entry>. In-memory: in-session durability only. */
  const children = new Map();
  /** @type {Map<string, number[]>} parentSessionId -> recent spawn timestamps (the rate-based runaway guard). */
  const recentSpawns = new Map();
  let seq = 0;

  /** @param {string} parentSessionId */
  const kidsOf = (parentSessionId) => {
    let m = children.get(parentSessionId);
    if (!m) { m = new Map(); children.set(parentSessionId, m); }
    return m;
  };

  // Snapshot for the subagent_tasks peek (non-blocking): status + output tail.
  /** @param {string} parentSessionId */
  const subagentTasks = (parentSessionId) => {
    const kids = children.get(parentSessionId);
    if (!kids) return [];
    return [...kids.values()].map((c) => ({
      taskId: c.taskId,
      task: c.task.slice(0, 80),
      status: c.reintegrated ? 'delivered' : c.status,
      lastOutput: c.ring.join('').slice(-500),
    }));
  };

  // Cancel: stop the result from coming back and free the cap slot. The child
  // loop settles on its own; a cancelled entry is dropped on settle (no wake).
  // taskId may arrive undefined (callers read it off a possibly-error spawn
  // handle); Map.get tolerates it and the !entry guard below catches it.
  /** @param {string} parentSessionId @param {string | undefined} taskId */
  const subagentCancel = (parentSessionId, taskId) => {
    const entry = children.get(parentSessionId)?.get(taskId ?? '');
    if (!entry) return { ok: false, error: 'no_such_task' };
    if (entry.status !== 'running') return { ok: false, error: `task already ${entry.reintegrated ? 'delivered' : entry.status}` };
    entry.status = 'cancelled';
    onTasksChanged(parentSessionId);
    return { ok: true, content: `subagent ${taskId} cancelled — its result will not come back` };
  };

  // Coalesce all of a parent's finished-but-unreintegrated children into ONE
  // synthetic wake turn. Idempotent (flips `reintegrated` before re-entry) and
  // vault-aware (defers while locked, re-drains on unlock).
  /** @param {string} parentSessionId */
  const drainReintegration = async (parentSessionId) => {
    const kids = children.get(parentSessionId);
    if (!kids) return;
    const finished = [...kids.values()].filter((c) => c.status === 'done' && !c.reintegrated);
    if (finished.length === 0) return;

    // Vault-locked: the model key is gated — cannot run the wake turn. Hold the
    // results, notify generically, re-drain on unlock (onVaultUnlock).
    if (isVaultLocked()) { notify(finished.length); return; }

    // Idempotency: flip BEFORE re-entry so a redelivered drain is a no-op.
    finished.forEach((c) => { c.reintegrated = true; });
    onTasksChanged(parentSessionId); // delivered → drop off the live bar

    const blocks = finished.map((c) => {
      let body = c.result || '(subagent returned no text)';
      if (body.length > RESULT_CHARS) {
        body = `${body.slice(0, RESULT_CHARS)}\n…[truncated — open the subagent card in the side panel for the full transcript]`;
      }
      // why UNTRUSTED: the child's result is model-authored from a fresh context
      // over possibly page-derived bytes. Only the one-line framing is trusted.
      // why toISOString: wrapUntrusted stamps retrieved_at="…" verbatim and
      // expects an ISO string; passing the raw epoch from now() (a number) put
      // a bare millisecond count in the wrapper. Keep the injected `now` for
      // determinism, formatted correctly.
      const wrapped = wrapUntrusted({ origin: 'subagent', tool: 'spawn_subagent', body, retrievedAt: new Date(now()).toISOString() });
      const flag = c.interrupted ? ' (interrupted before finishing — partial)'
        : c.exceeded ? ' (hit its step cap — may be incomplete)' : '';
      return `Subagent "${c.task.slice(0, 80)}"${flag}:\n${wrapped}`;
    });
    const lead = finished.length === 1
      ? 'A subagent you started earlier has finished. Here is its result:'
      : `${finished.length} subagents you started earlier have finished. Here are their results:`;
    const wakeText = `${lead}\n\n${blocks.join('\n\n')}`;

    // Passive surfacing if the parent is NOT the user's active chat (#20).
    const active = await getActiveSessionId();
    if (active !== parentSessionId) notify(finished.length);

    // runWhenIdle guaranteed the slot is free, so this re-entry aborts nothing.
    await reenter({ userText: wakeText, sessionId: parentSessionId, synthetic: true });
  };

  // The non-blocking spawn. Registers the child, fires it fire-and-forget, and
  // returns a handle immediately; reintegration happens on completion.
  /** @param {{ parentSessionId: string, task?: string, [k: string]: unknown }} req */
  const spawnSubagentAsync = async (req) => {
    const parentSessionId = req.parentSessionId;
    const kids = kidsOf(parentSessionId);
    const outstanding = [...kids.values()].filter((c) => c.status === 'running').length;
    if (outstanding >= OUTSTANDING_CAP) {
      log('REFUSED', { reason: 'outstanding_cap', parentSessionId, outstanding });
      return {
        ok: false,
        error: `async_subagent_cap: ${OUTSTANDING_CAP} subagents already running for this chat — await or cancel one, or pass sync:true`,
      };
    }
    // Circuit breaker: refuse if too many spawns landed within the window — a
    // re-spawn loop bursts, a legit session spreads out (so it isn't penalised).
    const nowMs = now();
    const recent = (recentSpawns.get(parentSessionId) ?? []).filter((t) => nowMs - t < RATE_WINDOW_MS);
    if (recent.length >= RATE_CAP) {
      log('REFUSED', { reason: 'rate_cap (runaway guard)', parentSessionId, recent: recent.length });
      return {
        ok: false,
        error: `async_subagent_loop_guard: ${recent.length} async subagents spawned in the last ${Math.round(RATE_WINDOW_MS / 1000)}s — refusing to prevent a runaway loop. STOP spawning; synthesize what you have, use sync:true, or wait a moment.`,
      };
    }
    recent.push(nowMs);
    recentSpawns.set(parentSessionId, recent);

    seq += 1;
    const taskId = `as-${seq}`;
    /** @type {ChildEntry} */
    const entry = {
      taskId, task: String(req.task ?? ''), status: 'running', result: '',
      exceeded: false, interrupted: false, childSessionId: null, reintegrated: false, ring: [],
    };
    kids.set(taskId, entry);
    onTasksChanged(parentSessionId); // new task → appears on the live bar

    /** @param {{ type: string, sessionId?: string, text?: string, [k: string]: unknown }} ev */
    const onEvent = (ev) => {
      if (ev.type === 'subagent-start') entry.childSessionId = ev.sessionId ?? null;
      if (ev.type === 'delta' && typeof ev.text === 'string' && ev.text) {
        entry.ring.push(ev.text);
        while (entry.ring.length > RING_LINES) entry.ring.shift();
      }
      forwardEvent(ev);
    };

    // Fire-and-forget — NOT awaited. The parent's tool call returns the handle
    // below; the child keeps running. On settle, queue a drain.
    /** @param {Partial<ChildEntry>} patch */
    const settle = (patch) => {
      if (entry.status === 'cancelled') return; // cancelled mid-run → drop, no wake
      Object.assign(entry, patch, { status: 'done' });
      onTasksChanged(parentSessionId); // running → done (still on the bar until delivered)
      turnSlots.runWhenIdle(parentSessionId, () => {
        Promise.resolve(drainReintegration(parentSessionId)).catch(() => {});
      });
    };
    Promise.resolve(spawnSubagent({ ...req, onEvent }))
      .then((out) => settle({
        result: out.refused ? out.result : (out.result ?? ''),
        exceeded: out.exceeded === true || out.refused === true,
        childSessionId: out.sessionId ?? entry.childSessionId,
      }))
      .catch((e) => settle({ result: `subagent errored: ${/** @type {{ message?: string }} */ (e)?.message ?? String(e)}`, interrupted: true }));

    return {
      ok: true,
      taskId,
      content: `subagent ${taskId} started (async) — its result will arrive on a later turn. Do NOT wait or poll; continue or end your turn.`,
    };
  };

  // On vault unlock, re-drain any parent with finished-but-undelivered children.
  const onVaultUnlock = () => {
    for (const [parentSessionId, kids] of children) {
      if ([...kids.values()].some((c) => c.status === 'done' && !c.reintegrated)) {
        turnSlots.runWhenIdle(parentSessionId, () => {
          Promise.resolve(drainReintegration(parentSessionId)).catch(() => {});
        });
      }
    }
  };

  return { spawnSubagentAsync, drainReintegration, subagentTasks, subagentCancel, onVaultUnlock };
};
