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

/** @param {any} session @param {boolean} busy @param {boolean} hasActors */
const activityFor = (session, busy, hasActors) => {
  const messages = Array.isArray(session?.messages) ? session.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    // Assistant text/tool calls are model claims, not runtime-observed facts.
    // Synthetic user rows are actor replies/recovery notices, not the request
    // that caused this orchestrator turn. Only the user's latest real request
    // is safe to label as what the main context is working on.
    if ((busy || hasActors) && message?.role === 'user' && message.synthetic !== true
      && typeof message.content === 'string' && cleanText(message.content)) {
      const goal = compact(message.content, 82);
      return hasActors ? `Coordinating: ${goal}` : `Working on: ${goal}`;
    }
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
    grantedTools: Array.isArray(actor?.grantedTools)
      ? actor.grantedTools.filter((/** @type {unknown} */ tool) => typeof tool === 'string') : [],
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
      (Array.isArray(tasks) ? tasks : []).map((task) => {
        const taskLabel = optionalText(task?.task, ACTOR_LABEL_MAX);
        return {
          taskId: task?.taskId,
          childSessionId: task?.childSessionId,
          ...(taskLabel ? { task: taskLabel } : {}),
          status: task?.status,
          grantedTools: Array.isArray(task?.grantedTools)
            ? task.grantedTools.filter((/** @type {unknown} */ tool) => typeof tool === 'string') : [],
        };
      })])),
});

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any, sender?: any) => Promise<any>>}
 */
export const makeActorOverviewRoutes = (deps) => {
  const { vault, sessions, turnSlots, actorLiveProjection, isActualHomeSender } = deps;

  return {
    'actors/overview': async (_msg = {}, sender = undefined) => {
      if (typeof isActualHomeSender !== 'function' || !isActualHomeSender(sender)) {
        return { ok: false, error: 'actor-overview-unauthorized' };
      }
      if (vault.isLocked()) return { ok: false, error: 'locked' };
      const rows = await sessions.listMetadata();
      const chats = rows.filter((/** @type {any} */ session) => {
        const kind = session?.kind ?? 'chat';
        return kind !== 'spawned' && kind !== 'actor' && session?.archivedAt === undefined;
      });
      const byId = new Map(chats.map((/** @type {any} */ session) => [session.sessionId, session]));
      const rootIds = new Set(actorLiveProjection.rootSessionIds());
      for (const session of /** @type {any[]} */ (chats)) {
        if (turnSlots.isBusy(session.sessionId)) rootIds.add(session.sessionId);
      }

      const roots = [];
      for (const sessionId of rootIds) {
        const metadata = byId.get(sessionId);
        if (!metadata) continue;
        const topology = actorLiveProjection.snapshot(sessionId);
        const busy = !!turnSlots.isBusy(sessionId);
        const activeTopology = hasTopology(topology);
        if (!busy && !activeTopology) continue;
        // Only active roots cross into the message store, and only to recover
        // the latest real user request. Inactive chats never load transcripts.
        const session = await sessions.get(sessionId);
        if (!session) continue;
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
          activity: activityFor(session, busy, activeTopology),
          topology: safeTopology(topology),
        });
      }
      roots.sort((a, b) => Number(b.busy) - Number(a.busy)
        || String(a.session.title ?? a.session.sessionId)
          .localeCompare(String(b.session.title ?? b.session.sessionId)));
      return { ok: true, roots, observedAt: Date.now() };
    },
  };
};
