// @ts-check
// why: each child returns through an idle parent turn. Keep results until
// storage acknowledges delivery. The rate cap stops repeated child creation.

/**
 * @param {Object} deps
 * @param {(req: object) => Promise<{ result?: string, sessionId?: string|null, exceeded?: boolean, refused?: boolean, timedOut?: boolean, stopped?: boolean, executionFailed?: boolean, outcomeKnown?: boolean }>} deps.spawnActor
 * @param {{ runWhenIdle: (sessionId: string, fn: () => void) => void, runWhenIdleClaimed?: (sessionId: string, fn: (lease: { controller: AbortController, release: () => void }) => void) => void, generation?: (sessionId: string) => number, isBusy: (sessionId: string) => boolean, stop?: (sessionId: string) => boolean }} deps.turnSlots
 * @param {(sessionId: string) => string[]} [deps.stopSubtree]
 * @param {(opts: { userText: string, sessionId: string, synthetic: boolean, actorReply?: { kind: string, instanceId: string, failed: boolean, actorDeliveryId?: string, outcomeKnown?: boolean, parentToolUseId?: string, parentToolUseIds?: string[], correlationComplete?: boolean }, turnLease?: { controller: AbortController, release: () => void } }) => Promise<unknown>} deps.reenter
 * @param {() => Promise<string|null>} deps.getActiveSessionId
 * @param {() => boolean} deps.isVaultLocked
 * @param {(opts: { origin: string, tool: string, body: string, retrievedAt?: string }) => string} deps.wrapUntrusted
 * @param {(ev: object) => void} deps.forwardEvent  live event forwarder (side panel)
 * @param {(count: number) => void} deps.notify     generic, content-free notification
 * @param {(parentSessionId: string) => void} [deps.onTasksChanged]
 * @param {() => number} [deps.now]
 * @param {(fn: () => void, delayMs: number) => unknown} [deps.schedule]
 * @param {{ outstanding?: number, lifetime?: number, resultChars?: number, ringLines?: number, rateCap?: number, rateWindowMs?: number, retryMs?: number }} [deps.caps]
 * @param {(...args: unknown[]) => void} [deps.log]  injected logger (console in the SW, silent in tests)
 */
