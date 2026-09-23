// @ts-check
// Async spawned actors (DESIGN-11) — non-blocking spawn + push-back reintegration.
//
// Extracted from the service worker so the orchestration is UNIT-TESTABLE
// (functional core, imperative shell): every IO surface is injected, so a Bun
// test can drive the spawn → settle → drain → re-enter flow with mocks and
// reproduce the failure modes the live SW couldn't (the re-spawn runaway).
//
// actor_create's async path: register the child in a per-parent map, fire
// spawnActor FIRE-AND-FORGET, and return a handle immediately. On completion
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
 * @param {(req: object) => Promise<{ result?: string, sessionId?: string|null, exceeded?: boolean, refused?: boolean, timedOut?: boolean, stopped?: boolean, executionFailed?: boolean, outcomeKnown?: boolean }>} deps.spawnActor
 *   The bound child runner (resolves when the child's whole loop finishes).
 * @param {{ runWhenIdle: (sessionId: string, fn: () => void) => void, runWhenIdleClaimed?: (sessionId: string, fn: (lease: { controller: AbortController, release: () => void }) => void) => void, generation?: (sessionId: string) => number, isBusy: (sessionId: string) => boolean, stop?: (sessionId: string) => boolean }} deps.turnSlots
 *   stop (optional — PR #134): abort a child session's live turn slot, so
 *   actor_cancel actually ENDS the child's work instead of only dropping
 *   its result. Absent (older harnesses/tests) → cancel keeps the drop-only
 *   behavior.
 * @param {(sessionId: string) => string[]} [deps.stopSubtree]
 *   Transitively stop a cancelled child's OWN descendants (spawn.js
 *   stopSubtree) — a cancel must end the whole subtree, like Stop does.
 * @param {(opts: { userText: string, sessionId: string, synthetic: boolean, actorReply?: { kind: string, instanceId: string, failed: boolean, outcomeKnown?: boolean, actorDeliveryId?: string, parentToolUseId?: string, parentToolUseIds?: string[], correlationComplete?: boolean }, turnLease?: { controller: AbortController, release: () => void } }) => Promise<unknown>} deps.reenter
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
 * @param {(fn: () => void, delayMs: number) => unknown} [deps.schedule]
 * @param {() => string} [deps.makeDeliveryId]
 * @param {{ outstanding?: number, lifetime?: number, resultChars?: number, ringLines?: number, rateCap?: number, rateWindowMs?: number, retryMs?: number }} [deps.caps]
 * @param {(...args: unknown[]) => void} [deps.log]  injected logger (console in the SW, silent in tests)
 */
export const makeAsyncActors = (deps) => {
  const {
    spawnActor, turnSlots, reenter, getActiveSessionId, isVaultLocked,
    wrapUntrusted, forwardEvent, notify, stopSubtree, now = Date.now, caps = {},
    schedule = (fn, delayMs) => setTimeout(fn, delayMs), makeDeliveryId = () => globalThis.crypto.randomUUID(),
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
   * @property {'running' | 'done' | 'delivering' | 'delivered' | 'cancelled'} status
   * @property {string} result
   * @property {boolean} exceeded
   * @property {boolean} interrupted
   * @property {boolean} timedOut     the child hit its wall-clock budget (PR #134)
   * @property {boolean} stopped      the child's slot was aborted (Stop cascade)
   * @property {boolean} executionFailed the Worker failed after execution began
   * @property {boolean} outcomeKnown false when effects may have landed before failure
   * @property {string | null} childSessionId
   * @property {string[] | null} grantedTools  server-resolved grant set once the child starts
   * @property {string[]} ring
   * @property {string | null} parentToolUseId the actor_create call that launched it
   * @property {number} parentStopGeneration  Stop epoch captured at launch
   */

  /** @type {Map<string, Map<string, ChildEntry>>} parentSessionId -> Map<taskId, entry>. In-memory: in-session durability only. */
  const children = new Map();
  /** @type {Map<string, { id: string, generation: number, children: ChildEntry[], retryScheduled: boolean, envelope: any }>} */
  const deliveryBatches = new Map();
  /** @type {Map<string, number[]>} parentSessionId -> recent spawn timestamps (the rate-based runaway guard). */
  const recentSpawns = new Map();
  let seq = 0;

  /** @param {string} parentSessionId */
  const kidsOf = (parentSessionId) => {
    let m = children.get(parentSessionId);
    if (!m) { m = new Map(); children.set(parentSessionId, m); }
    return m;
  };

  // Snapshot for the actor_tasks peek (non-blocking): status + output tail.
  /** @param {string} parentSessionId */
  const actorTasks = (parentSessionId) => {
    const kids = children.get(parentSessionId);
    if (!kids) return [];
    return [...kids.values()].map((c) => ({
      taskId: c.taskId,
      task: c.task.slice(0, 80),
      status: c.status === 'delivering' ? 'done' : c.status,
      lastOutput: c.ring.join('').slice(-500),
      childSessionId: c.childSessionId,
      grantedTools: c.grantedTools,
    }));
  };

  // Cancel: ABORT the child's live turn (PR #134 — its loop runs under a turn
  // slot now, so cancel actually ends the work, not just the result), stop the
  // result from coming back, and free the cap slot. The aborted loop settles
  // through spawnActor's normal path; a cancelled entry is dropped on settle
  // (no wake). The child's own descendants are stopped too — a cancel ends the
  // whole subtree, exactly like Stop. taskId may arrive undefined (callers read
  // it off a possibly-error spawn handle); Map.get tolerates it and the !entry
  // guard below catches it.
  /** @param {string} parentSessionId @param {string | undefined} taskId */
  const actorCancel = (parentSessionId, taskId) => {
    const entry = children.get(parentSessionId)?.get(taskId ?? '');
    if (!entry) return { ok: false, error: 'no_such_task' };
    if (entry.status !== 'running') return { ok: false, error: `task already ${entry.status}` };
    entry.status = 'cancelled';
    if (entry.childSessionId) {
      stopSubtree?.(entry.childSessionId);
      turnSlots.stop?.(entry.childSessionId);
    }
    onTasksChanged(parentSessionId);
    return { ok: true, content: `actor ${taskId} cancelled — its work is being stopped and its result will not come back` };
  };

  // Freeze each batch until the post-commit hook acknowledges it; retry the same id after failure.
  /**
   * @param {string} parentSessionId
   * @param {{ controller: AbortController, release: () => void } | undefined} [turnLease]
   */
  const drainReintegration = async (parentSessionId, turnLease = undefined) => {
    const kids = children.get(parentSessionId);
    if (!kids) return;
    const parentStopGeneration = turnSlots.generation?.(parentSessionId) ?? 0;
    let batch = deliveryBatches.get(parentSessionId);
    if (batch && batch.generation !== parentStopGeneration) {
      for (const child of batch.children) child.status = 'cancelled';
      deliveryBatches.delete(parentSessionId);
      batch = undefined;
      onTasksChanged(parentSessionId);
    }
    const waiting = [...kids.values()].filter((c) => c.status === 'done');
    const stale = waiting.filter((c) => c.parentStopGeneration !== parentStopGeneration);
    for (const child of stale) child.status = 'cancelled';
    const finished = waiting.filter((c) => c.parentStopGeneration === parentStopGeneration);
    if (stale.length > 0) onTasksChanged(parentSessionId);
    if (!batch && finished.length === 0) return;

    if (isVaultLocked()) { notify(batch?.children.length ?? finished.length); return; }
    if (batch?.retryScheduled) return;
    if (!batch) {
      const blocks = finished.map((c) => {
        let body = c.result || '(actor returned no text)';
        if (body.length > RESULT_CHARS) {
          body = `${body.slice(0, RESULT_CHARS)}\n…[truncated - open the actor card in the side panel for the full transcript]`;
        }
        // why: child output can include page data. Fence it and use the ISO
        // timestamp shape that wrapUntrusted writes verbatim.
        const wrapped = wrapUntrusted({ origin: 'spawned', tool: 'actor_create', body, retrievedAt: new Date(now()).toISOString() });
        const outcomeUnknown = c.executionFailed && c.outcomeKnown === false;
        const flag = outcomeUnknown
          ? ' (execution failed after work began; outcome unknown; do not retry automatically)'
          : c.executionFailed ? ' (failed before target work ran)'
          : c.interrupted ? ' (interrupted before finishing, partial)'
          : c.timedOut ? ' (hit its wall-clock timeout, partial)'
          : c.stopped ? ' (stopped before finishing, partial)'
          : c.exceeded ? ' (hit its step cap, may be incomplete)' : '';
        return `Actor "${c.task.slice(0, 80)}"${flag}:\n${wrapped}`;
      });
      const hasUnknownOutcome = finished.some((entry) => entry.executionFailed && entry.outcomeKnown === false);
      const hasKnownFailure = finished.some((entry) => entry.executionFailed && entry.outcomeKnown !== false);
      const lead = finished.length === 1
        ? (hasUnknownOutcome
          ? 'An actor you started earlier stopped after execution began. Its outcome is unknown. Do not retry automatically. Here is the failure:'
          : hasKnownFailure ? 'An actor you started earlier failed before target work ran. Here is the failure:'
          : 'An actor you started earlier has finished. Here is its result:')
        : (hasUnknownOutcome
          ? `${finished.length} spawned actors completed or failed. Review each result and do not automatically retry an unknown outcome:`
          : hasKnownFailure ? `${finished.length} spawned actors completed or failed before target work ran. Review each result:`
          : `${finished.length} actors you started earlier have finished. Here are their results:`);
      const parentToolUseIds = [...new Set(finished.flatMap((child) => child.parentToolUseId ? [child.parentToolUseId] : []))];
      const correlationComplete = finished.every((child) => !!child.parentToolUseId);
      const id = makeDeliveryId();
      batch = {
        id, generation: parentStopGeneration, children: finished, retryScheduled: false,
        envelope: {
          userText: `${lead}\n\n${blocks.join('\n\n')}`, sessionId: parentSessionId, synthetic: true,
          actorReply: {
            kind: 'spawned', instanceId: 'spawned', actorDeliveryId: id, failed: hasUnknownOutcome || hasKnownFailure,
            ...(hasUnknownOutcome ? { outcomeKnown: false } : {}),
            ...(parentToolUseIds.length === 1 ? { parentToolUseId: parentToolUseIds[0] } : {}),
            ...(parentToolUseIds.length > 0 ? { parentToolUseIds } : {}),
            ...(correlationComplete ? {} : { correlationComplete: false }),
          },
        },
      };
      for (const child of finished) child.status = 'delivering';
      deliveryBatches.set(parentSessionId, batch);
      onTasksChanged(parentSessionId);
      Promise.resolve(getActiveSessionId())
        .then((active) => { if (active !== parentSessionId) notify(finished.length); })
        .catch(() => {});
    }

    try { await reenter({ ...batch.envelope, ...(turnLease ? { turnLease } : {}) }); }
    catch { /* commit acknowledgement, not the turn outcome, decides delivery */ }
    if (deliveryBatches.get(parentSessionId) !== batch) return;
    batch.retryScheduled = true;
    schedule(() => {
      if (deliveryBatches.get(parentSessionId) === batch) {
        batch.retryScheduled = false; queueReintegration(parentSessionId);
      }
    }, caps.retryMs ?? 1_000);
  };

  const queueReintegration = (/** @type {string} */ parentSessionId) => {
    const start = (/** @type {{ controller: AbortController, release: () => void } | undefined} */ turnLease) => {
      Promise.resolve(drainReintegration(parentSessionId, turnLease))
        .catch(() => {})
        .finally(() => turnLease?.release());
    };
    if (typeof turnSlots.runWhenIdleClaimed === 'function') {
      turnSlots.runWhenIdleClaimed(parentSessionId, start);
    } else {
      turnSlots.runWhenIdle(parentSessionId, () => start(undefined));
    }
  };

  const acknowledgeDelivery = (/** @type {string} */ id) => {
    const match = [...deliveryBatches].find(([, candidate]) => candidate.id === id);
    if (!match) return false;
    const [parentSessionId, batch] = match;
    for (const child of batch.children) child.status = 'delivered';
    deliveryBatches.delete(parentSessionId);
    onTasksChanged(parentSessionId);
    if ([...(children.get(parentSessionId)?.values() ?? [])].some((child) => child.status === 'done')) queueReintegration(parentSessionId);
    return true;
  };

  // The non-blocking spawn. Registers the child, waits only for its durable
  // session allocation (not model work), then returns a reload-safe handle;
  // reintegration still happens later on completion.
  /** @param {{ parentSessionId: string, task?: string, [k: string]: unknown }} req */
  const spawnActorAsync = async (req) => {
    const parentSessionId = req.parentSessionId;
    const kids = kidsOf(parentSessionId);
    const outstanding = [...kids.values()].filter((c) => c.status === 'running').length;
    if (outstanding >= OUTSTANDING_CAP) {
      log('REFUSED', { reason: 'outstanding_cap', parentSessionId, outstanding });
      return {
        ok: false,
        error: `async_actor_cap: ${OUTSTANDING_CAP} spawned already running for this chat — await or cancel one, or pass sync:true`,
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
        error: `async_actor_loop_guard: ${recent.length} async spawned spawned in the last ${Math.round(RATE_WINDOW_MS / 1000)}s — refusing to prevent a runaway loop. STOP spawning; synthesize what you have, use sync:true, or wait a moment.`,
      };
    }
    recent.push(nowMs);
    recentSpawns.set(parentSessionId, recent);

    seq += 1;
    const taskId = `as-${seq}`;
    /** @type {ChildEntry} */
    const entry = {
      taskId, task: String(req.task ?? ''), status: 'running', result: '',
      exceeded: false, interrupted: false, timedOut: false, stopped: false,
      executionFailed: false, outcomeKnown: true,
      childSessionId: null, ring: [],
      parentToolUseId: typeof req.parentToolUseId === 'string' ? req.parentToolUseId : null,
      parentStopGeneration: turnSlots.generation?.(parentSessionId) ?? 0,
      grantedTools: null,
    };
    kids.set(taskId, entry);
    onTasksChanged(parentSessionId); // new task → appears on the live bar

    /** @type {(sessionId: string|null) => void} */
    let resolveAllocated;
    const allocated = new Promise((resolve) => { resolveAllocated = resolve; });
    let allocationSettled = false;
    const settleAllocation = (/** @type {string|null} */ sessionId) => {
      if (allocationSettled) return;
      allocationSettled = true;
      resolveAllocated(sessionId);
    };

    /** @param {{ type: string, sessionId?: string, text?: string, [k: string]: unknown }} ev */
    const onEvent = (ev) => {
      if (ev.type === 'actor-start') {
        entry.childSessionId = ev.sessionId ?? null;
        settleAllocation(entry.childSessionId);
        entry.grantedTools = Array.isArray(ev.grantedTools)
          ? ev.grantedTools.filter((tool) => typeof tool === 'string')
          : null;
        // Stop can land after the async entry is created but before spawn.js
        // publishes the minted child id. The parent generation is the only
        // authority available across that allocation gap. Once the id arrives,
        // cancel stale work immediately instead of merely suppressing its later
        // reply while the child continues with tools.
        if (typeof turnSlots.generation === 'function'
          && turnSlots.generation(parentSessionId) !== entry.parentStopGeneration) {
          entry.status = 'cancelled';
        }
        // The first snapshot was pushed before spawnActor had minted the child.
        // Push again now that the stable session id + authoritative grants are
        // known, so a reconnecting Actor Fabric can replace its placeholder.
        onTasksChanged(parentSessionId);
        // A cancel or parent Stop that landed BEFORE this start event could not
        // stop a child whose id it did not yet know. Now that the id has arrived,
        // abort the child and its subtree instead of leaving it on budget.
        if (entry.status === 'cancelled' && entry.childSessionId) {
          stopSubtree?.(entry.childSessionId);
          turnSlots.stop?.(entry.childSessionId);
        }
      }
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
      // A user Stop cascades to the child (routes/sessions.js stopSubtree aborts
      // its slot); the child unwinds and comes back `stopped:true`. Do NOT drain
      // a Stop-aborted child: the parent's OWN turn was just stopped too, so a
      // reintegration wake would re-enter it with a synthetic turn and the model
      // would immediately start a fresh full-tool turn — seconds after the user
      // pressed Stop (the actor-messaging path already guards this via its
      // stop-generation skip; the spawn path needs the same guard). Drop it like
      // a cancel: mark terminal, surface on the bar, no wake. A TIMEOUT is
      // different — the parent is still working and wants the partial — so
      // timedOut still drains. (A goal/auto continuation isn't a user Stop; those
      // don't cascade stopSubtree, so they never reach here as `stopped`.) A
      // post-start Worker failure also carries stopped:true, but must drain its
      // unknown-outcome warning instead of disappearing like a user cancel.
      if (patch.stopped === true && patch.executionFailed !== true) {
        Object.assign(entry, patch, { status: 'cancelled' });
        onTasksChanged(parentSessionId);
        return;
      }
      Object.assign(entry, patch, { status: 'done' });
      onTasksChanged(parentSessionId); // running → done (still on the bar until delivered)
      queueReintegration(parentSessionId);
    };
    Promise.resolve().then(() => spawnActor({ ...req, onEvent }))
      .then((out) => {
        settleAllocation(out.sessionId ?? entry.childSessionId);
        settle({
          result: out.refused ? out.result : (out.result ?? ''),
          exceeded: out.exceeded === true || out.refused === true,
          timedOut: out.timedOut === true,
          stopped: out.stopped === true,
          executionFailed: out.executionFailed === true,
          outcomeKnown: out.outcomeKnown !== false,
          childSessionId: out.sessionId ?? entry.childSessionId,
        });
      })
      .catch((e) => {
        settleAllocation(entry.childSessionId);
        const failure = /** @type {{ message?: string, executionFailed?: boolean, outcomeKnown?: boolean }} */ (e);
        if (failure.outcomeKnown === false) {
          settle({
            result: failure.message ?? 'actor transcript persistence failed',
            executionFailed: true,
            outcomeKnown: false,
          });
          return;
        }
        settle({ result: `actor errored: ${failure.message ?? String(e)}`, interrupted: true });
      });

    const childSessionId = await allocated;
    return {
      ok: true,
      taskId,
      content: childSessionId
        ? `actor ${taskId} started (session ${childSessionId}, async). Its result will arrive on a later turn. Do NOT wait or poll; continue or end your turn.`
        : `actor ${taskId} started (async). Its result will arrive on a later turn. Do NOT wait or poll; continue or end your turn.`,
    };
  };

  const onVaultUnlock = () => {
    for (const [parentSessionId, kids] of children) {
      if ([...kids.values()].some((c) => c.status === 'done' || c.status === 'delivering')) queueReintegration(parentSessionId);
    }
  };

  return { spawnActorAsync, drainReintegration, acknowledgeDelivery, actorTasks, actorCancel, onVaultUnlock };
};
