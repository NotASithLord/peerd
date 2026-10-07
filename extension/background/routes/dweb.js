// @ts-check
// Gate dependency-injected dweb routes by build and user settings.

import { userPeerPolicy } from '../dweb-peer-policy.js';
import { withDeadline } from '/shared/cold-util.js';
import { finiteEffectReceiptFields } from '../host-effect-verdict.js';
import { appReleaseDescriptorMatches } from '/shared/app-dweb-identity.js';

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any, sender?: import('webextension-polyfill').Runtime.MessageSender) => Promise<any>>}
 */
export const makeDwebRoutes = (deps) => {
  const {
    vault, auditLog, kv, ensureDwebFeature, browser,
    appRegistry, appClient, appTabTracker, appQuiescence, settingsStore, shareLocalApp,
    DWEB_ENABLED, APP_TAB_GROUP_TITLE,
    disableDweb, withDwebPublication, withAppLifecycle, ensureSettingsReady, repositories,
    isOffscreenSender, createDwebRollbackGuard, getCurrentSessionId,
    dwebPublicationGeneration, ensureAppTrackerReady,
  } = deps;
  if (typeof ensureDwebFeature !== 'function'
      || typeof dwebPublicationGeneration !== 'function') {
    throw new TypeError('dweb route custody dependencies are required');
  }
  const ensureFeature = ensureDwebFeature;
  const rollbackGuard = createDwebRollbackGuard({ kv });
  /** @param {string} appId */
  const updateConflict = (appId) => ({
    ok: false, error: 'local-changes', requiresAction: true,
    conflictToken: appTabTracker.getDwebGeneration(appId),
  });

  /** Refuse partial discovery lineage. @param {any} dweb */
  const trackedVersion = (dweb) => {
    const trackingClaimed = dweb?.dwapp_id != null || dweb?.seq != null;
    if (!trackingClaimed) return { ok: true, candidate: null };
    if (typeof dweb?.dwapp_id !== 'string'
        || typeof dweb?.publisher !== 'string'
        || !Number.isSafeInteger(dweb?.seq)
        || typeof dweb?.version_id !== 'string') {
      return { ok: false, error: 'dweb-version-metadata-invalid' };
    }
    return {
      ok: true,
      candidate: {
        dwappId: dweb.dwapp_id,
        publisher: dweb.publisher,
        seq: dweb.seq,
        versionId: dweb.version_id,
      },
    };
  };

  /** @param {any} dweb */
  const admitTrackedVersion = async (dweb) => {
    const tracked = trackedVersion(dweb);
    if (!tracked.ok || !tracked.candidate) return tracked;
    const result = await rollbackGuard.admit(tracked.candidate);
    return result.accepted === true
      ? { ok: true, candidate: tracked.candidate }
      : { ok: false, error: result.error ?? 'dweb-version-refused' };
  };

  // why: host transport loss does not cancel an already-dispatched SW write.
  // Keep storage custody here until commit/rollback settles, independent of its
  // caller. Unknown rollback receipts remain fenced even when the catalog is empty.
  /** @type {Set<Promise<any>>} */ const installCallbacks = new Set();
  /** @type {Set<string>} */ const unknownInstalls = new Set();
  const dwebDisabled = () => ({ ok: false, error: 'dweb-disabled' });
  const custodyChanged = () => ({ ok: false, error: 'dweb-custody-changed' });

  // Cold workers expose channel defaults until persisted settings hydrate.
  // Effectful/read routes fail closed if that hydration is still unavailable.
  const dwebOn = () => DWEB_ENABLED && settingsStore.get().dwebEnabled && !vault.isLocked();
  const dwebReady = async () => {
    if (!DWEB_ENABLED) return false;
    try { await ensureSettingsReady(); }
    catch { return false; }
    return dwebOn();
  };
  /**
   * Storage callbacks are accepted only for the exact publication generation
   * minted by the outer kernel operation.
   * @param {unknown} claim
   */
  const publicationCurrent = (claim) => Number.isSafeInteger(claim)
    && claim === dwebPublicationGeneration();
  /** @param {unknown} claim */
  const publicationActive = (claim) => publicationCurrent(claim) && dwebOn();
  /** @param {() => boolean} isCurrent */
  const publicationClaim = (isCurrent) => {
    if (!isCurrent() || !dwebOn()) return null;
    const generation = dwebPublicationGeneration();
    return isCurrent() && dwebOn() && publicationCurrent(generation) ? generation : null;
  };
  /** @param {(isCurrent:()=>boolean)=>Promise<any>} operation @param {boolean} [acquire] */
  const withReadyPublication = async (operation, acquire = true) => {
    if (!(await dwebReady())) return dwebDisabled();
    return withDwebPublication(async (/** @type {() => boolean} */ isCurrent) => {
      if (publicationClaim(isCurrent) == null) return custodyChanged();
      if (acquire) await ensureFeature();
      if (publicationClaim(isCurrent) == null) return custodyChanged();
      return operation(isCurrent);
    });
  };
  /** @param {string} op @param {any} [payload] */
  const readyHost = (op, payload = {}) => withReadyPublication(() =>
    browser.runtime.sendMessage({ type: `dweb/base-host/${op}`, ...payload }));
  // why: both install paths retain the same revocation receipt and storage fence.
  /** @param {string} type @param {any} payload @param {()=>boolean} isCurrent @param {boolean} [installed] */
  const publicationReply = async (type, payload, isCurrent, installed = false) => {
    const generation = publicationClaim(isCurrent);
    if (generation == null) return custodyChanged();
    const reply = await browser.runtime.sendMessage({
      type, ...payload,
      publicationGeneration: generation,
    });
    if (!isCurrent() || !dwebOn()) {
      return {
        ...custodyChanged(), outcomeKnown: false,
        ...(installed ? { installedAppId: reply?.app?.id ?? null } : {}),
      };
    }
    return reply;
  };
  /** @param {string} action @param {any} address */
  const addressOperation = async (action, address) => {
    if (typeof address !== 'string' || address.length > 4096 || !(await dwebReady())) {
      return { ok: false, error: 'invalid-address-or-network-off' };
    }
    const generation = dwebPublicationGeneration();
    // No ensure/acquire here: absent custody refuses parsing instead of starting it.
    let parsed;
    try { parsed = await withDeadline(() => browser.runtime.sendMessage({
      type: 'dweb/base-host/parse-address', address,
    }), 2000, () => new Error('address-parse-timeout')); }
    catch { return { ok: false, error: 'address-host-unavailable' }; }
    if (parsed?.ok !== true || parsed.address !== address) return { ok: false, error: 'address-not-supported' };
    return withReadyPublication(async (/** @type {()=>boolean} */ isCurrent) => {
      if (!publicationCurrent(generation)) return custodyChanged();
      const uri = `peerd://did:key:${address.slice(16)}`;
      if (action === 'install') {
        await Promise.allSettled([...installCallbacks]);
        const existing = (await appRegistry.list()).find((/** @type {any} */ app) =>
          app.dweb?.uri === uri && app.dweb?.hash === address.slice(-64)
          && app.dweb?.publisher === uri.slice(8, -65));
        if (existing) {
          unknownInstalls.delete(uri);
          return publicationReply('dweb/base-host/install-address', { address, existing }, isCurrent, true);
        }
        if (unknownInstalls.has(uri)) return { ok: false, error: 'install-outcome-unknown', outcomeKnown: false };
      }
      if (publicationClaim(isCurrent) == null || !publicationCurrent(generation)) return custodyChanged();
      await ensureFeature();
      if (!isCurrent() || !publicationCurrent(generation)) return custodyChanged();
      return publicationReply(`dweb/base-host/${action}-address`, { address }, isCurrent, action === 'install');
    }, false);
  };
  /** @param {unknown} claim */
  const dwebStorageRefusal = async (claim) => {
    if (!DWEB_ENABLED) return dwebDisabled();
    if (!publicationCurrent(claim)) return custodyChanged();
    if (!(await dwebReady())) return dwebDisabled();
    return publicationCurrent(claim)
      ? null : custodyChanged();
  };
  /** @param {unknown} error */
  const failureResult = (error) => {
    const value = /** @type {any} */ (error);
    return {
      ok: false, error: value?.message ?? String(error),
      ...(typeof value?.code === 'string' ? { code: value.code } : {}),
      ...finiteEffectReceiptFields(value),
    };
  };
  /** @param {{id?:string}|null} fork @param {unknown} cause */
  const throwAfterForkRollback = async (fork, cause) => {
    if (!fork?.id) throw cause;
    try {
      if (await appClient.delete(fork.id) !== true) throw new Error('fork cleanup refused');
    } catch (cleanupCause) {
      throw Object.assign(new AggregateError(
        [cause, cleanupCause], 'dweb update failed and its local fork could not be removed',
      ), {
        code: 'dweb-update-fork-rollback-incomplete',
        performed: true, outcomeKnown: false,
        outcomeKind: 'host-lost', retryable: false,
      });
    }
    throw cause;
  };
  /** @param {any} entry */
  const auditCommittedChange = async (entry) => {
    try { await auditLog.append(entry); return null; }
    catch (error) {
      console.warn('[sw/dweb] committed App change could not be audited', error);
      return 'audit-write-failed';
    }
  };

  // Storage callbacks share admission and error receipts without re-entering
  // the publication lane held by their initiating offscreen operation.
  /** @param {(message:any)=>Promise<any>} operation @param {boolean} [conflictAware] */
  const storageRoute = (operation, conflictAware = false) => async (/** @type {any} */ message, /** @type {any} */ sender) => {
    if (isOffscreenSender?.(sender) !== true) return { ok: false, error: 'offscreen-sender-required' };
    const refusal = await dwebStorageRefusal(message.publicationGeneration);
    if (refusal) return refusal;
    try {
      return message.dweb?.publisher
        ? await userPeerPolicy(kv).withPublisher(message.dweb.publisher, () => operation(message))
        : await operation(message);
    }
    catch (error) {
      if (conflictAware && /** @type {{name?:string}} */ (error)?.name === 'AppDwebAuthorityChangedError') {
        return updateConflict(message.appId);
      }
      return failureResult(error);
    }
  };
  /** @param {any} seed @param {string|null} [sessionId] */
  const createSeedApp = async (seed, sessionId = null) => {
    if (!seed.files || typeof seed.files !== 'object') throw new Error('seed-files-required');
    const record = await appClient.create(sessionId ? { ...seed, sessionId } : seed);
    await auditLog.append({ type: 'dweb_seed_installed', details: { appId: record.id } });
    return record;
  };

  /** @type {ReturnType<typeof makeDwebRoutes>} */
  const routes = {
    'dweb/peer-policy': async (_message, sender) => {
      if (isOffscreenSender?.(sender) !== true) return { ok: false, error: 'offscreen-sender-required' };
      if (!(await dwebReady())) return dwebDisabled();
      try { return { ok: true, policy: await userPeerPolicy(kv).snapshot(), discoveryEnabled: settingsStore.get().dwebDiscoveryEnabled === true }; }
      catch (error) { return failureResult(error); }
    },
    'dweb/app-authority-generations': async (_msg, sender) => {
      if (isOffscreenSender?.(sender) !== true) return { ok: false, error: 'offscreen-sender-required' };
      if (!DWEB_ENABLED) return dwebDisabled();
      try { return { ok: true, generations: await appTabTracker.dwebGenerationSnapshot() }; }
      catch (error) { return failureResult(error); }
    },
    // The offscreen discovery host calls this only after signature + shape +
    // derived-id verification. Persist BEFORE its in-memory Library accepts the
    // card, so tearing that host down cannot erase the anti-rollback decision.
    'dweb/meta-admit': async ({ dwappId, publisher, seq, versionId }, sender) => {
      if (isOffscreenSender?.(sender) !== true) return { ok: false, accepted: false, error: 'offscreen-sender-required' };
      if (!(await dwebReady())) return { ok: false, accepted: false, error: 'dweb-disabled' };
      try { return await rollbackGuard.admit({ dwappId, publisher, seq, versionId }); }
      catch (error) {
        return { ok: false, accepted: false, error: /** @type {{ message?: string }} */ (error)?.message ?? String(error) };
      }
    },

    'dweb/app-snapshot': async ({ appId }, sender) => {
      if (isOffscreenSender?.(sender) !== true) return { ok: false, error: 'offscreen-sender-required' };
      if (!(await dwebReady())) return dwebDisabled();
      if (typeof appId !== 'string') return { ok: false, error: 'appId-required' };
      try {
        // why: The caller owns lifecycle, so only flush before the snapshot.
        return await appQuiescence.runUnlocked(appId, async () => ({
          ok: true,
          ...(await appClient.snapshotFilesBase64({ appId })),
        }));
      } catch (e) {
        return failureResult(e);
      }
    },

    // why: All security events use one audit log.
    'dweb/audit': async ({ type, details }) => {
      if (!DWEB_ENABLED) return dwebDisabled();
      if (typeof type !== 'string' || !type.startsWith('dweb_')) {
        return { ok: false, error: 'bad-type' };
      }
      await auditLog.append({ type, details });
      return { ok: true };
    },

    // Install a VERIFIED bundle as an engine App. The verification happened
    // in the calling page (fetchBundle + installAppBundle); this route is
    // the storage arm. Files cross runtime messaging as JSON-safe base64
    // envelopes, then appClient applies the same byte limits as local imports.
    'dweb/app-install': storageRoute(async ({ appId, name, files, entryFile, fileKinds, dweb, publicationGeneration }) => {
      if (typeof appId !== 'string' || !appId.startsWith('app-')) {
        return { ok: false, error: 'appId-required' };
      }
      let record = null;
      let createdAppId = null;
      try {
        const admitted = await admitTrackedVersion(dweb);
        if (!admitted.ok) return { ok: false, error: admitted.error };
        if (!publicationActive(publicationGeneration)) {
          return custodyChanged();
        }
        record = await appClient.create({ appId, name, files, entryFile, fileKinds, dweb, source: 'dweb' });
        createdAppId = record.id;
        if (!publicationActive(publicationGeneration)) {
          throw new Error('dweb-custody-changed');
        }
        const repository = await repositories.statusApp(record.id);
        // Local history and signed publisher provenance are different lineages:
        // git_oid is our safe-update baseline; source_git_oid came from the peer.
        record = await appRegistry.update(record.id, { dweb: {
          git_oid: repository.oid,
          release_entry_file: record.entryFile,
          release_file_kinds: { ...(record.fileKinds ?? {}) },
        } });
        if (!record) throw new Error('app disappeared while recording install lineage');
        if (!publicationActive(publicationGeneration)) {
          throw new Error('dweb-custody-changed');
        }
        const auditWarning = await auditCommittedChange({
          type: 'dweb_app_installed',
          details: { appId: record.id, uri: dweb?.uri ?? null, publisher: dweb?.publisher ?? null },
        });
        return { ok: true, app: record, ...(auditWarning ? { warning: auditWarning } : {}) };
      } catch (e) {
        if (createdAppId) {
          const removed = await appClient.delete(createdAppId).catch(() => false);
          if (removed !== true) return {
            ok: false, error: 'dweb-install-rollback-failed',
            performed: true, outcomeKnown: false,
            outcomeKind: 'host-lost', retryable: false,
          };
        }
        return failureResult(e);
      }
    }),

    // Overwrite an INSTALLED app's files in place with a newer verified version
    // (the storage arm of dweb/base/update-app; verification happened offscreen).
    // why replace-not-merge: a new version may DROP files, so we clear the app's
    // OPFS dir first, then write the new set; otherwise stale files linger and can
    // shadow the new entry. The dweb slot is MERGED so version_id/uri/seq advance
    // while publisher/slug/dwapp_id stay put. The open tab reloads to show the update.
    'dweb/app-update': storageRoute(async ({ appId, files, entryFile, fileKinds, dweb, strategy, conflictToken, publicationGeneration }) => {
      if (typeof appId !== 'string') return { ok: false, error: 'appId-required' };
      const resolvesConflict = strategy === 'replace' || strategy === 'fork';
      if (resolvesConflict && (!Number.isSafeInteger(conflictToken) || conflictToken < 0)) {
        return { ok: false, error: 'update-conflict-token-required' };
      }
      // why: The initiating base/update route already holds the publication
      // and App lifecycle lanes. Keep its generation fence and quiesce the
      // editor without re-entering those non-reentrant lanes from this callback.
      return await appQuiescence.runUnlocked(appId, () => appClient.withWriteLock(appId, async () => {
        const rec = await appRegistry.get(appId);
        if (!rec) return { ok: false, error: 'app-not-found' };
        if (typeof entryFile !== 'string') return { ok: false, error: 'entryFile-required' };
        if (rec.dweb?.publisher && dweb?.publisher !== rec.dweb.publisher) {
          return { ok: false, error: 'publisher-changed' };
        }
        if (rec.dweb?.dwapp_id && dweb?.dwapp_id !== rec.dweb.dwapp_id) {
          return { ok: false, error: 'dwapp-id-changed' };
        }
        if (Number.isSafeInteger(rec.dweb?.seq)
            && (!Number.isSafeInteger(dweb?.seq) || dweb.seq <= rec.dweb.seq)) {
          return { ok: false, error: 'dweb-version-not-newer' };
        }
        const admitted = await admitTrackedVersion(dweb);
        if (!admitted.ok) return { ok: false, error: admitted.error };
        if (!publicationActive(publicationGeneration)) {
          return custodyChanged();
        }

        const cleanupHashes = [...new Set([
          ...(Array.isArray(rec.dweb?.pending_seed_unserve_hashes) ? rec.dweb.pending_seed_unserve_hashes : []),
          ...(typeof rec.dweb?.hash === 'string' ? [rec.dweb.hash] : []),
        ].filter((hash) => typeof hash === 'string' && hash !== dweb?.hash))];
        const nextDweb = { ...(dweb ?? {}) };
        if (cleanupHashes.length) nextDweb.pending_seed_unserve_hashes = cleanupHashes;
        else delete nextDweb.pending_seed_unserve_hashes;
        const diverged = !rec.dweb?.git_oid
          || (typeof rec.dweb?.hash === 'string' && !appReleaseDescriptorMatches(rec))
          || !await repositories.matches({ kind: 'app', id: appId }, { at: rec.dweb.git_oid, excludeAppData: true });
        if (diverged && !resolvesConflict) return updateConflict(appId);
        if (!publicationActive(publicationGeneration)) {
          return custodyChanged();
        }

        let fork = null;
        if (diverged && strategy === 'fork') {
          const opfs = appClient.opfsForApp(appId);
          /** @type {Record<string, Uint8Array>} */
          const localFiles = Object.create(null);
          for (const file of await opfs.list()) {
            const path = file.path.replace(/^\/+/, '');
            localFiles[path] = await opfs.readBytes(path);
          }
          if (!publicationActive(publicationGeneration)) {
            return custodyChanged();
          }
          try {
            fork = await appClient.create({
              name: `${rec.name}: local fork`,
              files: localFiles,
              fileKinds: rec.fileKinds ?? {},
              entryFile: rec.entryFile,
              tags: [...new Set([...(rec.tags || []), 'fork'])],
              // why: A local fork must leave the publisher's update stream.
              dweb: {
                uri: null, publisher: null, hash: null, local: true,
                forked_from: {
                  publisher: rec.dweb?.publisher ?? null,
                  dwapp_id: rec.dweb?.dwapp_id ?? null,
                  version_id: rec.dweb?.version_id ?? null,
                },
              },
              source: 'local',
            });
            await repositories.fork(
              { kind: 'app', id: appId },
              { kind: 'app', id: fork.id },
            );
          } catch (error) {
            await throwAfterForkRollback(fork, error);
          }
        }

        let auditWarning = null;
        let committed;
        try {
          committed = await appClient.replaceVersionedFilesUnlocked({
            appId,
            files: files || {},
            entryFile,
            fileKinds,
            message: `update from dweb ${dweb?.version_id?.slice?.(0, 10) ?? ''}`,
            metadataForOid: (/** @type {string | null} */ oid, /** @type {any} */ oldRecord, /** @type {Record<string, 'text'|'binary'>} */ releaseFileKinds = {}) => ({
              ...(dweb && typeof dweb === 'object' ? {
                dweb: {
                  ...nextDweb,
                  git_oid: oid,
                  release_entry_file: entryFile,
                  release_file_kinds: { ...releaseFileKinds },
                  published_hashes: [...new Set([
                    ...(oldRecord.dweb?.published_hashes ?? []),
                    ...(typeof dweb.hash === 'string' ? [dweb.hash] : []),
                  ])],
                },
              } : {}),
            }),
            isCurrent: () => publicationActive(publicationGeneration),
            afterCommit: async () => {
              if (!publicationActive(publicationGeneration)) {
                throw new Error('dweb-custody-changed');
              }
              auditWarning = await auditCommittedChange({
                type: 'dweb_app_updated',
                details: { appId, uri: dweb?.uri ?? null, version_id: dweb?.version_id ?? null },
              });
            },
          });
        } catch (cause) {
          await throwAfterForkRollback(fork, cause);
        }
        return {
          ok: true,
          app: committed.record,
          cleanupHashes,
          ...(fork ? { fork: { id: fork.id, name: fork.name } } : {}),
          ...(auditWarning ? { warning: auditWarning } : {}),
        };
      }), {
        close: true, invalidateDweb: true,
        ...(resolvesConflict ? { expectedDwebGeneration: conflictToken } : {}),
      });

    }, true),

    // A dwapp can publish its current App into a room after explicit consent.
    // Persist the latest room-published hash so replacement and deletion can
    // revoke every version this node still serves.
    'dweb/app-record-served': storageRoute(async ({ appId, uri, hash, publicationGeneration }) => {
      if (typeof appId !== 'string' || typeof hash !== 'string' || typeof uri !== 'string') {
        return { ok: false, error: 'appId-uri-hash-required' };
      }
      const record = await appRegistry.get(appId);
      if (!record) return { ok: false, error: 'app-not-found' };
      if (!publicationActive(publicationGeneration)) {
        return custodyChanged();
      }
      const previousHash = record.dweb?.room_hash ?? null;
      const pendingUnserveHashes = [...new Set([
        ...(Array.isArray(record.dweb?.pending_room_unserve_hashes)
          ? record.dweb.pending_room_unserve_hashes : []),
        ...(previousHash && previousHash !== hash ? [previousHash] : []),
      ].filter((candidate) => typeof candidate === 'string' && candidate !== hash))];
      const nextDweb = { ...(record.dweb ?? {}), room_hash: hash, room_uri: uri };
      if (pendingUnserveHashes.length) {
        nextDweb.pending_room_unserve_hashes = pendingUnserveHashes;
      } else delete nextDweb.pending_room_unserve_hashes;
      const updated = await appRegistry.update(appId, {
        shared: true,
        dweb: nextDweb,
      });
      if (!updated) return { ok: false, error: 'app-not-found' };
      if (!publicationActive(publicationGeneration)) return {
        ...custodyChanged(),
        performed: true, outcomeKnown: false,
        outcomeKind: 'host-lost', retryable: false,
      };
      return { ok: true, pendingUnserveHashes };

    }),

    // Store the page-provided seed because the worker cannot load its module.
    'dweb/open-commons': async ({ seed, room, url } = {}) => {
      if (!(await dwebReady())) return dwebDisabled();
      const seedKey = seed?.dweb?.seed;
      // why: Bound the persisted deduplication key.
      if (typeof seedKey !== 'string' || !seedKey || seedKey.length > 64) {
        return { ok: false, error: 'seed-required' };
      }
      try {
        const ownerSessionId = typeof getCurrentSessionId === 'function'
          ? await getCurrentSessionId()
          : null;
        const apps = await appRegistry.list();
        let rec = apps.find((/** @type {any} */ a) => a.dweb?.seed === seedKey);
        if (!rec) {
          rec = await createSeedApp(seed, ownerSessionId);
        }
        const params = new URLSearchParams();
        if (typeof room === 'string' && room) params.set('room', room);
        if (typeof url === 'string' && url) params.set('url', url);
        if (ownerSessionId) params.set('owner', ownerSessionId);
        const suffix = params.size ? `?${params.toString()}` : '';
        await appTabTracker.ensureTab(rec.id, { active: true, groupTitle: APP_TAB_GROUP_TITLE, hashSuffix: suffix });
        return { ok: true, appId: rec.id };
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },

    // why: A durable flag prevents a deleted seed from returning.
    'dweb/ensure-seed-app': async ({ seed } = {}) => {
      if (!(await dwebReady())) return dwebDisabled();
      const seedKey = seed?.dweb?.seed;
      if (typeof seedKey !== 'string' || !seedKey || seedKey.length > 64) {
        return { ok: false, error: 'seed-required' };
      }
      try {
        // why: Rename only the legacy default, never a user name.
        if (typeof seed?.name === 'string' && seed.name && seed.name !== seedKey) {
          const legacy = (await appRegistry.list()).find((/** @type {any} */ a) => a.dweb?.seed === seedKey && a.name === seedKey);
          if (legacy) {
            await appRegistry.update(legacy.id, { name: seed.name });
            await auditLog.append({ type: 'dweb_seed_renamed', details: { appId: legacy.id, name: seed.name } });
          }
        }
        const seeded = (await kv.get('dweb.seededApps')) ?? {};
        if (seeded[seedKey]) return { ok: true, created: false }; // seeded once; respect deletion
        const apps = await appRegistry.list();
        const existing = apps.find((/** @type {any} */ a) => a.dweb?.seed === seedKey);
        if (!existing) {
          await createSeedApp(seed);
        }
        await kv.set('dweb.seededApps', { ...seeded, [seedKey]: true });
        return { ok: true, created: !existing };
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },

    // The always-on BASE NETWORK (S1b) lives in the OFFSCREEN document. These
    // routes ensure the offscreen doc exists, then forward to its
    // dweb/base-host/* handler. Distinct type so the SW's own dispatcher doesn't
    // re-catch the forward.
    'dweb/base/start': () => readyHost('start'),
    // The master OFF is the user-facing kill switch, symmetric to start
    // (docs/specs/FEATURE-FIRST-CLASS-MESSAGING.md §2). Persist the preference
    // FIRST so it won't auto-restart on the next unlock (maybeStartBaseNetwork
    // gates on dwebEnabled), then tear down a live host. NOT gated on dwebOn():
    // we must be able to stop precisely as we flip the setting off. Gated only on
    // DWEB_ENABLED; the store package prunes this module entirely.
    'dweb/base/stop': async () => {
      if (!DWEB_ENABLED) return dwebDisabled();
      return disableDweb();
    },
    'dweb/base/status': () => readyHost('status'),
    'dweb/base/announce': ({ record } = {}) => readyHost('announce', { record }),
    'dweb/base/find': ({ dwappId, publisherDid } = {}) => readyHost('find', { dwappId, publisherDid }),

    // why: Reshares reuse the stored namespace identity.
    'dweb/base/share-app': async ({ appId, slug } = {}) => {
      if (!(await dwebReady())) return dwebDisabled();
      return shareLocalApp(appId, slug);
    },
    // Discover: what peers have announced (gossip cache + DHT hits).
    'dweb/base/heard': () => readyHost('heard'),
    // Install a discovered app: the offscreen fetches its signed bundle over the
    // base mesh, verifies it, and persists it. The card's version identity rides
    // along so the installed record can be matched against future announces.
    'dweb/base/inspect-address': ({ address } = {}) => addressOperation('inspect', address),
    'dweb/base/install-address': ({ address } = {}) => addressOperation('install', address),
    'dweb/base/install': async ({ uri, name, dwappId, slug, seq } = {}) => {
      return withReadyPublication((isCurrent) => publicationReply('dweb/base-host/install-app',
        { uri, name, dwappId, slug, seq }, isCurrent, true));
    },
    // Match installed lineage to newer verified announcements.
    'dweb/base/updates': async () => {
      if (!DWEB_ENABLED) return dwebDisabled();
      if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
      return withReadyPublication(async () => {
        try {
          const apps = await appRegistry.list();
          const tracked = apps.filter((/** @type {any} */ a) =>
            a.dweb?.dwapp_id && a.dweb?.version_id);
          if (!tracked.length) return { ok: true, updates: {} };
          const heard = await browser.runtime.sendMessage({ type: 'dweb/base-host/heard' });
          const cards = new Map((heard?.apps ?? []).map(
            (/** @type {any} */ card) => [card.dwapp_id, card],
          ));
          /** @type {Record<string, any>} */
          const updates = {};
          for (const app of tracked) {
            const card = cards.get(app.dweb.dwapp_id);
            if (card?.version_id && card.version_id !== app.dweb.version_id
                && (card.seq ?? 0) > (app.dweb.seq ?? 0)) {
              updates[app.id] = {
                uri: card.uri, version_id: card.version_id, seq: card.seq,
                name: card.name, slug: card.slug ?? app.dweb.slug ?? null,
                dwapp_id: app.dweb.dwapp_id, publisher: card.publisher ?? null,
                previous_version_id: card.previous_version_id ?? null,
                git_commit_oid: card.git_commit_oid ?? null,
                changelog: card.changelog ?? '',
              };
            }
          }
          return { ok: true, updates };
        } catch (e) {
          return failureResult(e);
        }
      });
    },
    // Update an installed app in place to a newer announced version: the offscreen
    // refetches + verifies the new bundle and the SW overwrites the existing app's
    // files. The user keeps ONE copy that just updates.
    'dweb/base/update-app': async ({ appId, uri, name, strategy, conflictToken } = {}) => {
      if (!(await dwebReady())) return dwebDisabled();
      if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
      if (typeof appId !== 'string' || typeof uri !== 'string') return { ok: false, error: 'appId-and-uri-required' };
      return withReadyPublication((/** @type {() => boolean} */ isCurrent) => withAppLifecycle(appId, async () => {
        if (!isCurrent() || !dwebOn()) return dwebDisabled();
        const record = await appRegistry.get(appId);
        if (!record) return { ok: false, error: 'app-not-found' };
        const expectedDwappId = record.dweb?.dwapp_id;
        const expectedPublisher = record.dweb?.publisher;
        if (typeof expectedDwappId !== 'string' || !expectedDwappId
            || typeof expectedPublisher !== 'string' || !expectedPublisher) {
          return { ok: false, error: 'app-update-identity-missing' };
        }
        const reply = await publicationReply('dweb/base-host/update-app', {
          appId, uri, name, expectedDwappId, expectedPublisher,
          ...(strategy === 'replace' || strategy === 'fork' ? { strategy, conflictToken } : {}),
        }, isCurrent);
        if (!reply?.ok || !Array.isArray(reply.cleanupHashes)
            || !Array.isArray(reply.pendingUnserveHashes)) return reply;

        const warnings = new Set(Array.isArray(reply.warnings) ? reply.warnings : []);
        if (reply.warning) warnings.add(reply.warning);
        const current = await appRegistry.get(appId);
        if (!current) return { ...reply, ok: false, error: 'app-not-found' };
        const failed = new Set(reply.pendingUnserveHashes.filter((/** @type {unknown} */ hash) => typeof hash === 'string'));
        const cleaned = new Set(reply.cleanupHashes.filter((/** @type {unknown} */ hash) => typeof hash === 'string' && !failed.has(hash)));
        const pending = [...new Set((Array.isArray(current.dweb?.pending_seed_unserve_hashes)
          ? current.dweb.pending_seed_unserve_hashes
          : []).filter((/** @type {unknown} */ hash) => typeof hash === 'string' && !cleaned.has(hash)))];
        const nextDweb = { ...(current.dweb ?? {}) };
        if (pending.length) {
          nextDweb.pending_seed_unserve_hashes = pending;
        } else {
          delete nextDweb.pending_seed_unserve_hashes;
        }
        try {
          // why: This outer operation still owns the App lifecycle lane, so no
          // successor update can race this cleanup acknowledgement.
          const updated = await appRegistry.update(appId, { dwebExact: nextDweb });
          if (!updated) throw new Error('app-not-found');
          reply.app = updated;
        } catch {
          // The atomic version commit already retained the full cleanup list.
          // A stale handle is safe and lets the next update or delete retry.
          warnings.add('previous-version-cleanup-pending');
          reply.cleanupPending = true;
        }
        reply.warnings = [...warnings];
        if (reply.warnings.length) reply.warning = reply.warnings[0];
        else {
          delete reply.warning;
          delete reply.warnings;
        }
        return reply;
      }));
    },
    // A dwapp room op (join/leave/publish/subscribe/dm/presence/history/…) uses one
    // thin relay to the offscreen base host. Events flow back to the app-tab
    // directly as `dweb/base-room/event` runtime messages, so the SW only
    // carries the request/response.
    'dweb/base/room': async (msg = {}, sender = {}) => {
      if (!(await dwebReady())) return dwebDisabled();
      try { await ensureAppTrackerReady?.(); }
      catch { return { ok: false, error: 'app-room-owner-unavailable' }; }
      const senderTabId = sender?.tab?.id;
      const senderDocumentId = /** @type {{documentId?:unknown}} */ (sender)?.documentId;
      const appId = typeof msg.appId === 'string' ? msg.appId : '';
      const senderAppId = appTabTracker.parseIdFromUrl?.(sender?.url ?? sender?.tab?.url ?? '');
      if (!appId || senderAppId !== appId
          || !Number.isInteger(senderTabId)
          || appTabTracker.getTabId(appId) !== senderTabId
          || typeof senderDocumentId !== 'string'
          || senderDocumentId.length < 8 || senderDocumentId.length > 160) {
        return { ok: false, error: 'app-room-owner-mismatch' };
      }
      const {
        type: _t,
        appDocumentId: _claimedDocumentId,
        appTabId: _claimedTabId,
        appGeneration: _claimedGeneration,
        roomSnapshot: _claimedRoomSnapshot,
        releaseSnapshot: _claimedReleaseSnapshot,
        release: _claimedRelease,
        expectedHash: _claimedExpectedHash,
        created: _claimedCreated,
        bridgeAppId, bridgeAppHash, bridgeAppForked, bridgeAppGeneration,
        ...args
      } = msg;
      if (bridgeAppId !== appId || !Number.isSafeInteger(bridgeAppGeneration)
          || bridgeAppGeneration < 0) return { ok: false, error: 'app-identity-changed' };
      if (args.op !== 'leave') {
        try { await appTabTracker.dwebGenerationsReady(); }
        catch { return { ok: false, error: 'app-authority-unavailable' }; }
      }
      const identityCurrent = () => appTabTracker.getTabId(appId) === senderTabId
        && appTabTracker.getDwebGeneration(appId) === bridgeAppGeneration;
      return withReadyPublication(async (/** @type {() => boolean} */ isCurrent) => {
        const relay = async (extra = {}) => {
          const generation = publicationClaim(isCurrent);
          if (generation == null) return custodyChanged();
          const reply = await browser.runtime.sendMessage({
            type: 'dweb/base-host/room', ...args,
            appDocumentId: senderDocumentId,
            appTabId: senderTabId,
            appGeneration: bridgeAppGeneration,
            publicationGeneration: generation,
            ...extra,
          });
          if (args.op !== 'publish-app' || reply?.ok !== true
              || !Array.isArray(reply.pendingRoomUnserveHashes)) return reply;
          const record = await appRegistry.get(args.appId);
          if (!record || record.dweb?.room_hash !== reply.hash) {
            return { ...reply, warning: 'previous-version-cleanup-pending' };
          }
          const nextDweb = { ...record.dweb };
          if (reply.pendingRoomUnserveHashes.length) {
            nextDweb.pending_room_unserve_hashes = [...new Set(
              reply.pendingRoomUnserveHashes.filter(
                (/** @type {unknown} */ hash) => typeof hash === 'string',
              ),
            )];
          } else delete nextDweb.pending_room_unserve_hashes;
          try {
            if (!await appRegistry.update(args.appId, { dwebExact: nextDweb })) {
              throw new Error('app-not-found');
            }
          } catch {
            return { ...reply, warning: 'previous-version-cleanup-pending' };
          }
          return reply;
        };
        // why: token-bound leave compensation must finish even after rotation.
        if (args.op === 'leave') return relay();
        const authorized = () => isCurrent() && dwebOn() && identityCurrent();
        const holdIdentity = (/** @type {()=>Promise<any>} */ operation) =>
          appTabTracker.withDwebAuthority(appId, operation, { expectedGeneration: bridgeAppGeneration });
        try {
          if (args.op === 'publish-app') {
            // why: flush pending editor writes before acquiring consent. The
            // offscreen publication must use this trusted snapshot, not call
            // back into a save that needs the same authority lock.
            return await withAppLifecycle(appId, () => appQuiescence.runUnlocked(appId, async () => {
              const roomSnapshot = { ok: true, ...(await appClient.snapshotFilesBase64({ appId })) };
              return holdIdentity(() => appClient.withWriteLock(appId, async () =>
                authorized() ? relay({ roomSnapshot }) : { ok: false, error: 'app-identity-changed' }));
            }));
          }
          return await holdIdentity(() => appClient.withWriteLock(appId, async () => {
            if (!authorized()) return { ok: false, error: 'app-identity-changed' };
            if (args.op === 'join') {
              const record = await appRegistry.get(appId);
              const hash = record?.dweb?.hash;
              const exact = typeof hash === 'string' && typeof record.dweb.git_oid === 'string'
                && appReleaseDescriptorMatches(record)
                && await repositories.matches({ kind: 'app', id: appId },
                  { at: record.dweb.git_oid, excludeAppData: true }).catch(() => false);
              if (!record || !authorized()
                  || (hash != null && (typeof hash !== 'string' || bridgeAppHash !== hash
                    || typeof bridgeAppForked !== 'boolean' || exact === bridgeAppForked))) {
                return { ok: false, error: 'app-identity-changed' };
              }
            }
            return relay();
          }));
        } catch (error) {
          if (/** @type {{name?:string}} */ (error)?.name === 'AppDwebAuthorityChangedError') {
            return { ok: false, error: 'app-identity-changed' };
          }
          return failureResult(error);
        }
      });
    },
    // The READ surface behind peerd.distributed.{whoami,status,peers,presence} in
    // a Notebook. Side-effect-free: it reports the base host's CURRENT state with
    // rosters; it never STARTS the lobby (maybeStartBaseNetwork does, on unlock).
    'dweb/distributed/info': async () => withReadyPublication(async (isCurrent) => {
      const info = await browser.runtime.sendMessage({ type: 'dweb/base-host/info' })
        .catch(() => ({ ok: false, error: 'dweb-status-unavailable', running: false }));
      return publicationClaim(isCurrent) == null
        ? custodyChanged() : info;
    }, false),
  };
  const install = routes['dweb/app-install'];
  routes['dweb/app-install'] = (message, sender) => {
    if (installCallbacks.size + unknownInstalls.size >= 64) {
      return Promise.resolve({ ok: false, error: 'install-reconciliation-required' });
    }
    // Promise dispatch is deferred until ownership has been registered.
    const pending = Promise.resolve().then(() => install(message, sender)).then(result => {
      if (result?.ok !== true && (result?.outcomeKnown === false || result?.performed === true
          || ['effect-completed', 'host-lost', 'transport-lost'].includes(result?.outcomeKind))) {
        unknownInstalls.add(message.dweb?.uri);
      }
      return result;
    }, error => { unknownInstalls.add(message.dweb?.uri); throw error; })
      .finally(() => { installCallbacks.delete(pending); });
    installCallbacks.add(pending);
    return pending;
  };
  return routes;
};
