// @ts-check
// Bounded App-actor attachment recovery for the trusted App tab.
//
// `app/tab-ready` is an exact tab/app/owner claim and the background reconciles
// it through one owner-scoped actor-binding lane. If its receipt is lost, the
// only safe retry is that SAME handshake. A proved failure may instead use the
// explicit `app/actor-retry` operation. Keeping that distinction here prevents
// UI code from accidentally turning an unknown receipt into a fresh operation.

/** @typedef {'app/tab-ready'|'app/actor-retry'} AppActorAttachOperation */

/**
 * @param {{ request:(operation:AppActorAttachOperation)=>Promise<any> }} deps
 */
export const makeAppActorAttachRecovery = ({ request }) => {
  if (typeof request !== 'function') throw new TypeError('app-actor-attach-request-required');
  /** @type {Promise<any>|null} */
  let inFlight = null;
  /** @type {AppActorAttachOperation} */
  let nextOperation = 'app/tab-ready';

  /** @param {AppActorAttachOperation} operation */
  const run = (operation) => {
    // Double clicks and overlapping lifecycle callbacks share one exact request.
    if (inFlight) return inFlight;
    inFlight = (async () => {
      /** @type {any} */
      let reply;
      try {
        reply = await request(operation);
      } catch (cause) {
        const outcomeKnown = /** @type {{outcomeKnown?:boolean}} */ (cause)?.outcomeKnown !== false;
        reply = {
          ok: false,
          error: outcomeKnown
            ? operation === 'app/tab-ready'
              ? 'The App isolation check did not respond.'
              : 'The actor retry did not respond.'
            : 'Peerd could not confirm whether the App actor attached.',
          // A transport-unknown exact handshake is retryable because the
          // background operation is owner-scoped and idempotently reconciled.
          actorRequired: true,
          retryable: true,
          outcomeKnown,
        };
      }
      const result = { ...(reply ?? {}), attachOperation: operation };
      if (result.ok !== true && result.outcomeKnown === false) {
        // Preserve recovery even when a future authority returns an explicit
        // unknown receipt instead of rejecting the browser message promise.
        result.actorRequired = true;
        result.retryable = true;
      }
      if (result.ok === true) {
        nextOperation = 'app/actor-retry';
      } else {
        // Unknown means repeat the exact operation. A received refusal proves
        // this attempt ended and may use the explicit fresh retry operation.
        nextOperation = result.outcomeKnown === false ? operation : 'app/actor-retry';
      }
      return result;
    })().finally(() => { inFlight = null; });
    return inFlight;
  };

  return Object.freeze({
    start: () => run('app/tab-ready'),
    retry: () => run(nextOperation),
    nextOperation: () => nextOperation,
    pending: () => inFlight !== null,
  });
};
