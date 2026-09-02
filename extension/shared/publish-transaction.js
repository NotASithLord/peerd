// @ts-check
// Publish bytes and their public announcement as one recoverable transaction.

/**
 * Preserve a host-owned effect verdict while a publish transaction unwinds its
 * newly staged bytes.
 * @param {any} result
 * @param {string} fallback
 */
export const publishFailureError = (result, fallback) => Object.assign(
  new Error(result?.error ?? fallback),
  {
    ...(typeof result?.code === 'string' ? { code: result.code } : {}),
    ...(typeof result?.performed === 'boolean' ? { performed: result.performed } : {}),
    ...(typeof result?.outcomeKnown === 'boolean' ? { outcomeKnown: result.outcomeKnown } : {}),
    ...(typeof result?.retryable === 'boolean' ? { retryable: result.retryable } : {}),
    ...(['pre-effect-failure', 'effect-completed', 'host-lost', 'transport-lost']
      .includes(result?.outcomeKind)
      ? { outcomeKind: result.outcomeKind } : {}),
  },
);

/**
 * The byte publication happens first because the announcement must never point
 * at content this node cannot serve. Any later failure revokes those new bytes.
 * Superseded bytes are revoked only after the new announcement succeeds.
 *
 * @template P,A
 * @param {{
 *   publish: () => Promise<P>,
 *   announce: (published: P) => Promise<A>,
 *   rollback: (published: P) => Promise<unknown> | unknown,
 *   supersede?: (published: P, announced: A) => Promise<unknown> | unknown,
 * }} steps
 */
export const runPublishTransaction = async ({
  publish, announce, rollback, supersede = () => {},
}) => {
  const published = await publish();
  let announced;
  try {
    announced = await announce(published);
  } catch (cause) {
    const verdict = /** @type {any} */ (cause);
    // Compensation is safe only when the failed announcement is known not to
    // have committed. A lost SW response may arrive after its durable write;
    // retain the staged bytes so committed metadata never points at content we
    // deliberately removed.
    if (verdict?.outcomeKnown === false || verdict?.performed === true
        || ['effect-completed', 'host-lost', 'transport-lost']
          .includes(verdict?.outcomeKind)) throw cause;
    try {
      await rollback(published);
    } catch (rollbackCause) {
      throw Object.assign(
        new AggregateError(
          [cause, rollbackCause],
          'publish failed and its byte rollback also failed',
        ),
        {
          code: 'publish-rollback-incomplete',
          performed: true, outcomeKnown: false,
          outcomeKind: 'host-lost', retryable: false,
        },
      );
    }
    throw cause;
  }
  // why: announcement is the commit point. Cleanup failure must not revoke the
  // bytes that the now-public announcement names.
  await supersede(published, announced);
  return { published, announced };
};
