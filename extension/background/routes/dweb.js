// @ts-check
// Gate dependency-injected dweb routes by build and user settings.

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any, sender?: import('webextension-polyfill').Runtime.MessageSender) => Promise<any>>}
 */
export const makeDwebRoutes = (deps) => {
  const {
    vault, auditLog, kv, ensureOffscreen, browser,
    appRegistry, appClient, appTabTracker, appQuiescence, settingsStore, shareLocalApp,
    DWEB_ENABLED, APP_TAB_GROUP_TITLE,
    disableDweb, withDwebPublication, withAppLifecycle, ensureSettingsReady, repositories,
    isOffscreenSender, createDwebRollbackGuard, appReleaseDescriptorMatches, getCurrentSessionId,
  } = deps;
  const rollbackGuard = createDwebRollbackGuard({ kv });
  /** @param {string} appId */
  const updateConflict = (appId) => ({
    ok: false,
    error: 'local-changes',
    requiresAction: true,
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

  // why: Cold workers fail closed until stored settings load.
  const dwebOn = () => DWEB_ENABLED && settingsStore.get().dwebEnabled;
  const dwebReady = async () => {
    if (!DWEB_ENABLED) return false;
    try { await ensureSettingsReady(); }
    catch { return false; }
    return dwebOn();
  };
  /** @param {any} entry */
  const auditCommittedChange = async (entry) => {
    try { await auditLog.append(entry); return null; }
    catch (error) {
      console.warn('[sw/dweb] committed App change could not be audited', error);
      return 'audit-write-failed';
    }
  };

  return {
    'dweb/app-authority-generations': async (_msg, sender) => {
      if (isOffscreenSender?.(sender) !== true) return { ok: false, error: 'offscreen-sender-required' };
      try { return { ok: true, generations: await appTabTracker.dwebGenerationSnapshot() }; }
      catch (error) { return { ok: false, error: /** @type {{ message?: string }} */ (error)?.message ?? String(error) }; }
    },

    // why: Persist verified lineage before an offscreen restart can erase it.
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
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
      if (typeof appId !== 'string') return { ok: false, error: 'appId-required' };
      try {
        // why: The caller owns lifecycle, so only flush before the snapshot.
        return await appQuiescence.runUnlocked(appId, async () => ({
          ok: true,
          ...(await appClient.snapshotFilesBase64({ appId })),
        }));
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },

    // why: All security events use one audit log.
    'dweb/audit': async ({ type, details }) => {
      if (!DWEB_ENABLED) return { ok: false, error: 'dweb-disabled' };
      if (typeof type !== 'string' || !type.startsWith('dweb_')) {
        return { ok: false, error: 'bad-type' };
      }
      await auditLog.append({ type, details });
      return { ok: true };
    },

    // Store only bundles that the offscreen caller already verified.
    'dweb/app-install': async ({ appId, name, files, entryFile, fileKinds, dweb }, sender) => {
      if (isOffscreenSender?.(sender) !== true) return { ok: false, error: 'offscreen-sender-required' };
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
      if (typeof appId !== 'string' || !appId.startsWith('app-')) {
        return { ok: false, error: 'appId-required' };
      }
      let record = null;
      let createdAppId = null;
      try {
        const admitted = await admitTrackedVersion(dweb);
        if (!admitted.ok) return { ok: false, error: admitted.error };
        record = await appClient.create({ appId, name, files, entryFile, fileKinds, dweb, source: 'dweb' });
        createdAppId = record.id;
        const repository = await repositories.statusApp(record.id);
        // why: Local Git history and signed publisher lineage differ.
        record = await appRegistry.update(record.id, { dweb: {
          git_oid: repository.oid,
          release_entry_file: record.entryFile,
          release_file_kinds: { ...(record.fileKinds ?? {}) },
        } });
        if (!record) throw new Error('app disappeared while recording install lineage');
        const auditWarning = await auditCommittedChange({
          type: 'dweb_app_installed',
          details: { appId: record.id, uri: dweb?.uri ?? null, publisher: dweb?.publisher ?? null },
        });
        return { ok: true, app: record, ...(auditWarning ? { warning: auditWarning } : {}) };
      } catch (e) {
        if (createdAppId) await appClient.delete(createdAppId).catch(() => {});
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },

    // Replace every release file so removed files cannot shadow the verified update.
    'dweb/app-update': async ({ appId, files, entryFile, fileKinds, dweb, strategy, conflictToken }, sender) => {
      if (isOffscreenSender?.(sender) !== true) return { ok: false, error: 'offscreen-sender-required' };
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
      if (typeof appId !== 'string') return { ok: false, error: 'appId-required' };
      const resolvesConflict = strategy === 'replace' || strategy === 'fork';
      if (resolvesConflict && (!Number.isSafeInteger(conflictToken) || conflictToken < 0)) {
        return { ok: false, error: 'update-conflict-token-required' };
      }
      try {
        return await withDwebPublication((/** @type {() => boolean} */ isCurrent) => withAppLifecycle(appId, async () => {
          if (!isCurrent() || !dwebOn()) return { ok: false, error: 'dweb-disabled' };
          // why: Quiesce the editor before one locked check, fork, and replacement.
          return appQuiescence.runUnlocked(appId, () => appClient.withWriteLock(appId, async () => {
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

          let fork = null;
          if (diverged && strategy === 'fork') {
            const opfs = appClient.opfsForApp(appId);
            /** @type {Record<string, Uint8Array>} */
            const localFiles = Object.create(null);
            for (const file of await opfs.list()) {
              const path = file.path.replace(/^\/+/, '');
              localFiles[path] = await opfs.readBytes(path);
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
              if (fork?.id) await appClient.delete(fork.id).catch(() => {});
              throw error;
            }
          }

          const committed = await appClient.replaceVersionedFilesUnlocked({
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
          });
          const auditWarning = await auditCommittedChange({
            type: 'dweb_app_updated',
            details: { appId, uri: dweb?.uri ?? null, version_id: dweb?.version_id ?? null },
          });
          return {
            ok: true,
            app: committed.record,
            cleanupHashes,
            ...(fork ? { fork: { id: fork.id, name: fork.name } } : {}),
            ...(auditWarning ? { warning: auditWarning } : {}),
          };
        }), {
          close: true,
          invalidateDweb: true,
          ...(resolvesConflict ? { expectedDwebGeneration: conflictToken } : {}),
        });
        }));
      } catch (e) {
        if ((/** @type {{name?:string}} */ (e))?.name === 'AppDwebAuthorityChangedError') {
          return updateConflict(appId);
        }
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },

    // why: Persist served hashes so replacement and deletion can revoke them.
    'dweb/app-record-served': async ({ appId, uri, hash }, sender) => {
      if (isOffscreenSender?.(sender) !== true) return { ok: false, error: 'offscreen-sender-required' };
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
      if (typeof appId !== 'string' || typeof hash !== 'string' || typeof uri !== 'string') {
        return { ok: false, error: 'appId-uri-hash-required' };
      }
      try {
        const record = await appRegistry.get(appId);
        if (!record) return { ok: false, error: 'app-not-found' };
        const previousHash = record.dweb?.room_hash ?? null;
        const updated = await appRegistry.update(appId, {
          shared: true,
          dweb: { ...(record.dweb ?? {}), room_hash: hash, room_uri: uri },
        });
        if (!updated) return { ok: false, error: 'app-not-found' };
        return { ok: true, previousHash };
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },

    // Store the page-provided seed because the worker cannot load its module.
    'dweb/open-commons': async ({ seed, room, url } = {}) => {
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
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
          if (!seed.files || typeof seed.files !== 'object') return { ok: false, error: 'seed-files-required' };
          rec = await appClient.create({ ...seed, ...(ownerSessionId ? { sessionId: ownerSessionId } : {}) });
          await auditLog.append({ type: 'dweb_seed_installed', details: { appId: rec.id } });
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
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
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
          if (!seed.files || typeof seed.files !== 'object') return { ok: false, error: 'seed-files-required' };
          const rec = await appClient.create(seed);
          await auditLog.append({ type: 'dweb_seed_installed', details: { appId: rec.id } });
        }
        await kv.set('dweb.seededApps', { ...seeded, [seedKey]: true });
        return { ok: true, created: !existing };
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },

    // A distinct host type prevents the worker from catching its own relay.
    'dweb/base/start': async () => {
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
      return withDwebPublication(async (/** @type {() => boolean} */ isCurrent) => {
        if (!isCurrent() || !dwebOn()) return { ok: false, error: 'dweb-disabled' };
        await ensureOffscreen();
        return browser.runtime.sendMessage({ type: 'dweb/base-host/start' });
      });
    },
    // why: The kill switch must work after the preference becomes false.
    'dweb/base/stop': async () => {
      if (!DWEB_ENABLED) return { ok: false, error: 'dweb-disabled' };
      return disableDweb();
    },
    'dweb/base/status': async () => {
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
      await ensureOffscreen();
      return browser.runtime.sendMessage({ type: 'dweb/base-host/status' });
    },
    'dweb/base/announce': async ({ record } = {}) => {
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
      await ensureOffscreen();
      return browser.runtime.sendMessage({ type: 'dweb/base-host/announce', record });
    },
    'dweb/base/find': async ({ dwappId, publisherDid } = {}) => {
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
      await ensureOffscreen();
      return browser.runtime.sendMessage({ type: 'dweb/base-host/find', dwappId, publisherDid });
    },

    // why: Reshares reuse the stored namespace identity.
    'dweb/base/share-app': async ({ appId, slug } = {}) => {
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
      return shareLocalApp(appId, slug);
    },
    'dweb/base/heard': async () => {
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
      await ensureOffscreen();
      return browser.runtime.sendMessage({ type: 'dweb/base-host/heard' });
    },
    // The offscreen host verifies peer bytes before this storage route runs.
    'dweb/base/install': async ({ uri, name, dwappId, slug, seq } = {}) => {
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
      return withDwebPublication(async (/** @type {() => boolean} */ isCurrent) => {
        if (!isCurrent() || !dwebOn()) return { ok: false, error: 'dweb-disabled' };
        await ensureOffscreen();
        return browser.runtime.sendMessage({ type: 'dweb/base-host/install-app', uri, name, dwappId, slug, seq });
      });
    },
    // Match installed lineage to newer verified announcements.
    'dweb/base/updates': async () => {
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
      if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
      try {
        const apps = await appRegistry.list();
        const tracked = apps.filter((/** @type {any} */ a) => a.dweb?.dwapp_id && a.dweb?.version_id);
        if (!tracked.length) return { ok: true, updates: {} };
        await ensureOffscreen();
        const heard = await browser.runtime.sendMessage({ type: 'dweb/base-host/heard' });
        const cards = new Map((heard?.apps ?? []).map((/** @type {any} */ c) => [c.dwapp_id, c]));
        /** @type {Record<string, any>} */
        const updates = {};
        for (const a of tracked) {
          const card = cards.get(a.dweb.dwapp_id);
          if (card?.version_id && card.version_id !== a.dweb.version_id && (card.seq ?? 0) > (a.dweb.seq ?? 0)) {
            updates[a.id] = { uri: card.uri, version_id: card.version_id, seq: card.seq, name: card.name, slug: card.slug ?? a.dweb.slug ?? null, dwapp_id: a.dweb.dwapp_id, publisher: card.publisher ?? null, previous_version_id: card.previous_version_id ?? null, git_commit_oid: card.git_commit_oid ?? null, changelog: card.changelog ?? '' };
          }
        }
        return { ok: true, updates };
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },
    // The offscreen host verifies the update before replacement.
    'dweb/base/update-app': async ({ appId, uri, name, strategy, conflictToken } = {}) => {
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
      if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
      if (typeof appId !== 'string' || typeof uri !== 'string') return { ok: false, error: 'appId-and-uri-required' };
      const resolvesConflict = strategy === 'replace' || strategy === 'fork';
      if (resolvesConflict && (!Number.isSafeInteger(conflictToken) || conflictToken < 0)) {
        return { ok: false, error: 'update-conflict-token-required' };
      }
      const launch = await withDwebPublication(async (/** @type {() => boolean} */ isCurrent) => {
        if (!isCurrent() || !dwebOn()) return { ok: false, error: 'dweb-disabled' };
        const record = await appRegistry.get(appId);
        if (!record) return { ok: false, error: 'app-not-found' };
        const expectedDwappId = record.dweb?.dwapp_id;
        const expectedPublisher = record.dweb?.publisher;
        if (typeof expectedDwappId !== 'string' || !expectedDwappId
            || typeof expectedPublisher !== 'string' || !expectedPublisher) {
          return { ok: false, error: 'app-update-identity-missing' };
        }
        await ensureOffscreen();
        if (!isCurrent() || !dwebOn()) return { ok: false, error: 'dweb-disabled' };
        return { ok: true, reply: browser.runtime.sendMessage({
          type: 'dweb/base-host/update-app', appId, uri, name,
          expectedDwappId,
          expectedPublisher,
          ...(resolvesConflict ? { strategy, conflictToken } : {}),
        }) };
      });
      if (!launch.ok) return launch;
      const reply = await launch.reply;
      if (!reply?.ok || !Array.isArray(reply.cleanupHashes)
          || !Array.isArray(reply.pendingUnserveHashes)) return reply;

      const warnings = new Set(Array.isArray(reply.warnings) ? reply.warnings : []);
      if (reply.warning) warnings.add(reply.warning);
      try {
        const updated = await withDwebPublication(() => withAppLifecycle(appId, async () => {
          const current = await appRegistry.get(appId);
          if (!current) return null;
          const failed = new Set(reply.pendingUnserveHashes.filter((/** @type {unknown} */ hash) => typeof hash === 'string'));
          const cleaned = new Set(reply.cleanupHashes.filter((/** @type {unknown} */ hash) => typeof hash === 'string' && !failed.has(hash)));
          const pending = [...new Set((Array.isArray(current.dweb?.pending_seed_unserve_hashes)
            ? current.dweb.pending_seed_unserve_hashes
            : []).filter((/** @type {unknown} */ hash) => typeof hash === 'string' && !cleaned.has(hash)))];
          const nextDweb = { ...(current.dweb ?? {}) };
          if (pending.length) nextDweb.pending_seed_unserve_hashes = pending;
          else delete nextDweb.pending_seed_unserve_hashes;
          return appRegistry.update(appId, { dwebExact: nextDweb });
        }));
        if (!updated) return { ...reply, ok: false, error: 'app-not-found' };
        reply.app = updated;
      } catch {
        // why: Keep stale handles so later cleanup can retry.
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
    },
    // why: A hash-bound join stays in the same mutation lane as verification.
    'dweb/base/room': async (msg = {}, sender) => {
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
      const { type: _t, bridgeAppId, bridgeAppHash, bridgeAppForked, bridgeAppGeneration, ...args } = msg;
      const senderAppId = appTabTracker.parseIdFromUrl?.(sender?.tab?.url);
      const senderTabId = sender?.tab?.id;
      if (!senderAppId || senderTabId == null || bridgeAppId !== senderAppId) return { ok: false, error: 'app-identity-changed' };
      if (args.op !== 'leave') {
        try { await appTabTracker.dwebGenerationsReady(); }
        catch { return { ok: false, error: 'app-authority-unavailable' }; }
      }
      const ownsTab = () => senderTabId === appTabTracker.getTabId(senderAppId);
      const current = () => ownsTab() && Number.isSafeInteger(bridgeAppGeneration)
        && bridgeAppGeneration === (appTabTracker.getDwebGeneration?.(senderAppId) ?? 0);
      if (!Number.isSafeInteger(bridgeAppGeneration) || bridgeAppGeneration < 0) return { ok: false, error: 'app-identity-changed' };
      const relay = (extra = {}) => browser.runtime.sendMessage({
        type: 'dweb/base-host/room', ...args,
        roomOwnerId: `app:${senderAppId}:${senderTabId}:${bridgeAppGeneration}`,
        roomOwnerAppId: senderAppId,
        roomOwnerGeneration: bridgeAppGeneration,
        ...extra,
      });
      if (args.op === 'leave') {
        await ensureOffscreen();
        return relay();
      }
      return withDwebPublication(async (/** @type {() => boolean} */ isCurrent) => {
        if (!isCurrent() || !dwebOn()) return { ok: false, error: 'dweb-disabled' };
        await ensureOffscreen();
        if (!ownsTab()) return { ok: false, error: 'app-identity-changed' };
        const authorized = () => isCurrent() && dwebOn() && current();
        if (!authorized()) return { ok: false, error: 'app-identity-changed' };
        if (args.op === 'publish-app') {
          if (args.appId !== senderAppId) return { ok: false, error: 'app-identity-changed' };
          return withAppLifecycle(senderAppId, () => appQuiescence.runUnlocked(senderAppId, async () => {
            const roomSnapshot = { ok: true, ...(await appClient.snapshotFilesBase64({ appId: senderAppId })) };
            return appClient.withWriteLock(senderAppId,
              () => authorized() ? relay({ roomSnapshot }) : { ok: false, error: 'app-identity-changed' });
          }));
        }
        return appClient.withWriteLock(senderAppId, async () => {
          if (!authorized()) return { ok: false, error: 'app-identity-changed' };
          if (args.op === 'join') {
            const record = await appRegistry.get(senderAppId);
            const hash = record?.dweb?.hash;
            const exact = typeof hash === 'string' && typeof record.dweb.git_oid === 'string'
              && appReleaseDescriptorMatches(record)
              && await repositories.matches({ kind: 'app', id: senderAppId }, { at: record.dweb.git_oid, excludeAppData: true }).catch(() => false);
            if (!record || !authorized()
                || (hash != null && (typeof hash !== 'string' || bridgeAppHash !== hash
                  || typeof bridgeAppForked !== 'boolean' || exact === bridgeAppForked))) {
              return { ok: false, error: 'app-identity-changed' };
            }
          }
          return relay();
        });
      });
    },
    // Read state without starting the base host.
    'dweb/distributed/info': async () => {
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
      await ensureOffscreen();
      return browser.runtime.sendMessage({ type: 'dweb/base-host/info' });
    },
  };
};
