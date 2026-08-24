// @ts-check
// Lazy, sealed actor-view cluster. It is loaded only for actor overview/count.

import { makeActorOverviewRoutes } from '../../background/routes/actor-overview.js';

/** @param {string} route @param {any} message */
export const dispatchActorSemanticRoute = async (route, message) => {
  const context = message.kernelContext;
  const roots = /** @type {any[]} */ (Array.isArray(context?.roots) ? context.roots : []);
  const byId = new Map(roots.map((/** @type {any} */ root) => [root.sessionId, root]));
  const routes = makeActorOverviewRoutes({
    vault: { isLocked: () => false },
    sessions: {
      getMetadata: async (/** @type {string} */ id) => byId.get(id)?.metadata ?? null,
      getLatestNonSyntheticUserMessage: async (/** @type {string} */ id) =>
        byId.get(id)?.latestRequest ?? null,
    },
    turnSlots: {
      busySessionIds: () => roots.filter((root) => root.busy).map((root) => root.sessionId),
      isBusy: (/** @type {string} */ id) => byId.get(id)?.busy === true,
    },
    actorLiveProjection: {
      rootSessionIds: () => roots.map((root) => root.sessionId),
      snapshot: (/** @type {string} */ id) => byId.get(id)?.topology ?? {},
      activeActorCount: () => Number.isSafeInteger(context?.activeActors)
        ? context.activeActors : 0,
    },
    isActualHomeSender: () => true,
  });
  const handler = routes[route];
  if (typeof handler !== 'function') {
    return { ok: false, code: 'semantic-actor-route-refused', outcomeKnown: true };
  }
  return handler({}, {});
};
