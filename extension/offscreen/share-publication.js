// @ts-check
// Roll back a public App card without revoking bytes held by another owner.

/**
 * @param {{
 *   base: any,
 *   state: any,
 *   failedSeq?: number,
 *   release: (ownerId: string, hash: string) => unknown,
 * }} options
 */
export const rollbackSharePublication = async ({ base, state, failedSeq, release }) => {
  const previous = state.previous;
  let restored = false;
  if (previous?.head?.version_id && previous?.head?.content_addr
      && Number.isInteger(previous?.head?.size)) {
    await base.publishMeta({
      slug: state.slug,
      name: previous.name,
      description: previous.description,
      head: previous.head,
      seq: Math.max(
        Date.now(),
        Number.isInteger(failedSeq) ? /** @type {number} */ (failedSeq) + 1 : 0,
        Number.isInteger(previous.seq) ? previous.seq + 1 : 0,
      ),
    });
    restored = true;
  } else {
    await base.unpublishMeta({ slug: state.slug, publisher: base.did });
  }
  if (state.ownershipAdded && state.newHash !== previous?.head?.version_id) {
    release(state.ownerId, state.newHash);
  }
  return { restored };
};