export const makeAsyncActors = (deps) => {
  const {
    spawnActor, turnSlots, reenter, getActiveSessionId, isVaultLocked,
    wrapUntrusted, forwardEvent, notify, stopSubtree, now = Date.now, caps = {},
    schedule = (fn, delayMs) => setTimeout(fn, delayMs),
    onTasksChanged = () => {},
    log = () => {},
  } = deps;
  const OUTSTANDING_CAP = caps.outstanding ?? 4;
  // why: a time window permits long chats while it limits rapid child creation.
  const RATE_CAP = caps.rateCap ?? 8;
  const RATE_WINDOW_MS = caps.rateWindowMs ?? 60_000;
  const RESULT_CHARS = caps.resultChars ?? 16 * 1024;
  const RING_LINES = caps.ringLines ?? 12;

  /**
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
   * @property {string[] | null} visibleTools  semantic labels shown while the child runs
   * @property {string[]} ring
   * @property {string | null} parentToolUseId the actor_create call that launched it
   * @property {number} parentStopGeneration  Stop epoch captured at launch
   */

  /** @type {Map<string, Map<string, ChildEntry>>} parentSessionId -> Map<taskId, entry>. In-memory: in-session durability only. */
  const children = new Map();
  /** @type {Map<string, { id: string, generation: number, children: ChildEntry[], busy: boolean, envelope: Parameters<typeof reenter>[0] }>} */
  const deliveries = new Map();
  /** @type {Map<string, number[]>} parentSessionId -> recent spawn timestamps (the rate-based runaway guard). */
  const recentSpawns = new Map();
  let seq = 0;

  /** @param {string} parentSessionId */
  const kidsOf = (parentSessionId) => {
    let m = children.get(parentSessionId);
    if (!m) { m = new Map(); children.set(parentSessionId, m); }
    return m;
  };

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
      visibleTools: c.visibleTools,
    }));
  };

  // why: cancellation must stop child work and prevent its later reply.
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

  // why: freeze the batch so a retry cannot give new results an old ID.
  /**
   * @param {string} parentSessionId
   * @param {{ controller: AbortController, release: () => void } | undefined} [turnLease]
   */
  const drainReintegration = async (parentSessionId, turnLease = undefined) => {
    const kids = children.get(parentSessionId);
    if (!kids) return;
    const parentStopGeneration = turnSlots.generation?.(parentSessionId) ?? 0;
    let batch = deliveries.get(parentSessionId);
    if (batch && batch.generation !== parentStopGeneration) {
      for (const child of batch.children) child.status = 'cancelled';
      deliveries.delete(parentSessionId);
      batch = undefined;
      onTasksChanged(parentSessionId);
    }
    const waiting = [...kids.values()].filter((c) => c.status === 'done');
    const stale = waiting.filter((c) => c.parentStopGeneration !== parentStopGeneration);
    for (const child of stale) child.status = 'cancelled';
    const finished = waiting.filter((c) => c.parentStopGeneration === parentStopGeneration);
    if (stale.length > 0) onTasksChanged(parentSessionId);
    if (!batch && finished.length === 0) return;

    // why: retain results while the vault blocks model access.
    if (isVaultLocked()) { notify(batch?.children.length ?? finished.length); return; }
    if (batch?.busy) return;
    if (!batch) {
      const blocks = finished.map((c) => {
        let body = c.result || '(actor returned no text)';
        if (body.length > RESULT_CHARS) {
          body = `${body.slice(0, RESULT_CHARS)}\n…[truncated - open the actor card in the side panel for the full transcript]`;
        }
        // why: child output can contain page data. The fence needs an ISO timestamp.
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
        ? hasUnknownOutcome
          ? 'An actor you started earlier stopped after execution began. Its outcome is unknown. Do not retry automatically. Here is the failure:'
          : hasKnownFailure
            ? 'An actor you started earlier failed before target work ran. Here is the failure:'
          : 'An actor you started earlier has finished. Here is its result:'
        : hasUnknownOutcome
          ? `${finished.length} spawned actors completed or failed. Review each result and do not automatically retry an unknown outcome:`
          : hasKnownFailure
            ? `${finished.length} spawned actors completed or failed before target work ran. Review each result:`
          : `${finished.length} actors you started earlier have finished. Here are their results:`;
      const wakeText = `${lead}\n\n${blocks.join('\n\n')}`;

      const parentToolUseIds = [...new Set(finished.flatMap((child) =>
        typeof child.parentToolUseId === 'string' && child.parentToolUseId
          ? [child.parentToolUseId]
          : []))];
      const correlationComplete = finished.every((child) =>
        typeof child.parentToolUseId === 'string' && child.parentToolUseId.length > 0);

      // why: notification storage must not delay the claimed parent turn.
      Promise.resolve(getActiveSessionId())
        .then((active) => { if (active !== parentSessionId) notify(finished.length); })
        .catch(() => {});

      const id = crypto.randomUUID();
      batch = { id, generation: parentStopGeneration, children: finished, busy: false, envelope: {
        userText: wakeText, sessionId: parentSessionId, synthetic: true,
        actorReply: {
          kind: 'spawned', instanceId: 'spawned', actorDeliveryId: id,
          failed: hasUnknownOutcome || hasKnownFailure,
          ...(hasUnknownOutcome ? { outcomeKnown: false } : {}),
          ...(parentToolUseIds.length === 1 ? { parentToolUseId: parentToolUseIds[0] } : {}),
          ...(parentToolUseIds.length > 0 ? { parentToolUseIds } : {}),
          ...(correlationComplete ? {} : { correlationComplete: false }),
        },
      } };
      for (const child of finished) child.status = 'delivering';
      deliveries.set(parentSessionId, batch);
    }
    batch.busy = true;
    try { await reenter({ ...batch.envelope, ...(turnLease ? { turnLease } : {}) }); }
    catch { /* why: the durable append decides delivery, not the turn outcome. */ }
    if (deliveries.get(parentSessionId) !== batch) return;
    const pending = batch;
    schedule(() => {
      if (deliveries.get(parentSessionId) !== pending) return;
      pending.busy = false;
      queueReintegration(parentSessionId);
    }, caps.retryMs ?? 1_000);
  };

  // why: claim before setup so a result cannot replace a newer user turn.
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

  const acknowledgeDelivery = (/** @type {string} */ parentSessionId, /** @type {string} */ id) => {
    const batch = deliveries.get(parentSessionId);
    if (batch?.id !== id) return false;
    for (const child of batch.children) child.status = 'delivered';
    deliveries.delete(parentSessionId);
    onTasksChanged(parentSessionId);
    queueReintegration(parentSessionId);
    return true;
  };

  // why: wait for the durable child ID so the returned handle survives reload.
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
      visibleTools: null,
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
        entry.visibleTools = Array.isArray(ev.visibleTools)
          ? ev.visibleTools.filter((tool) => typeof tool === 'string')
          : null;
        // why: Stop can precede allocation of the child ID.
        if (typeof turnSlots.generation === 'function'
          && turnSlots.generation(parentSessionId) !== entry.parentStopGeneration) {
          entry.status = 'cancelled';
        }
        // why: the first task update had no child ID or tool grants.
        onTasksChanged(parentSessionId);
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

    /** @param {Partial<ChildEntry>} patch */
    const settle = (patch) => {
      if (entry.status === 'cancelled') return; // cancelled mid-run → drop, no wake
      // why: a reply must not restart a stopped parent. Timeouts and worker
      // failures still report partial results or unknown outcomes.
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
      if ([...kids.values()].some((c) => c.status === 'done' || c.status === 'delivering')) {
        queueReintegration(parentSessionId);
      }
    }
  };

  return {
    spawnActorAsync, drainReintegration, acknowledgeDelivery, actorTasks, actorCancel, onVaultUnlock,
    // why: delayed results must not wake a runtime after it closes.
    close: () => { children.clear(); deliveries.clear(); recentSpawns.clear(); },
  };
};
