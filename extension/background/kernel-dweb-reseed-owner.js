// @ts-check
// Reconstruct durable local shares after one exact dweb host generation starts.

import { toBase64 } from '../shared/bundle/bytes.js';

/** @param {any} deps */
export const createKernelDwebReseedOwner = ({
  active, locked, appRegistry, withDwebPublication, withAppLifecycle,
  repositories, sendMessage, log = console,
}) => {
  if (![active, locked, appRegistry?.list, appRegistry?.get,
    withDwebPublication, withAppLifecycle, sendMessage].every(
    (value) => typeof value === 'function',
  )) throw new TypeError('kernel-dweb-reseed-owner-config-invalid');
  /** @type {string|null} */
  let lastGeneration = null;
  /** @type {string|null} */
  let pendingGeneration = null;
  /** @type {Promise<any>|null} */
  let inFlight = null;
  const reconstructRelease = async (/** @type {any} */ app) => {
    const oid = app.dweb.source_git_oid;
    if (oid == null) return {};
    if (!repositories?.snapshot || typeof oid !== 'string' || !/^[a-f0-9]{40}$/.test(oid)
        || app.dweb.git_oid !== oid) {
      throw new Error('signed release lineage cannot be reconstructed safely');
    }
    const entryFile = typeof app.dweb.release_entry_file === 'string'
      ? app.dweb.release_entry_file : app.entryFile;
    const fileKinds = app.dweb.release_file_kinds && typeof app.dweb.release_file_kinds === 'object'
      ? app.dweb.release_file_kinds : (app.fileKinds ?? {});
    const snapshot = await repositories.snapshot({ kind: 'app', id: app.id }, { at: oid });
    if (!Object.hasOwn(snapshot, entryFile)) throw new Error('release-entry-missing');
    let totalBytes = 0;
    const files = Object.fromEntries(Object.entries(snapshot).map(([path, value]) => {
      const bytes = /** @type {Uint8Array} */ (value);
      totalBytes += bytes.byteLength;
      return [path, { base64: toBase64(bytes) }];
    }));
    return {
      release: {
        previousVersionId: typeof app.dweb.previous_version_id === 'string'
          ? app.dweb.previous_version_id : null,
        gitCommitOid: oid,
        changelog: typeof app.dweb.changelog === 'string' ? app.dweb.changelog : '',
      },
      releaseSnapshot: {
        ok: true, oid, totalBytes,
        record: { name: app.name, entryFile, fileKinds: { ...fileKinds } },
        files,
      },
    };
  };
  const reseed = async () => {
    if (!active() || locked()) return { ok: false, seeded: 0, error: 'dweb-disabled' };
    let candidates;
    try {
      candidates = (await appRegistry.list()).filter((/** @type {any} */ app) => app.shared
        && app.dweb?.local === true && typeof app.dweb?.slug === 'string'
        && Number.isFinite(app.dweb?.manifest_created) && typeof app.dweb?.hash === 'string');
    } catch (cause) {
      log.warn('[kernel] dweb reseed listing failed', cause);
      return { ok: false, seeded: 0, error: 'dweb-reseed-list-failed' };
    }
    let seeded = 0;
    for (const candidate of candidates) {
      try {
        await withDwebPublication((/** @type {()=>boolean} */ current) =>
          withAppLifecycle(candidate.id, async () => {
            const app = await appRegistry.get(candidate.id);
            if (!current() || !active() || locked()
                || !app?.shared || app.dweb?.local !== true
                || typeof app.dweb?.slug !== 'string'
                || !Number.isFinite(app.dweb?.manifest_created)
                || typeof app.dweb?.hash !== 'string') return;
            const release = await reconstructRelease(app);
            const reply = await sendMessage({
              type: 'dweb/base-host/share-app',
              appId: app.id,
              name: app.name,
              entry: app.entryFile,
              fileKinds: app.fileKinds ?? {},
              created: app.dweb.manifest_created,
              expectedHash: app.dweb.hash,
              slug: app.dweb.slug,
              seq: app.dweb.seq,
              description: app.dweb.description ?? '',
              reseed: true,
              ...release,
            });
            if (reply?.ok) seeded += 1;
          }));
      } catch (cause) {
        log.debug('[kernel] dweb reseed failed', candidate.id, cause);
      }
    }
    return { ok: true, seeded };
  };
  const onHostGeneration = (/** @type {{hostEpoch?:unknown,meshGeneration?:unknown}} */ event) => {
    const meshGeneration = event?.meshGeneration;
    if (typeof event?.hostEpoch !== 'string' || event.hostEpoch.length < 8
        || !Number.isSafeInteger(meshGeneration)
        || /** @type {number} */ (meshGeneration) < 1) {
      return Promise.resolve({ ok: false, seeded: 0, error: 'dweb-generation-invalid' });
    }
    const generation = `${event.hostEpoch}:${meshGeneration}`;
    if (generation === pendingGeneration && inFlight) return inFlight;
    if (generation === lastGeneration) {
      return inFlight ?? Promise.resolve({ ok: true, seeded: 0, coalesced: true });
    }
    pendingGeneration = generation;
    inFlight = reseed().then((result) => {
      if (result?.ok === true) lastGeneration = generation;
      return result;
    }).finally(() => {
      if (pendingGeneration === generation) pendingGeneration = null;
      inFlight = null;
    });
    return inFlight;
  };
  return Object.freeze({ onHostGeneration });
};
