// @ts-check
// Publish bytes and their public announcement as one recoverable transaction.

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
    try {
      await rollback(published);
    } catch (rollbackCause) {
      throw new AggregateError(
        [cause, rollbackCause],
        'publish failed and its byte rollback also failed',
      );
    }
    throw cause;
  }
  // why: announcement is the commit point. Cleanup failure must not revoke the
  // bytes that the now-public announcement names.
  await supersede(published, announced);
  return { published, announced };
};
