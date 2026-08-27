// @ts-check
// Reconstruct durable local shares after one exact dweb host generation starts.

import { toBase64 } from '../shared/bundle/bytes.js';

/** @param {any} deps */
export const createKernelDwebReseedOwner = ({
  active, locked, appRegistry, withDwebPublication, withAppLifecycle,
  repositories, sendMessage, currentHostEpoch, messageTimeoutMs = 10_000,
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, log = console,
}) => {
  if (![active, locked, appRegistry?.list, appRegistry?.get,
    withDwebPublication, withAppLifecycle, sendMessage, currentHostEpoch].every(
    (value) => typeof value === 'function',
  ) || !Number.isFinite(messageTimeoutMs) || messageTimeoutMs <= 0) {
    throw new TypeError('kernel-dweb-reseed-owner-config-invalid');
  }
  const completedGenerations = new Set();
  /** @type {Map<string, Promise<any>>} */
  const pendingGenerations = new Map();
  /** @type {string|null} */
  let liveHostEpoch = null;
  let liveMeshGeneration = 0;
  /** @param {string} hostEpoch @param {number} meshGeneration */
  const generationCurrent = (hostEpoch, meshGeneration) => {
    try {
      return liveHostEpoch === hostEpoch && liveMeshGeneration === meshGeneration
        && currentHostEpoch() === hostEpoch;
    } catch { return false; }
  };
  /** @param {any} message */
  const sendBounded = (message) => {
    let timer = /** @type {ReturnType<typeof setTimeoutFn>|null} */ (null);
    const sent = Promise.resolve().then(() => sendMessage(message))
      .then((reply) => ({ reply }), (cause) => ({ cause }));
    const timedOut = new Promise((resolve) => {
      timer = setTimeoutFn(() => resolve({ timeout: true }), messageTimeoutMs);
    });
    return Promise.race([sent, timedOut]).then((outcome) => {
      if (timer !== null) clearTimeoutFn(timer);
      if (/** @type {any} */ (outcome)?.timeout) {
        return { ok: false, error: 'dweb-reseed-host-timeout' };
      }
      const cause = /** @type {any} */ (outcome)?.cause;
      if (cause) throw cause;
      return /** @type {any} */ (outcome)?.reply;
    });
  };
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
  const reseed = async (/** @type {string} */ hostEpoch,
    /** @type {number} */ meshGeneration) => {
    const exact = () => generationCurrent(hostEpoch, meshGeneration);
    if (!active() || locked() || !exact()) {
      return { ok: false, seeded: 0, cancelled: true, error: 'dweb-generation-retired' };
    }
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
    let failed = 0;
    for (const candidate of candidates) {
      if (!exact()) {
        return { ok: false, seeded, failed, cancelled: true, error: 'dweb-generation-retired' };
      }
      try {
        const outcome = await withDwebPublication((/** @type {()=>boolean} */ current) =>
          withAppLifecycle(candidate.id, async () => {
            const app = await appRegistry.get(candidate.id);
            if (!current() || !exact() || !active() || locked()
                || !app?.shared || app.dweb?.local !== true
                || typeof app.dweb?.slug !== 'string'
                || !Number.isFinite(app.dweb?.manifest_created)
                || typeof app.dweb?.hash !== 'string') return 'skipped';
            const release = await reconstructRelease(app);
            if (!current() || !exact()) return 'retired';
            const reply = await sendBounded({
              type: 'dweb/base-host/share-app',
              expectedHostEpoch: hostEpoch,
              expectedMeshGeneration: meshGeneration,
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
            if (!current() || !exact()) return 'retired';
            return reply?.ok === true ? 'seeded' : 'failed';
          }));
        if (outcome === 'seeded') seeded += 1;
        else if (outcome === 'failed') failed += 1;
        else if (outcome === 'retired') {
          return { ok: false, seeded, failed, cancelled: true, error: 'dweb-generation-retired' };
        }
      } catch (cause) {
        failed += 1;
        log.debug('[kernel] dweb reseed failed', candidate.id, cause);
      }
    }
    return failed > 0
      ? { ok: false, seeded, failed, error: 'dweb-reseed-partial' }
      : { ok: true, seeded };
  };
  const onHostGeneration = (/** @type {{hostEpoch?:unknown,meshGeneration?:unknown}} */ event) => {
    const meshGeneration = event?.meshGeneration;
    if (typeof event?.hostEpoch !== 'string' || event.hostEpoch.length < 8
        || !Number.isSafeInteger(meshGeneration)
        || /** @type {number} */ (meshGeneration) < 1) {
      return Promise.resolve({ ok: false, seeded: 0, error: 'dweb-generation-invalid' });
    }
    const generation = `${event.hostEpoch}:${meshGeneration}`;
    let exactHostEpoch;
    try { exactHostEpoch = currentHostEpoch(); } catch { exactHostEpoch = null; }
    if (exactHostEpoch !== event.hostEpoch) {
      return Promise.resolve({
        ok: false, seeded: 0, cancelled: true, error: 'dweb-generation-retired',
      });
    }
    if (liveHostEpoch === event.hostEpoch && Number(meshGeneration) < liveMeshGeneration) {
      return Promise.resolve({
        ok: false, seeded: 0, cancelled: true, error: 'dweb-generation-retired',
      });
    }
    if (liveHostEpoch !== event.hostEpoch || Number(meshGeneration) > liveMeshGeneration) {
      liveHostEpoch = event.hostEpoch;
      liveMeshGeneration = Number(meshGeneration);
    }
    const existing = pendingGenerations.get(generation);
    if (existing) return existing;
    if (completedGenerations.has(generation)) {
      return Promise.resolve({ ok: true, seeded: 0, coalesced: true });
    }
    const operation = reseed(event.hostEpoch, Number(meshGeneration)).then((result) => {
      if (result?.ok === true) {
        completedGenerations.add(generation);
        // why: host generations are only a replay fence for this background
        // lifetime. Bound the history without letting a delayed duplicate of
        // the immediately prior generations repeat a full publication pass.
        while (completedGenerations.size > 32) {
          completedGenerations.delete(completedGenerations.values().next().value);
        }
      }
      return result;
    }).finally(() => {
      pendingGenerations.delete(generation);
    });
    pendingGenerations.set(generation, operation);
    return operation;
  };
  return Object.freeze({ onHostGeneration });
};
