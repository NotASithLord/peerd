// @ts-check
// Read-only, instance-wide actor observability for the full-page home. The
// projection supplies live server-stamped topology; this route joins only the
// owning chat's minimized label/model and latest non-synthetic user request.
// It grants no actor authority and never returns actor transcripts, assistant
// claims, tool inputs/results, or inactive chat messages.

const DISPLAY_TEXT_MAX = 96;
const ACTOR_LABEL_MAX = 80;
const CONTROL_OR_BIDI = /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g;

/** @param {unknown} value */
const cleanText = (value) => String(value ?? '')
  .replace(CONTROL_OR_BIDI, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** @param {unknown} value @param {number} [max] */
const compact = (value, max = 96) => {
  const text = cleanText(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** @param {unknown} value @param {number} [max] */
const optionalText = (value, max = DISPLAY_TEXT_MAX) => {
  const text = compact(value, max);
  return text || undefined;
};

/** @param {any} message @param {boolean} busy @param {boolean} hasActors */
const activityFor = (message, busy, hasActors) => {
  // Assistant text/tool calls are model claims, not runtime-observed facts.
  // The store supplies only the latest real user request; actor replies and
  // recovery notices never enter this high-frequency observability path.
  if ((busy || hasActors) && typeof message?.content === 'string'
    && cleanText(message.content)) {
    const goal = compact(message.content, 82);
    return hasActors ? `Coordinating: ${goal}` : `Working on: ${goal}`;
  }
  if (hasActors) return 'Coordinating isolated actor work…';
  return busy ? 'Reasoning in the main context…' : 'Waiting for isolated work…';
};

/** @param {any} snapshot */
const hasTopology = (snapshot) => Object.keys(snapshot?.actors ?? {}).length > 0
  || Object.keys(snapshot?.spawned?.sessions ?? {}).length > 0
  || Object.values(snapshot?.asyncTasks ?? {}).some((tasks) => Array.isArray(tasks)
    && tasks.some((task) => task?.status === 'running' || task?.status === 'done'));

/** @param {any} actor */
const safeActor = (actor) => {
  const name = optionalText(actor?.name, ACTOR_LABEL_MAX);
  const task = optionalText(actor?.task, ACTOR_LABEL_MAX);
  return {
    sessionId: actor?.sessionId,
    rootSessionId: actor?.rootSessionId,
    parentSessionId: actor?.parentSessionId,
    parentToolUseId: actor?.parentToolUseId,
    kind: actor?.kind,
    instanceId: actor?.instanceId,
    ...(name ? { name } : {}),
    ...(task ? { task } : {}),
    depth: actor?.depth,
    visibleTools: Array.isArray(actor?.visibleTools)
      ? actor.visibleTools.filter((/** @type {unknown} */ tool) => typeof tool === 'string') : [],
    streaming: actor?.streaming === true,
    running: actor?.running === true,
    cost: typeof actor?.cost?.cost === 'number' ? { cost: actor.cost.cost } : null,
  };
};

/** @param {any} snapshot */
const safeTopology = (snapshot) => ({
  actors: Object.fromEntries(Object.entries(snapshot?.actors ?? {})
    .map(([toolUseId, actor]) => [toolUseId, safeActor(actor)])),
  spawned: {
    byToolUse: { ...(snapshot?.spawned?.byToolUse ?? {}) },
    sessions: Object.fromEntries(Object.entries(snapshot?.spawned?.sessions ?? {})
      .map(([sessionId, actor]) => [sessionId, safeActor(actor)])),
  },
  asyncTasks: Object.fromEntries(Object.entries(snapshot?.asyncTasks ?? {})
    .map(([parentSessionId, tasks]) => [parentSessionId,
      (Array.isArray(tasks) ? tasks : [])
        .filter((task) => task?.status === 'running' || task?.status === 'done')
        .map((task) => {
        const taskLabel = optionalText(task?.task, ACTOR_LABEL_MAX);
        return {
          taskId: task?.taskId,
          childSessionId: task?.childSessionId,
          ...(taskLabel ? { task: taskLabel } : {}),
          status: task?.status,
          visibleTools: Array.isArray(task?.visibleTools)
            ? task.visibleTools.filter((/** @type {unknown} */ tool) => typeof tool === 'string') : [],
        };
      })])),
});

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any, sender?: any) => Promise<any>>}
 */
export const makeActorOverviewRoutes = (deps) => {
  const { vault, sessions, turnSlots, actorLiveProjection, isActualHomeSender } = deps;

  const authorized = (/** @type {any} */ sender) =>
    typeof isActualHomeSender === 'function' && isActualHomeSender(sender);

  const buildOverview = async () => {
    const rootIds = new Set([
      ...actorLiveProjection.rootSessionIds(),
      ...turnSlots.busySessionIds(),
    ]);
    const roots = [];
    for (const sessionId of rootIds) {
      const metadata = await sessions.getMetadata(sessionId);
      const kind = metadata?.kind ?? 'chat';
      if (!metadata || kind === 'spawned' || kind === 'actor'
        || metadata.archivedAt !== undefined) continue;
      const topology = actorLiveProjection.snapshot(sessionId);
      const busy = !!turnSlots.isBusy(sessionId);
      const activeTopology = hasTopology(topology);
      if (!busy && !activeTopology) continue;
      // Reverse-read one real user message. No poll assembles a transcript or
      // scans inactive chats merely to label the current work.
      const liveActivity = turnSlots.activityFor?.(sessionId);
      const latestRequest = typeof liveActivity === 'string' && liveActivity
        ? { content: liveActivity }
        : await sessions.getLatestNonSyntheticUserMessage(sessionId);
      const title = optionalText(metadata.title, DISPLAY_TEXT_MAX);
      const provider = optionalText(metadata.provider, DISPLAY_TEXT_MAX);
      const model = optionalText(metadata.model, DISPLAY_TEXT_MAX);
      roots.push({
        session: {
          sessionId,
          title: title ?? null,
          provider: provider ?? null,
          model: model ?? null,
        },
        busy,
        activity: activityFor(latestRequest, busy, activeTopology),
        topology: safeTopology(topology),
      });
    }
    roots.sort((a, b) => Number(b.busy) - Number(a.busy)
      || String(a.session.title ?? a.session.sessionId)
        .localeCompare(String(b.session.title ?? b.session.sessionId)));
    return { ok: true, roots, observedAt: Date.now() };
  };

  // Multiple Home tabs can tick together. Share one in-flight read so a slow
  // IDB response never fans out into duplicate monitor work.
  /** @type {Promise<any>|null} */
  let overviewInFlight = null;
  const overview = () => {
    if (overviewInFlight) return overviewInFlight;
    const current = buildOverview();
    overviewInFlight = current;
    void current.finally(() => {
      if (overviewInFlight === current) overviewInFlight = null;
    }).catch(() => {});
    return current;
  };

  return {
    'actors/overview': async (_msg = {}, sender = undefined) => {
      if (!authorized(sender)) {
        return { ok: false, error: 'actor-overview-unauthorized' };
      }
      if (vault.isLocked()) return { ok: false, error: 'locked' };
      return overview();
    },
    'actors/count': async (_msg = {}, sender = undefined) => {
      if (!authorized(sender)) return { ok: false, error: 'actor-overview-unauthorized' };
      if (vault.isLocked()) return { ok: false, error: 'locked' };
      return {
        ok: true,
        activeActors: actorLiveProjection.activeActorCount(),
        observedAt: Date.now(),
      };
    },
  };
};
