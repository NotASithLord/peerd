// @ts-check
// Lazy, sealed actor-view cluster. It is loaded only for actor overview/count.

/** @param {string} route @param {any} message */
export const dispatchActorSemanticRoute = async (route, message) => {
  const context = message.kernelContext;
  const observedAt = Number.isFinite(context?.observedAt) ? context.observedAt : Date.now();
  if (route === 'actors/count' && Number.isSafeInteger(context?.activeActors)
      && context.activeActors >= 0) {
    return { ok: true, activeActors: context.activeActors, observedAt };
  }
  if (route === 'actors/overview' && Array.isArray(context?.roots)) {
    return { ok: true, roots: context.roots, observedAt };
  }
  return { ok: false, code: 'semantic-actor-route-refused', outcomeKnown: true };
};
