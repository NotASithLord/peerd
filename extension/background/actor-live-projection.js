// @ts-check
// SW-owned live actor projection. It survives UI disconnects within one service
// worker lifetime and emits root-scoped snapshots for newly connected surfaces.

/** @param {string} rootSessionId @param {string} parentToolUseId */
const boundKey = (rootSessionId, parentToolUseId) => `${rootSessionId}:${parentToolUseId}`;

export const createActorLiveProjection = () => {
  /** @type {Map<string, any>} */
  const spawned = new Map();
  /** @type {Map<string, any>} */
  const bound = new Map();
  /** @type {Map<string, any[]>} */
  const asyncTasks = new Map();

  const pruneSettledSpawned = () => {
    let pruned = true;
    while (pruned) {
      pruned = false;
      for (const [sessionId, session] of spawned) {
        if (session.running !== false) continue;
        // A child can be allocated to an async task before its actor-start
        // snapshot hydrates. Keep the settled parent as a lineage anchor while
        // that server-owned task is still running or awaiting delivery.
        const hasPendingTask = (asyncTasks.get(sessionId) ?? [])
          .some((task) => task?.status === 'running' || task?.status === 'done');
        if (hasPendingTask) continue;
        const hasDescendant = [...spawned.values()]
          .some((candidate) => candidate.parentSessionId === sessionId);
        if (hasDescendant) continue;
        spawned.delete(sessionId);
        pruned = true;
      }
    }
  };

  /** @param {any} card */
  const startBound = (card) => {
    if (!card?.rootSessionId || !card?.parentToolUseId) return false;
    bound.set(boundKey(card.rootSessionId, card.parentToolUseId), { ...card });
    return true;
  };

  /** @param {any} display @param {Record<string, any>} patch */
  const patchBound = (display, patch) => {
    if (!display?.rootSessionId || !display?.parentToolUseId) return false;
    const key = boundKey(display.rootSessionId, display.parentToolUseId);
    const current = bound.get(key);
    if (!current) return false;
    bound.set(key, { ...current, ...patch });
    return true;
  };

  /** @param {any} display */
  const finishBound = (display) => {
    if (!display?.rootSessionId || !display?.parentToolUseId) return false;
    return bound.delete(boundKey(display.rootSessionId, display.parentToolUseId));
  };

  /**
   * Fold a spawn lifecycle event and return its canonical UI message.
   * Non-topology events return null; their caller may still stream them.
   * @param {any} event
   * @returns {any|null}
   */
  const foldSpawned = (event) => {
    if (event?.type === 'actor-start') {
      const session = {
        sessionId: event.sessionId, kind: 'spawned', depth: event.depth,
        task: event.task, parentSessionId: event.parentSessionId,
        rootSessionId: event.rootSessionId, parentToolUseId: event.parentToolUseId,
        grantedTools: Array.isArray(event.grantedTools) ? event.grantedTools : [],
        running: true, messages: [],
      };
      spawned.set(event.sessionId, session);
      return {
        type: 'turn/spawned-start', parentToolUseId: event.parentToolUseId,
        parentSessionId: event.parentSessionId, sessionId: event.sessionId,
        rootSessionId: event.rootSessionId, depth: event.depth, task: event.task,
        grantedTools: session.grantedTools,
      };
    }
    if (event?.type === 'actor-stop') {
      const live = spawned.get(event.sessionId);
      const message = {
        type: 'turn/spawned-done', parentToolUseId: event.parentToolUseId,
        sessionId: event.sessionId, rootSessionId: live?.rootSessionId ?? event.rootSessionId,
        depth: event.depth,
      };
      if (live) spawned.set(event.sessionId, { ...live, running: false });
      pruneSettledSpawned();
      return message;
    }
    if (event?.type === 'state') {
      const live = spawned.get(event.session?.sessionId);
      if (live) spawned.set(event.session.sessionId, { ...live, ...event.session, running: true });
      return { type: 'turn/spawned-state', rootSessionId: live?.rootSessionId, session: event.session };
    }
    return null;
  };

  /** @param {string} sessionId */
  const rootForSpawned = (sessionId) => spawned.get(sessionId)?.rootSessionId;

  /** @param {string} parentSessionId @param {any[]} tasks */
  const setAsyncTasks = (parentSessionId, tasks) => {
    const active = (Array.isArray(tasks) ? tasks : [])
      .filter((task) => task?.status === 'running' || task?.status === 'done');
    if (active.length > 0) asyncTasks.set(parentSessionId, active);
    else asyncTasks.delete(parentSessionId);
    pruneSettledSpawned();
  };

  /** @param {string | null | undefined} rootSessionId */
  const snapshot = (rootSessionId) => {
    if (!rootSessionId) {
      return { actors: {}, spawned: { byToolUse: {}, sessions: {} }, asyncTasks: {} };
    }
    const liveSpawned = [...spawned.values()]
      .filter((session) => session.rootSessionId === rootSessionId);
    const spawnedSessions = Object.fromEntries(liveSpawned
      .map((session) => [session.sessionId, { ...session }]));
    return {
      actors: Object.fromEntries([...bound.values()]
        .filter((card) => card.rootSessionId === rootSessionId)
        .map((card) => [card.parentToolUseId, { ...card }])),
      spawned: {
        byToolUse: Object.fromEntries(liveSpawned
          .filter((session) => session.parentToolUseId)
          .map((session) => [session.parentToolUseId, session.sessionId])),
        sessions: spawnedSessions,
      },
      asyncTasks: Object.fromEntries([...asyncTasks.entries()]
        .filter(([parentSessionId]) => parentSessionId === rootSessionId
          || Object.hasOwn(spawnedSessions, parentSessionId))
        .map(([parentSessionId, tasks]) => [parentSessionId, tasks])),
    };
  };

  // The chat snapshot above is intentionally root-scoped. The full-page home
  // needs a separate discovery seam so it can ask which roots currently own
  // work WITHOUT receiving transcripts from unrelated sessions. Only roots
  // with server-observed topology are enumerated; session titles/status are
  // joined by the read-only route that owns access to the session store.
  const rootSessionIds = () => {
    const roots = new Set();
    for (const card of bound.values()) {
      if (typeof card?.rootSessionId === 'string' && card.rootSessionId) {
        roots.add(card.rootSessionId);
      }
    }
    for (const session of spawned.values()) {
      if (typeof session?.rootSessionId === 'string' && session.rootSessionId) {
        roots.add(session.rootSessionId);
      }
    }
    for (const [parentSessionId, tasks] of asyncTasks) {
      if (!(tasks ?? []).some((task) => task?.status === 'running' || task?.status === 'done')) continue;
      const rootSessionId = spawned.get(parentSessionId)?.rootSessionId ?? parentSessionId;
      if (rootSessionId) roots.add(rootSessionId);
    }
    return [...roots].sort();
  };

  // Count only live worker identities, deduplicating an async placeholder once
  // its child session snapshot arrives. This deliberately exposes no labels,
  // session metadata, or transcript state to the navigation activity lamp.
  const activeActorCount = () => {
    const identities = new Set();
    for (const card of bound.values()) {
      if (card?.streaming === true && card?.sessionId) identities.add(`bound:${card.sessionId}`);
    }
    for (const session of spawned.values()) {
      if (session?.running === true && session?.sessionId) identities.add(`spawned:${session.sessionId}`);
    }
    for (const [parentSessionId, tasks] of asyncTasks) {
      for (const task of tasks) {
        const childSessionId = typeof task?.childSessionId === 'string' && task.childSessionId
          ? task.childSessionId : null;
        identities.add(childSessionId
          ? `spawned:${childSessionId}`
          : `task:${parentSessionId}:${String(task?.taskId ?? 'pending')}`);
      }
    }
    return identities.size;
  };

  return {
    startBound, patchBound, finishBound,
    foldSpawned, rootForSpawned, setAsyncTasks, snapshot, rootSessionIds, activeActorCount,
  };
};
