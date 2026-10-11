// @ts-check
// Reconstruct durable local shares after one exact dweb host generation starts.

import { toBase64 } from '../shared/bundle/bytes.js';
import { withDeadline } from '../shared/cold-util.js';

/** @param {any} deps */
export const createKernelDwebReseedOwner = ({
  active, locked, appRegistry, readSeedBundle, withDwebReseedPublication, withAppLifecycle,
  repositories, sendMessage, currentHostEpoch, messageTimeoutMs = 10_000,
  newId = () => crypto.randomUUID(), setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout, log = console,
}) => {
  if (![active, locked, appRegistry?.list, appRegistry?.get,
    withDwebReseedPublication, withAppLifecycle, sendMessage, currentHostEpoch, newId].every(
    (value) => typeof value === 'function',
  ) || !Number.isFinite(messageTimeoutMs) || messageTimeoutMs <= 0) {
    throw new TypeError('kernel-dweb-reseed-owner-config-invalid');
  }
  /** Preserve the pre-list receipt's absent failure count. @param {number} [seeded]
   * @param {number} [failed] */
  const retired = (seeded = 0, failed) => ({
    ok: false, seeded, ...(failed === undefined ? {} : { failed }),
    cancelled: true, error: 'dweb-generation-retired',
  });
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
  /** @param {string} code @param {()=>Promise<any>} operation */
  const readBounded = (code, operation) => withDeadline(
    operation,
    messageTimeoutMs,
    () => new Error(code),
    setTimeoutFn,
    clearTimeoutFn,
  );
  /** @param {any} message */
  const sendBounded = async (message) => {
    try {
      return await readBounded('dweb-reseed-host-timeout', () => sendMessage(message));
    } catch (cause) {
      const causeMessage = /** @type {Error} */ (cause)?.message;
      const code = causeMessage === 'dweb-reseed-host-timeout'
        ? causeMessage : 'dweb-reseed-host-disconnected';
      throw Object.assign(new Error(code, { cause }), { code, outcomeKnown: false });
    }
  };
  const reconstructRelease = async (/** @type {any} */ app) => {
    const { dweb } = app;
    const oid = dweb.source_git_oid;
    if (oid == null) return {};
    if (!repositories?.snapshot || typeof oid !== 'string' || !/^[a-f0-9]{40}$/.test(oid)
        || dweb.git_oid !== oid) {
      throw new Error('signed release lineage cannot be reconstructed safely');
    }
    const entryFile = typeof dweb.release_entry_file === 'string'
      ? dweb.release_entry_file : app.entryFile;
    const fileKinds = dweb.release_file_kinds && typeof dweb.release_file_kinds === 'object'
      ? dweb.release_file_kinds : (app.fileKinds ?? {});
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
        previousVersionId: typeof dweb.previous_version_id === 'string'
          ? dweb.previous_version_id : null,
        gitCommitOid: oid,
        changelog: typeof dweb.changelog === 'string' ? dweb.changelog : '',
      },
      releaseSnapshot: {
        ok: true, oid, totalBytes,
        record: { name: app.name, entryFile, fileKinds: { ...fileKinds } },
        files,
      },
    };
  };
  /** @param {any} app */
  const reseedKind = (app) => {
    if (!app?.shared || typeof app.dweb?.hash !== 'string') return null;
    if (app.dweb.local === true && typeof app.dweb.slug === 'string'
        && Number.isFinite(app.dweb.manifest_created)) return 'local';
    return app.source === 'dweb' && app.dweb.seed_hash === app.dweb.hash
      && typeof app.dweb.uri === 'string' && typeof app.dweb.publisher === 'string'
      ? 'peer' : null;
  };
  /** @param {any} app */
  const reseedFingerprint = (app) => JSON.stringify([
    app.name, app.entryFile, app.fileKinds, app.dweb,
  ]);
  const reseed = async (/** @type {string} */ hostEpoch,
    /** @type {number} */ meshGeneration) => {
    const exact = () => generationCurrent(hostEpoch, meshGeneration);
    if (!active() || locked() || !exact()) {
      return retired();
    }
    let candidates;
    try {
      candidates = (await readBounded(
        'dweb-reseed-list-timeout', () => appRegistry.list(),
      )).filter((/** @type {any} */ app) => reseedKind(app));
    } catch (cause) {
      if (!exact()) {
        return retired();
      }
      log.warn('[kernel] dweb reseed listing failed', cause);
      return { ok: false, seeded: 0, error: 'dweb-reseed-list-failed' };
    }
    let seeded = 0;
    let failed = 0;
    let retryableRead = false;
    for (const candidate of candidates) {
      if (!exact()) {
        return retired(seeded, failed);
      }
      /** @type {any} */
      let prepared;
      let release;
      try {
        prepared = await readBounded(
          'dweb-reseed-read-timeout', () => appRegistry.get(candidate.id),
        );
        const kind = reseedKind(prepared);
        if (!kind) continue;
        release = await readBounded('dweb-reseed-release-timeout', async () => {
          if (kind === 'local') return reconstructRelease(prepared);
          const seedBundle = await readSeedBundle(prepared.id, prepared.dweb.hash);
          if (!seedBundle) throw new Error('dweb-seed-bundle-missing');
          return { seedBundle, seedUri: prepared.dweb.uri, seedPublisher: prepared.dweb.publisher };
        });
      } catch (cause) {
        if (!exact()) {
          return retired(seeded, failed);
        }
        failed += 1;
        const error = /** @type {Error} */ (cause);
        if (reseedKind(candidate) === 'peer' && error?.message !== 'dweb-seed-bundle-missing') retryableRead = true;
        log.debug('[kernel] dweb reseed preparation failed', candidate.id, cause);
        continue;
      }
      if (!exact()) {
        return retired(seeded, failed);
      }
      const preparedFingerprint = reseedFingerprint(prepared);
      try {
        const outcome = await withDwebReseedPublication((/** @type {()=>boolean} */ current) => {
          return withAppLifecycle(candidate.id, async () => {
            if (!current() || !exact()) return 'retired';
            const app = await readBounded(
              'dweb-reseed-read-timeout', () => appRegistry.get(candidate.id),
            );
            if (!current() || !exact() || !active() || locked()
                || !reseedKind(app)) return 'skipped';
            if (reseedFingerprint(app) !== preparedFingerprint) return 'retry';
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
              reseedAttemptId: newId(),
              ...release,
            });
            if (!current() || !exact()) return 'retired';
            if (reply?.outcomeKnown === false) {
              throw Object.assign(new Error(reply.error ?? 'dweb-reseed-outcome-unknown'), {
                code: reply.code ?? 'dweb-reseed-outcome-unknown', outcomeKnown: false,
              });
            }
            if (typeof reply?.ok !== 'boolean') {
              throw Object.assign(new Error('dweb-reseed-host-reply-invalid'), {
                code: 'dweb-reseed-host-reply-invalid', outcomeKnown: false,
              });
            }
            return reply?.ok === true ? 'seeded' : 'failed';
          });
        }, {
          timeoutMs: messageTimeoutMs * 2,
          hostEpoch,
          setTimeoutFn,
          clearTimeoutFn,
        });
        if (outcome === 'seeded') seeded += 1;
        else if (outcome === 'failed' || outcome === 'retry') failed += 1;
        else if (outcome === 'retired') {
          return retired(seeded, failed);
        }
      } catch (cause) {
        if (!exact()) {
          return retired(seeded, failed);
        }
        failed += 1;
        log.debug('[kernel] dweb reseed failed', candidate.id, cause);
      }
    }
    return failed > 0
      ? { ok: false, seeded, failed, error: retryableRead ? 'dweb-reseed-read-failed' : 'dweb-reseed-partial' }
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
      return Promise.resolve(retired());
    }
    if (liveHostEpoch === event.hostEpoch && Number(meshGeneration) < liveMeshGeneration) {
      return Promise.resolve(retired());
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
