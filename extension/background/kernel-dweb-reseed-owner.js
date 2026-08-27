// @ts-check
// Reconstruct durable local shares after one exact dweb host generation starts.

import { toBase64 } from '../shared/bundle/bytes.js';
import { withDeadline } from '../shared/cold-util.js';

/** @param {any} deps */
export const createKernelDwebReseedOwner = ({
  active, locked, appRegistry, withDwebReseedPublication, withAppLifecycle,
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
        throw Object.assign(new Error('dweb-reseed-host-timeout'), {
          code: 'dweb-reseed-host-timeout', outcomeKnown: false,
        });
      }
      const cause = /** @type {any} */ (outcome)?.cause;
      if (cause) {
        throw Object.assign(new Error('dweb-reseed-host-disconnected', { cause }), {
          code: 'dweb-reseed-host-disconnected', outcomeKnown: false,
        });
      }
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
  /** @param {any} value */
  const stableFileKinds = (value) => value && typeof value === 'object'
    ? Object.entries(value).sort(([left], [right]) => left.localeCompare(right)) : [];
  /** @param {any} app */
  const reseedFingerprint = (app) => JSON.stringify({
    id: app?.id,
    name: app?.name,
    entryFile: app?.entryFile,
    fileKinds: stableFileKinds(app?.fileKinds),
    dweb: {
      local: app?.dweb?.local,
      slug: app?.dweb?.slug,
      manifestCreated: app?.dweb?.manifest_created,
      hash: app?.dweb?.hash,
      seq: app?.dweb?.seq,
      description: app?.dweb?.description,
      sourceGitOid: app?.dweb?.source_git_oid,
      gitOid: app?.dweb?.git_oid,
      previousVersionId: app?.dweb?.previous_version_id,
      changelog: app?.dweb?.changelog,
      releaseEntryFile: app?.dweb?.release_entry_file,
      releaseFileKinds: stableFileKinds(app?.dweb?.release_file_kinds),
    },
  });
  const reseed = async (/** @type {string} */ hostEpoch,
    /** @type {number} */ meshGeneration) => {
    const exact = () => generationCurrent(hostEpoch, meshGeneration);
    if (!active() || locked() || !exact()) {
      return { ok: false, seeded: 0, cancelled: true, error: 'dweb-generation-retired' };
    }
    let candidates;
    try {
      candidates = (await readBounded(
        'dweb-reseed-list-timeout', () => appRegistry.list(),
      )).filter((/** @type {any} */ app) => app.shared
        && app.dweb?.local === true && typeof app.dweb?.slug === 'string'
        && Number.isFinite(app.dweb?.manifest_created) && typeof app.dweb?.hash === 'string');
    } catch (cause) {
      if (!exact()) {
        return { ok: false, seeded: 0, cancelled: true, error: 'dweb-generation-retired' };
      }
      log.warn('[kernel] dweb reseed listing failed', cause);
      return { ok: false, seeded: 0, error: 'dweb-reseed-list-failed' };
    }
    let seeded = 0;
    let failed = 0;
    for (const candidate of candidates) {
      if (!exact()) {
        return { ok: false, seeded, failed, cancelled: true, error: 'dweb-generation-retired' };
      }
      /** @type {any} */
      let prepared;
      let release;
      try {
        prepared = await readBounded(
          'dweb-reseed-read-timeout', () => appRegistry.get(candidate.id),
        );
        if (!prepared?.shared || prepared.dweb?.local !== true
            || typeof prepared.dweb?.slug !== 'string'
            || !Number.isFinite(prepared.dweb?.manifest_created)
            || typeof prepared.dweb?.hash !== 'string') continue;
        release = await readBounded(
          'dweb-reseed-release-timeout', () => reconstructRelease(prepared),
        );
      } catch (cause) {
        if (!exact()) {
          return { ok: false, seeded, failed, cancelled: true, error: 'dweb-generation-retired' };
        }
        failed += 1;
        log.debug('[kernel] dweb reseed preparation failed', candidate.id, cause);
        continue;
      }
      if (!exact()) {
        return { ok: false, seeded, failed, cancelled: true, error: 'dweb-generation-retired' };
      }
      const preparedFingerprint = reseedFingerprint(prepared);
      try {
        const outcome = await withDwebReseedPublication((/** @type {()=>boolean} */ current) =>
          withAppLifecycle(candidate.id, async () => {
            if (!current() || !exact()) return 'retired';
            const app = await readBounded(
              'dweb-reseed-read-timeout', () => appRegistry.get(candidate.id),
            );
            if (!current() || !exact() || !active() || locked()
                || !app?.shared || app.dweb?.local !== true
                || typeof app.dweb?.slug !== 'string'
                || !Number.isFinite(app.dweb?.manifest_created)
                || typeof app.dweb?.hash !== 'string') return 'skipped';
            if (reseedFingerprint(app) !== preparedFingerprint) return 'retry';
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
          }), {
          timeoutMs: messageTimeoutMs * 2,
          hostEpoch,
          setTimeoutFn,
          clearTimeoutFn,
        });
        if (outcome === 'seeded') seeded += 1;
        else if (outcome === 'failed' || outcome === 'retry') failed += 1;
        else if (outcome === 'retired') {
          return { ok: false, seeded, failed, cancelled: true, error: 'dweb-generation-retired' };
        }
      } catch (cause) {
        if (!exact()) {
          return { ok: false, seeded, failed, cancelled: true, error: 'dweb-generation-retired' };
        }
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
