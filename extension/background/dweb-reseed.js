// @ts-check
// Re-publish durable local shares after the offscreen content host restarts.

/**
 * @param {{
 *   enabled: boolean,
 *   active: () => boolean,
 *   locked: () => boolean,
 *   appRegistry: { list: () => Promise<any[]>, get: (id: string) => Promise<any> },
 *   withDwebPublication: <T>(operation: (isCurrent: () => boolean) => Promise<T>) => Promise<T>,
 *   withAppLifecycle: <T>(appId: string, operation: () => Promise<T>) => Promise<T>,
 *   sendMessage: (message: any) => Promise<any>,
 *   log?: Pick<Console, 'log' | 'warn' | 'debug'>,
 * }} deps
 */
export const makeReseedSharedApps = ({
  enabled, active, locked, appRegistry, withDwebPublication, withAppLifecycle,
  sendMessage, log = console,
}) => async () => {
  if (!enabled || !active() || locked()) return;
  let candidates;
  try {
    const apps = await appRegistry.list();
    candidates = apps.filter((app) => app.shared && app.dweb?.local && app.dweb?.slug
      && Number.isFinite(app.dweb?.manifest_created) && app.dweb?.hash);
  } catch (error) {
    log.warn('[sw] re-seed: listing apps failed (non-fatal):', error);
    return;
  }
  let seeded = 0;
  for (const candidate of candidates) {
    try {
      await withDwebPublication((isCurrent) => withAppLifecycle(candidate.id, async () => {
        // why: the list is only a work queue. Re-read after acquiring both
        // lifecycle lanes so delete, lock, or master OFF cannot resurrect it.
        const app = await appRegistry.get(candidate.id);
        if (!isCurrent() || !active() || locked()
            || !app?.shared || !app.dweb?.local || !app.dweb?.slug
            || !Number.isFinite(app.dweb?.manifest_created) || !app.dweb?.hash) return;
        const reply = await sendMessage({
          type: 'dweb/base-host/share-app', appId: app.id, name: app.name,
          entry: app.entryFile, fileKinds: app.fileKinds ?? {},
          created: app.dweb.manifest_created, expectedHash: app.dweb.hash,
          slug: app.dweb.slug, seq: app.dweb.seq,
          description: app.dweb.description ?? '', reseed: true,
        });
        if (reply?.ok) seeded += 1;
      }));
    } catch (error) {
      log.debug('[sw] re-seed failed for', candidate.id, error);
    }
  }
  if (seeded) log.log('[sw] re-seeded', seeded, 'shared app(s) after base network start');
};
