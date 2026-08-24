// @ts-check
// background/routes/dweb.js — the dweb message routes (preview channel only).
//
// Every route is inert unless BOTH the build carries the module (DWEB_ENABLED)
// AND the user turned the setting on (settingsStore.get().dwebEnabled) — the SW
// stays the enforcement point; hidden UI is not a gate. Unblocked by the
// settings store. The mesh itself lives in the offscreen doc; these routes
// ensure it exists and relay to its dweb/base-host/* handler.
//
// BOUNDARY: this file names NO dweb-module path (it relays string message types
// + uses appClient/vault), so it crosses no module boundary and ships inert in
// the store package, same as when these routes were inline. (Do not write the
// hyphenated module-dir name here — the store-artifact verifier greps for that
// literal string in every shipped file.)
// Every privileged collaborator is injected.

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
  // Production supplies the custody-aware lease seam. Retain the former
  // injected host initializer only as a pure-test/migration fallback.
  const ensureFeature = typeof ensureDwebFeature === 'function'
    ? ensureDwebFeature : deps.ensureOffscreen;
  const rollbackGuard = createDwebRollbackGuard({ kv });

  /**
   * Public discovery installs carry a complete stream tuple. Cold URI/private
   * room installs carry neither dwapp_id nor seq and remain intentionally
   * untracked. A partial tuple is never silently downgraded to untracked.
   * @param {any} dweb
   */
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
   * minted by the outer kernel operation. Pure legacy fixtures may omit the
   * getter; production always supplies it.
   * @param {unknown} claim
   */
  const publicationCurrent = (claim) => typeof dwebPublicationGeneration !== 'function'
    || (Number.isSafeInteger(claim) && claim === dwebPublicationGeneration());
  /** @param {unknown} claim */
  const dwebStorageReady = async (claim) => publicationCurrent(claim)
    && await dwebReady()
    && publicationCurrent(claim);
  /** @param {any} entry */
  const auditCommittedChange = async (entry) => {
    try { await auditLog.append(entry); return null; }
    catch (error) {
      console.warn('[sw/dweb] committed App change could not be audited', error);
      return 'audit-write-failed';
    }
  };

  return {
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
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
      if (typeof appId !== 'string') return { ok: false, error: 'appId-required' };
      try {
        // Room publication already owns withAppLifecycle while the offscreen
        // host calls back for these bytes. Freeze and flush before snapshotting;
        // do not re-enter that lifecycle lane from the callback.
        return await appQuiescence.runUnlocked(appId, async () => ({
          ok: true,
          ...(await appClient.snapshotFilesBase64({ appId })),
        }));
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },

    // Dweb pages append their security events to the ONE audit log
    // (ARCHITECTURE §7: no new logging subsystem; new event types only).
    'dweb/audit': async ({ type, details }) => {
      if (!DWEB_ENABLED) return { ok: false, error: 'dweb-disabled' };
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
    'dweb/app-install': async ({ appId, name, files, entryFile, fileKinds, dweb, publicationGeneration }, sender) => {
      if (isOffscreenSender?.(sender) !== true) return { ok: false, error: 'offscreen-sender-required' };
      if (!(await dwebStorageReady(publicationGeneration))) return { ok: false, error: 'dweb-custody-changed' };
      if (typeof appId !== 'string' || !appId.startsWith('app-')) {
        return { ok: false, error: 'appId-required' };
      }
      let record = null;
      let createdAppId = null;
      try {
        const admitted = await admitTrackedVersion(dweb);
        if (!admitted.ok) return { ok: false, error: admitted.error };
        if (!publicationCurrent(publicationGeneration) || !dwebOn()) {
          return { ok: false, error: 'dweb-custody-changed' };
        }
        record = await appClient.create({ appId, name, files, entryFile, fileKinds, dweb, source: 'dweb' });
        createdAppId = record.id;
        if (!publicationCurrent(publicationGeneration) || !dwebOn()) {
          throw new Error('dweb-custody-changed');
        }
        const repository = await repositories.statusApp(record.id);
        // Local history and signed publisher provenance are different lineages:
        // git_oid is our safe-update baseline; source_git_oid came from the peer.
        record = await appRegistry.update(record.id, { dweb: { git_oid: repository.oid } });
        if (!record) throw new Error('app disappeared while recording install lineage');
        if (!publicationCurrent(publicationGeneration) || !dwebOn()) {
          throw new Error('dweb-custody-changed');
        }
        const auditWarning = await auditCommittedChange({
          type: 'dweb_app_installed',
          details: { appId: record.id, uri: dweb?.uri ?? null, publisher: dweb?.publisher ?? null },
        });
        if (!publicationCurrent(publicationGeneration) || !dwebOn()) {
          throw new Error('dweb-custody-changed');
        }
        return { ok: true, app: record, ...(auditWarning ? { warning: auditWarning } : {}) };
      } catch (e) {
        if (createdAppId) await appClient.delete(createdAppId).catch(() => {});
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },

    // Overwrite an INSTALLED app's files in place with a newer verified version
    // (the storage arm of dweb/base/update-app; verification happened offscreen).
    // why replace-not-merge: a new version may DROP files, so we clear the app's
    // OPFS dir first, then write the new set — otherwise stale files linger and can
    // shadow the new entry. The dweb slot is MERGED so version_id/uri/seq advance
    // while publisher/slug/dwapp_id stay put. The open tab reloads to show the update.
    'dweb/app-update': async ({ appId, files, entryFile, fileKinds, dweb, strategy, publicationGeneration }, sender) => {
      if (isOffscreenSender?.(sender) !== true) return { ok: false, error: 'offscreen-sender-required' };
      if (!(await dwebStorageReady(publicationGeneration))) return { ok: false, error: 'dweb-custody-changed' };
      if (typeof appId !== 'string') return { ok: false, error: 'appId-required' };
      try {
        // The App editor writes OPFS directly from its tab. Quiesce that host,
        // then serialize every SW-side writer through the same per-App lock so
        // the divergence check, optional fork, and replacement are one mutation.
        // The initiating base/update route already owns withAppLifecycle, so this
        // storage callback uses the non-reentrant form.
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
          if (!publicationCurrent(publicationGeneration) || !dwebOn()) {
            return { ok: false, error: 'dweb-custody-changed' };
          }

          const repository = await repositories.statusApp(appId);
          const diverged = !rec.dweb?.git_oid
            || repository.oid !== rec.dweb.git_oid
            || !await repositories.matches({ kind: 'app', id: appId }, { at: rec.dweb.git_oid });
          if (diverged && strategy !== 'replace' && strategy !== 'fork') {
            return {
              ok: false,
              error: 'local-changes',
              requiresAction: true,
              currentOid: repository.oid,
              baseOid: rec.dweb?.git_oid ?? null,
            };
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
            try {
              fork = await appClient.create({
                name: `${rec.name}: local fork`,
                files: localFiles,
                fileKinds: rec.fileKinds ?? {},
                entryFile: rec.entryFile,
                tags: [...new Set([...(rec.tags || []), 'fork'])],
                // Preserve the runtime capability, but detach the fork from the
                // upstream publisher's update stream.
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

          let auditWarning = null;
          let commitFinalized = false;
          const committed = await appClient.replaceVersionedFilesUnlocked({
            appId,
            files: files || {},
            entryFile,
            fileKinds,
            message: `update from dweb ${dweb?.version_id?.slice?.(0, 10) ?? ''}`,
            metadataForOid: (/** @type {string | null} */ oid, /** @type {any} */ oldRecord) => ({
              ...(dweb && typeof dweb === 'object' ? {
                dweb: {
                  ...dweb,
                  git_oid: oid,
                  published_hashes: [...new Set([
                    ...(oldRecord.dweb?.published_hashes ?? []),
                    ...(typeof dweb.hash === 'string' ? [dweb.hash] : []),
                  ])],
                },
              } : {}),
            }),
            isCurrent: () => publicationCurrent(publicationGeneration) && dwebOn(),
            afterCommit: async () => {
              commitFinalized = true;
              if (!publicationCurrent(publicationGeneration) || !dwebOn()) {
                throw new Error('dweb-custody-changed');
              }
              auditWarning = await auditCommittedChange({
                type: 'dweb_app_updated',
                details: { appId, uri: dweb?.uri ?? null, version_id: dweb?.version_id ?? null },
              });
              if (!publicationCurrent(publicationGeneration) || !dwebOn()) {
                throw new Error('dweb-custody-changed');
              }
            },
          });
          // Compatibility for injected clients that predate the transactional
          // hook (pure tests and downstream embedders). The production client
          // always runs afterCommit while rollback is still possible.
          if (!commitFinalized) {
            auditWarning = await auditCommittedChange({
              type: 'dweb_app_updated',
              details: { appId, uri: dweb?.uri ?? null, version_id: dweb?.version_id ?? null },
            });
          }
          return {
            ok: true,
            app: committed.record,
            ...(fork ? { fork: { id: fork.id, name: fork.name } } : {}),
            ...(auditWarning ? { warning: auditWarning } : {}),
          };
        }), { close: true });
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },

    // A dwapp can publish its current App into a room after explicit consent.
    // Persist the latest room-published hash so replacement and deletion can
    // revoke every version this node still serves.
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

    // Install (first run) the commons seed app and open it — optionally
    // straight into a room (`#<appId>?room=…`). `seed` comes FROM the page (the
    // SW can't load the dweb module); the SW only checks the registry, stores
    // via appClient, and opens the tab. `seed` is { name, files, entryFile, dweb }.
    'dweb/open-commons': async ({ seed, room, url } = {}) => {
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
      const seedKey = seed?.dweb?.seed;
      // Bound the page-supplied key: it's used to dedupe + persisted in app
      // metadata, so a short plain string only (the real cap on file size
      // lives in appClient.create). 64 is generous for 'commons'-class keys.
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

    // Ensure a seed app (e.g. commons) is present in the Library WITHOUT opening
    // it — the Home/Library page calls this once. why a once-ever flag, not just
    // dedupe-by-seed: a user who DELETES the app must not have it silently
    // re-seeded on the next Library open.
    'dweb/ensure-seed-app': async ({ seed } = {}) => {
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
      const seedKey = seed?.dweb?.seed;
      if (typeof seedKey !== 'string' || !seedKey || seedKey.length > 64) {
        return { ok: false, error: 'seed-required' };
      }
      try {
        // One-time rename migration: a seed install created under the legacy
        // display name (name === key, e.g. 'commons') is renamed to the current
        // seed name. Gated on name === seedKey so a user's OWN rename is never
        // clobbered; runs before the once-ever flag so already-seeded installs
        // still pick up the new name; idempotent (won't re-fire once renamed).
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

    // The always-on BASE NETWORK (S1b) lives in the OFFSCREEN document. These
    // routes ensure the offscreen doc exists, then forward to its
    // dweb/base-host/* handler. Distinct type so the SW's own dispatcher doesn't
    // re-catch the forward.
    'dweb/base/start': async () => {
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
      return withDwebPublication(async (/** @type {() => boolean} */ isCurrent) => {
        if (!isCurrent() || !dwebOn()) return { ok: false, error: 'dweb-disabled' };
        await ensureFeature();
        return browser.runtime.sendMessage({ type: 'dweb/base-host/start' });
      });
    },
    // The master OFF — the user-facing kill switch, symmetric to start
    // (docs/specs/FEATURE-FIRST-CLASS-MESSAGING.md §2). Persist the preference
    // FIRST so it won't auto-restart on the next unlock (maybeStartBaseNetwork
    // gates on dwebEnabled), then tear down a live host. NOT gated on dwebOn():
    // we must be able to stop precisely as we flip the setting off. Gated only on
    // DWEB_ENABLED — the store package prunes this module entirely.
    'dweb/base/stop': async () => {
      if (!DWEB_ENABLED) return { ok: false, error: 'dweb-disabled' };
      return disableDweb();
    },
    'dweb/base/status': async () => {
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
      await ensureFeature();
      return browser.runtime.sendMessage({ type: 'dweb/base-host/status' });
    },
    'dweb/base/announce': async ({ record } = {}) => {
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
      await ensureFeature();
      return browser.runtime.sendMessage({ type: 'dweb/base-host/announce', record });
    },
    'dweb/base/find': async ({ dwappId, publisherDid } = {}) => {
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
      await ensureFeature();
      return browser.runtime.sendMessage({ type: 'dweb/base-host/find', dwappId, publisherDid });
    },

    // --- THE DWEB APP STORE ---
    // Share a local app: read its files (the same OPFS read as export), then have
    // the offscreen base host publish the signed bundle + announce it. A RESHARE
    // reuses the stored slug — the namespace is locked once chosen so the
    // dwapp_id stays stable. On success we persist the version identity.
    'dweb/base/share-app': async ({ appId, slug } = {}) => {
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
      return shareLocalApp(appId, slug);
    },
    // Discover: what peers have announced (gossip cache + DHT hits).
    'dweb/base/heard': async () => {
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
      await ensureFeature();
      return browser.runtime.sendMessage({ type: 'dweb/base-host/heard' });
    },
    // Install a discovered app: the offscreen fetches its signed bundle over the
    // base mesh, verifies it, and persists it. The card's version identity rides
    // along so the installed record can be matched against future announces.
    'dweb/base/install': async ({ uri, name, dwappId, slug, seq } = {}) => {
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
      return withDwebPublication(async (/** @type {() => boolean} */ isCurrent) => {
        if (!isCurrent() || !dwebOn()) return { ok: false, error: 'dweb-disabled' };
        await ensureFeature();
        const reply = await browser.runtime.sendMessage({
          type: 'dweb/base-host/install-app', uri, name, dwappId, slug, seq,
          publicationGeneration: typeof dwebPublicationGeneration === 'function'
            ? dwebPublicationGeneration() : undefined,
        });
        if (!isCurrent() || !dwebOn()) {
          return {
            ok: false, error: 'dweb-custody-changed', outcomeKnown: false,
            installedAppId: reply?.app?.id ?? null,
          };
        }
        return reply;
      });
    },
    // Which installed dweb apps have a NEWER version announced? Cross-reference the
    // local catalog against the offscreen discovery Library (the heard cards).
    // Returns a map keyed by local appId. Best-effort + read-only.
    'dweb/base/updates': async () => {
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
      if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
      try {
        const apps = await appRegistry.list();
        const tracked = apps.filter((/** @type {any} */ a) => a.dweb?.dwapp_id && a.dweb?.version_id);
        if (!tracked.length) return { ok: true, updates: {} };
        await ensureFeature();
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
    // Update an installed app in place to a newer announced version: the offscreen
    // refetches + verifies the new bundle and the SW overwrites the existing app's
    // files. The user keeps ONE copy that just updates.
    'dweb/base/update-app': async ({ appId, uri, name, strategy } = {}) => {
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
      if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
      if (typeof appId !== 'string' || typeof uri !== 'string') return { ok: false, error: 'appId-and-uri-required' };
      return withDwebPublication((/** @type {() => boolean} */ isCurrent) => withAppLifecycle(appId, async () => {
        if (!isCurrent() || !dwebOn()) return { ok: false, error: 'dweb-disabled' };
        const record = await appRegistry.get(appId);
        if (!record) return { ok: false, error: 'app-not-found' };
        const expectedDwappId = record.dweb?.dwapp_id;
        const expectedPublisher = record.dweb?.publisher;
        if (typeof expectedDwappId !== 'string' || !expectedDwappId
            || typeof expectedPublisher !== 'string' || !expectedPublisher) {
          return { ok: false, error: 'app-update-identity-missing' };
        }
        await ensureFeature();
        const reply = await browser.runtime.sendMessage({
          type: 'dweb/base-host/update-app', appId, uri, name,
          publicationGeneration: typeof dwebPublicationGeneration === 'function'
            ? dwebPublicationGeneration() : undefined,
          expectedDwappId,
          expectedPublisher,
          previousHash: record.dweb?.hash ?? null,
          pendingHashes: Array.isArray(record.dweb?.pending_seed_unserve_hashes)
            ? record.dweb.pending_seed_unserve_hashes
            : [],
          ...(strategy === 'replace' || strategy === 'fork' ? { strategy } : {}),
        });
        if (!isCurrent() || !dwebOn()) {
          return { ok: false, error: 'dweb-custody-changed', outcomeKnown: false };
        }
        if (!reply?.ok || !Array.isArray(reply.pendingUnserveHashes)) return reply;

        const warnings = new Set(Array.isArray(reply.warnings) ? reply.warnings : []);
        if (reply.warning) warnings.add(reply.warning);
        const current = await appRegistry.get(appId);
        if (!current) return { ...reply, ok: false, error: 'app-not-found' };
        const nextDweb = { ...(current.dweb ?? {}) };
        if (reply.pendingUnserveHashes.length) {
          nextDweb.pending_seed_unserve_hashes = [...new Set(reply.pendingUnserveHashes)];
        } else {
          delete nextDweb.pending_seed_unserve_hashes;
        }
        try {
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
    // A dwapp room op (join/leave/publish/subscribe/dm/presence/history/…) — one
    // thin relay to the offscreen base host. Events flow back to the app-tab
    // directly as `dweb/base-room/event` runtime messages, so the SW only
    // carries the request/response.
    'dweb/base/room': async (msg = {}, sender = {}) => {
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
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
        ...args
      } = msg;
      return withDwebPublication(async (/** @type {() => boolean} */ isCurrent) => {
        if (!isCurrent() || !dwebOn()) return { ok: false, error: 'dweb-disabled' };
        await ensureFeature();
        const relay = () => browser.runtime.sendMessage({
          type: 'dweb/base-host/room', ...args,
          appDocumentId: senderDocumentId,
          appTabId: senderTabId,
          publicationGeneration: typeof dwebPublicationGeneration === 'function'
            ? dwebPublicationGeneration() : undefined,
        });
        if (args.op === 'publish-app' && typeof args.appId === 'string') {
          return withAppLifecycle(args.appId, relay);
        }
        return relay();
      });
    },
    // The READ surface behind peerd.distributed.{whoami,status,peers,presence} in
    // a Notebook. Side-effect-free: it reports the base host's CURRENT state with
    // rosters; it never STARTS the lobby (maybeStartBaseNetwork does, on unlock).
    'dweb/distributed/info': async () => {
      if (!(await dwebReady())) return { ok: false, error: 'dweb-disabled' };
      await ensureFeature();
      return browser.runtime.sendMessage({ type: 'dweb/base-host/info' });
    },
  };
};
