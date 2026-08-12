// @ts-check
// Re-publish durable local shares after the offscreen content host restarts.

import { toBase64 } from '../shared/bundle/bytes.js';

/**
 * @param {{
 *   enabled: boolean,
 *   active: () => boolean,
 *   locked: () => boolean,
 *   appRegistry: { list: () => Promise<any[]>, get: (id: string) => Promise<any> },
 *   withDwebPublication: <T>(operation: (isCurrent: () => boolean) => Promise<T>) => Promise<T>,
 *   withAppLifecycle: <T>(appId: string, operation: () => Promise<T>) => Promise<T>,
 *   repositories?: { snapshot: (ref: {kind: string, id: string}, opts: {at: string}) => Promise<Record<string, Uint8Array>> },
 *   sendMessage: (message: any) => Promise<any>,
 *   log?: Pick<Console, 'log' | 'warn' | 'debug'>,
 * }} deps
 */
export const makeReseedSharedApps = ({
  enabled, active, locked, appRegistry, withDwebPublication, withAppLifecycle,
  repositories, sendMessage, log = console,
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
        let releasePayload = {};
        const signedOid = app.dweb.source_git_oid;
        if (signedOid != null) {
          if (!repositories
              || typeof signedOid !== 'string' || !/^[a-f0-9]{40}$/.test(signedOid)
              || app.dweb.git_oid !== signedOid) {
            throw new Error('signed release lineage cannot be reconstructed safely');
          }
          const entryFile = typeof app.dweb.release_entry_file === 'string'
            ? app.dweb.release_entry_file
            : app.entryFile;
          const fileKinds = app.dweb.release_file_kinds && typeof app.dweb.release_file_kinds === 'object'
            ? app.dweb.release_file_kinds
            : (app.fileKinds ?? {});
          const snapshot = await repositories.snapshot(
            { kind: 'app', id: app.id },
            { at: signedOid },
          );
          if (!Object.hasOwn(snapshot, entryFile)) throw new Error('release-entry-missing');
          /** @type {Record<string, {base64: string}>} */
          const files = Object.create(null);
          let totalBytes = 0;
          for (const [path, bytes] of Object.entries(snapshot)) {
            totalBytes += bytes.byteLength;
            files[path] = { base64: toBase64(bytes) };
          }
          const release = {
            previousVersionId: typeof app.dweb.previous_version_id === 'string'
              ? app.dweb.previous_version_id
              : null,
            gitCommitOid: signedOid,
            changelog: typeof app.dweb.changelog === 'string' ? app.dweb.changelog : '',
          };
          releasePayload = {
            release,
            releaseSnapshot: {
              ok: true,
              oid: signedOid,
              totalBytes,
              record: { name: app.name, entryFile, fileKinds: { ...fileKinds } },
              files,
            },
          };
        }
        const reply = await sendMessage({
          type: 'dweb/base-host/share-app', appId: app.id, name: app.name,
          entry: app.entryFile, fileKinds: app.fileKinds ?? {},
          created: app.dweb.manifest_created, expectedHash: app.dweb.hash,
          slug: app.dweb.slug, seq: app.dweb.seq,
          description: app.dweb.description ?? '', reseed: true,
          ...releasePayload,
        });
        if (reply?.ok) seeded += 1;
      }));
    } catch (error) {
      log.debug('[sw] re-seed failed for', candidate.id, error);
    }
  }
  if (seeded) log.log('[sw] re-seeded', seeded, 'shared app(s) after base network start');
};
