// @ts-check
// One identity-bound app-share transaction. Both user and agent entry points
// call this shell so publisher-derived metadata and custody serialization cannot
// drift apart again.

/**
 * @param {Object} deps
 * @param {boolean} deps.enabled
 * @param {() => boolean} deps.active
 * @param {<T>(operation: () => Promise<T>) => Promise<T>} deps.withIdentityMutation
 * @param {{ get: (id: string) => Promise<any>, update: (id: string, patch: any) => Promise<any> }} deps.appRegistry
 * @param {(parts: string[]) => { list: () => Promise<any[]>, read: (path: string) => Promise<any> }} deps.opfsHelpers
 * @param {() => Promise<any>} deps.prepareRuntime
 * @param {(message: any) => Promise<any>} deps.sendMessage
 */
export const makeDwebShare = ({
  enabled, active, withIdentityMutation, appRegistry, opfsHelpers,
  prepareRuntime, sendMessage,
}) => async (/** @type {string} */ appId, /** @type {string | undefined} */ slug) => {
  if (!enabled || !active()) return { ok: false, error: 'dweb-disabled' };

  // why: a cold host mints its first identity through the custody lane. Start
  // it before owning that lane or first-share waits on its own queued mint.
  const started = await prepareRuntime();
  if (!started?.ok) return started ?? { ok: false, error: 'dweb-start-failed' };

  return withIdentityMutation(async () => {
    if (!enabled || !active()) return { ok: false, error: 'dweb-disabled' };
    const record = await appRegistry.get(appId);
    if (!record) return { ok: false, error: 'app-not-found' };
    const opfs = opfsHelpers(['peerd-apps', appId]);
    /** @type {Record<string, any>} */
    const files = {};
    for (const file of await opfs.list()) {
      const path = file.path.replace(/^\/+/, '');
      files[path] = await opfs.read(path);
    }
    const useSlug = record.dweb?.slug || slug || undefined;
    const reply = await sendMessage({
      type: 'dweb/base-host/share-app',
      name: record.name, entry: record.entryFile, files, slug: useSlug,
    });
    if (!reply?.ok) return reply;
    try {
      const updated = await appRegistry.update(appId, {
        shared: true,
        dweb: {
          uri: reply.uri, publisher: reply.publisher ?? null, hash: reply.hash,
          version_id: reply.hash, slug: reply.slug, dwapp_id: reply.dwapp_id,
          seq: reply.seq, local: true,
        },
      });
      if (!updated) throw new Error('app was deleted before share metadata was stored');
    } catch (cause) {
      // Best-effort rollback: never report a successful share whose
      // identity-derived deletion metadata was not durably recorded.
      const rollback = await sendMessage({
        type: 'dweb/base-host/unshare-app',
        name: record.name, slug: reply.slug,
        publisher: reply.publisher ?? null, hash: reply.hash ?? null,
      }).catch(() => null);
      return {
        ok: false,
        error: rollback?.ok ? 'share-metadata-store-failed' : 'share-rollback-failed',
        cause: /** @type {{ message?: string }} */ (cause)?.message ?? String(cause),
      };
    }
    return reply;
  });
};
