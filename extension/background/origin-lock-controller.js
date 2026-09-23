// @ts-check

/**
 * Assemble the per-actor origin-lock closures around the pure runtime policy.
 * Browser/state effects stay injected; this module owns only their ordering.
 *
 * @param {any} deps
 */
export const makeOriginLockResolver = (deps) => {
  const {
    originStates, landingTurnTokens, landingStopReports, landingStopCards,
    makeJudgeLanding, describeLandingStop, landingStopCard,
    retireStoppedRoamingWebActorDurably, webActorRegistry,
    retiredActorSessions, persistWebActors, turnSlots, webActorTabBindings,
    persistWebBindings, pageActivity, siteActorBindings, persistSiteActors,
    auditLog, originPhrase, isKnownIdp, isKnownIdpHost,
    sensitivitySignals, makeSignInOriginAuthorizer,
    makeSignInExcursionAuthorizer, makeSignInExcursionRevoker,
    makeCredentialScope, makeSiteClientOriginGuard,
    makeSiteClientOriginAuthorizer, liveSiteClientLandingFor,
  } = deps;

  return (/** @type {string | null | undefined} */ actorSessionId) => {
    if (!actorSessionId) return null;
    const getState = () => originStates.read(actorSessionId);
    // Capture the turn at context-build time. A judge that finishes after its
    // turn ended may audit its observation, but may not stop the next turn.
    const myTurn = landingTurnTokens.get(actorSessionId) ?? null;
    const isCurrentTurn = () => myTurn === null
      || landingTurnTokens.get(actorSessionId) === myTurn;
    const judgeLandingUnserialized = makeJudgeLanding({
      getState,
      saveState: (/** @type {any} */ patch) => originStates.write(actorSessionId, patch),
      onStop: async (/** @type {any} */ event) => {
        const current = isCurrentTurn();
        if (current) {
          landingStopReports.set(actorSessionId, describeLandingStop(event));
          landingStopCards.set(actorSessionId, landingStopCard(event));
        }
        if (current) {
          const state = originStates.read(actorSessionId);
          const retiringRoamingActor = state?.mode === 'roaming';
          // Stop before fallible persistence: a storage outage must not let the
          // actor continue issuing tools on a refused landing.
          try { turnSlots.stop(actorSessionId); }
          catch (error) { console.warn('[origin-lock] stop failed', error); }
          const retirement = retiringRoamingActor
            ? retireStoppedRoamingWebActorDurably({
              registry: webActorRegistry,
              actorSessionId,
              originState: state,
              markRetired: (/** @type {string} */ sessionId) => { retiredActorSessions.add(sessionId); },
              writeTombstone: () => originStates.write(actorSessionId, { retired: true }),
              persistRouting: persistWebActors,
            })
            : null;
          const parkedTab = webActorTabBindings.tabFor(actorSessionId);
          if (typeof parkedTab === 'number' && webActorTabBindings.drop(parkedTab)) {
            persistWebBindings();
          }
          if (typeof parkedTab === 'number') pageActivity.release(parkedTab).catch(() => {});

          // A provisional site binding that landed elsewhere is a dead handle.
          // Remove it so a retry mints a fresh actor instead of reopening an
          // orphaned tab, while the stopped state remains as a queued-call fence.
          if (state?.provisional && siteActorBindings.dropBySession(actorSessionId) > 0) {
            persistSiteActors();
          }
          if (retirement) {
            const durable = await retirement;
            if (durable.tombstone.status === 'rejected') {
              console.warn('[origin-lock] actor retirement tombstone failed', durable.tombstone.reason);
            }
            if (durable.routing.status === 'rejected') {
              console.warn('[origin-lock] actor retirement routing write failed', durable.routing.reason);
            }
          }
        }
        auditLog.append({
          type: 'actor_origin_stop',
          sessionId: actorSessionId,
          details: {
            action: event.action,
            from: event.from,
            // Never persist a page-controlled path/query: inspect exposes this
            // local audit trail to the orchestrator.
            to: originPhrase(event.to),
            handoffTo: event.handoffTo ?? null,
            ...(current ? {} : { staleTurn: true }),
          },
        }).catch(() => {});
      },
      isIdp: isKnownIdp,
      isCurrent: isCurrentTurn,
      ...sensitivitySignals(),
    });

    const judgeLanding = (/** @type {string} */ url) => originStates.serialize(
      actorSessionId,
      () => {
        if (!isCurrentTurn()) {
          const error = new Error('stale_actor_turn');
          error.name = 'AbortError';
          throw error;
        }
        return judgeLandingUnserialized(url);
      },
    );
    const authorizeSignInOriginUnserialized = makeSignInOriginAuthorizer({
      getState,
      getLiveLanding: () => liveSiteClientLandingFor(actorSessionId),
      saveState: (/** @type {any} */ patch) => originStates.write(actorSessionId, patch),
      isKnownIdp: isKnownIdpHost,
      isCurrent: isCurrentTurn,
      onBound: (/** @type {string} */ origin) => auditLog.append({
        type: 'actor_origin_bound_for_sign_in',
        sessionId: actorSessionId,
        details: { origin },
      }).then(() => undefined),
    });
    const authorizeSignInExcursionUnserialized = makeSignInExcursionAuthorizer({
      getState,
      getLiveLanding: () => liveSiteClientLandingFor(actorSessionId),
      saveState: (/** @type {any} */ patch) => originStates.write(actorSessionId, patch),
      isKnownIdp,
      isCurrent: isCurrentTurn,
    });
    const revokeSignInExcursionUnserialized = makeSignInExcursionRevoker({
      getState,
      getLiveLanding: () => liveSiteClientLandingFor(actorSessionId),
      saveState: (/** @type {any} */ patch) => originStates.write(actorSessionId, patch),
      isKnownIdp,
      isCurrent: isCurrentTurn,
    });

    return {
      getState,
      judgeLanding,
      makeScope: (/** @type {() => string | undefined} */ getOrigin) =>
        makeCredentialScope({ getState, getOrigin, ...sensitivitySignals() }),
      canUseSiteClientOrigin: makeSiteClientOriginGuard({ getState, ...sensitivitySignals() }),
      authorizeSiteClientOrigin: (/** @type {() => Promise<any>} */ getLiveLanding) =>
        makeSiteClientOriginAuthorizer({
          getState, getLiveLanding, judgeLanding,
          ...sensitivitySignals(),
        }),
      authorizeSignInOrigin: (/** @type {string} */ origin, /** @type {AbortSignal | undefined} */ signal) => originStates.serialize(
        actorSessionId,
        () => authorizeSignInOriginUnserialized(origin, signal),
      ),
      authorizeSignInExcursion: (/** @type {string} */ origin, /** @type {AbortSignal | undefined} */ signal) => originStates.serialize(
        actorSessionId,
        () => authorizeSignInExcursionUnserialized(origin, signal),
      ),
      revokeSignInExcursion: (/** @type {string} */ origin, /** @type {AbortSignal | undefined} */ signal) => originStates.serialize(
        actorSessionId,
        () => revokeSignInExcursionUnserialized(origin, signal),
      ),
      terminateUnreadableSignIn: () => originStates.serialize(
        actorSessionId,
        () => {
          if (!isCurrentTurn()) {
            const error = new Error('stale_actor_turn');
            error.name = 'AbortError';
            throw error;
          }
          return judgeLandingUnserialized('https://unreadable.invalid/');
        },
      ),
    };
  };
};
