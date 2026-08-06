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
// Imports nothing (every collaborator injected, incl. DWEB_ENABLED + the two
// hardcoded names).

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any) => Promise<any>>}
 */
export const makeDwebRoutes = (deps) => {
  const {
    vault, auditLog, kv, ensureOffscreen, browser,
    appRegistry, appClient, appTabTracker, opfsHelpers, settingsStore,
    DWEB_ENABLED, DWEB_IDENTITY_SECRET, APP_TAB_GROUP_TITLE,
    onBaseNetworkStopped, repositories,
  } = deps;

  // The two-input gate every route shares (build flag + user setting).
  const dwebOn = () => DWEB_ENABLED && settingsStore.get().dwebEnabled;

  return {
    // Offscreen records the served hash before announcing its mutable card.
    // A worker restart can therefore revoke an interrupted publication.
    'dweb/publication-pending': async ({ appId, hash, slug, publisher, name } = {}) => {
      if (!dwebOn()) return { ok: false, error: 'dweb-disabled' };
      if (typeof appId !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) return { ok: false, error: 'invalid-publication-journal-entry' };
      const pending = (await kv.get('dweb.pendingPublications.v1')) ?? {};
      await kv.set('dweb.pendingPublications.v1', {
        ...pending,
        [appId]: { appId, hash, slug: slug ?? null, publisher: publisher ?? null, name: String(name || '').slice(0, 80) },
      });
      return { ok: true };
    },
    'dweb/publication-clear': async ({ appId, hash } = {}) => {
      const pending = (await kv.get('dweb.pendingPublications.v1')) ?? {};
      if (!pending[appId] || (hash && pending[appId].hash !== hash)) return { ok: true };
      const next = { ...pending };
      delete next[appId];
      await kv.set('dweb.pendingPublications.v1', next);
      return { ok: true };
    },
    // Persistent-identity storage for the room-hosting page. The MODULE CODE that
    // mints the Ed25519 material runs in the PAGE (app-tab, via loadDweb); the SW
    // only owns the vault and exposes these two routes scoped to the single
    // identity secret. The hardcoded name is store-safe (not the dweb module path).
    'dweb/identity-get': async () => {
      if (!dwebOn()) return { ok: false, error: 'dweb-disabled' };
      if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
      try {
        return { ok: true, value: await vault.getSecret(DWEB_IDENTITY_SECRET) };
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },
    'dweb/identity-set': async ({ value }) => {
      if (!dwebOn()) return { ok: false, error: 'dweb-disabled' };
      if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
      if (typeof value !== 'string') return { ok: false, error: 'value-required' };
      try {
        await vault.setSecret(DWEB_IDENTITY_SECRET, value);
        // Fires once, on first-run creation (the page only sets when get
        // returned null). did is not parsed SW-side — it shows on room-join.
        await auditLog.append({ type: 'dweb_identity_issued', details: {} });
        return { ok: true };
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
    // the storage arm. files is a path → text map, same shape sandbox_create
    // uses, same size ceiling enforced in appClient.
    'dweb/app-install': async ({ name, files, entryFile, dweb }) => {
      if (!dwebOn()) return { ok: false, error: 'dweb-disabled' };
      let record = null;
      try {
        record = await appClient.create({ name, files, entryFile, dweb, source: 'dweb' });
        const repository = await repositories.statusApp(record.id);
        // Local Git history and publisher Git provenance are distinct. git_oid
        // is OUR baseline commit for safe future update checks; source_git_oid
        // came from the signed release and is never trusted as local authority.
        record = await appRegistry.update(record.id, { dweb: { git_oid: repository.oid } });
        await auditLog.append({
          type: 'dweb_app_installed',
          details: { appId: record.id, uri: dweb?.uri ?? null, publisher: dweb?.publisher ?? null },
        });
        return { ok: true, app: record };
      } catch (e) {
        if (record?.id) await appClient.delete(record.id).catch(() => {});
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },

    // Overwrite an INSTALLED app's files in place with a newer verified version
    // (the storage arm of dweb/base/update-app; verification happened offscreen).
    // why replace-not-merge: a new version may DROP files, so we clear the app's
    // OPFS dir first, then write the new set — otherwise stale files linger and can
    // shadow the new entry. The dweb slot is MERGED so version_id/uri/seq advance
    // while publisher/slug/dwapp_id stay put. The open tab reloads to show the update.
    'dweb/app-update': async ({ appId, files, entryFile, dweb, strategy }) => {
      if (!dwebOn()) return { ok: false, error: 'dweb-disabled' };
      if (typeof appId !== 'string') return { ok: false, error: 'appId-required' };
      let reopen = false;
      try {
        // The App editor writes OPFS directly from its tab. Quiesce that host,
        // then serialize every SW-side writer through the same per-App lock so
        // the divergence check, optional fork, and replacement are one mutation.
        reopen = appTabTracker.getTabId(appId) != null;
        if (reopen) {
          await appTabTracker.closeTab(appId);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return await appClient.withWriteLock(appId, async () => {
        const rec = await appRegistry.get(appId);
        if (!rec) return { ok: false, error: 'app-not-found' };
        if (rec.dweb?.publisher && dweb?.publisher !== rec.dweb.publisher) {
          return { ok: false, error: 'publisher-changed' };
        }
        if (rec.dweb?.dwapp_id && dweb?.dwapp_id !== rec.dweb.dwapp_id) {
          return { ok: false, error: 'dwapp-id-changed' };
        }
        const opfs = appClient.opfsForApp(appId);
        /** @type {Record<string,string>} */ const previousFiles = Object.create(null);
        for (const f of await opfs.list()) {
          const path = f.path.replace(/^\/+/, '');
          previousFiles[path] = await opfs.read(path);
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
          /** @type {Record<string,string>} */ const localFiles = Object.create(null);
          for (const f of await opfs.list()) {
            const path = f.path.replace(/^\/+/, '');
            localFiles[path] = await opfs.read(path);
          }
          try {
            fork = await appClient.create({
              name: `${rec.name} — local fork`,
              files: localFiles,
              entryFile: rec.entryFile,
              tags: [...new Set([...(rec.tags || []), 'fork'])],
              // Keep the dweb runtime capability, but deliberately drop the
              // publisher/update identity: this is a new local lineage, not an
              // impersonation of the upstream release stream.
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
        // One repository transaction replaces the full tree and records the new
        // verified release. This removes stale nested directories too; a loop of
        // leaf deletes cannot handle file↔directory path changes safely.
        const committed = await repositories.replaceWorkingTree(
          { kind: 'app', id: appId },
          { files: files || {}, message: `update from dweb ${dweb?.version_id?.slice?.(0, 10) ?? ''}` },
        );
        let updated;
        try {
          updated = await appRegistry.update(appId, {
          ...(typeof entryFile === 'string' ? { entryFile } : {}),
          ...(dweb && typeof dweb === 'object' ? {
            dweb: {
              ...dweb,
              git_oid: committed.oid,
              published_hashes: [...new Set([
                ...(rec.dweb?.published_hashes ?? []),
                ...(typeof dweb.hash === 'string' ? [dweb.hash] : []),
              ])],
            },
          } : {}),
          });
          if (!updated) throw new Error('app disappeared while recording update lineage');
        } catch (error) {
          // Restore executable bytes before surfacing a metadata failure. The
          // rollback commit intentionally makes the old baseline look diverged
          // if registry persistence remains unavailable, so a retry cannot
          // silently overwrite state under the wrong lineage.
          await repositories.replaceWorkingTree(
            { kind: 'app', id: appId },
            { files: previousFiles, message: 'rollback failed dweb update' },
          );
          throw error;
        }
        appTabTracker.reloadTab(appId).catch(() => {});
        await auditLog.append({
          type: 'dweb_app_updated',
          details: { appId, uri: dweb?.uri ?? null, version_id: dweb?.version_id ?? null },
        });
        return { ok: true, app: updated, ...(fork ? { fork: { id: fork.id, name: fork.name } } : {}) };
        });
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      } finally {
        if (reopen) appTabTracker.ensureTab(appId, { active: false, groupTitle: APP_TAB_GROUP_TITLE }).catch(() => {});
      }
    },

    // Install (first run) the commons seed app and open it — optionally
    // straight into a room (`#<appId>?room=…`). `seed` comes FROM the page (the
    // SW can't load the dweb module); the SW only checks the registry, stores
    // via appClient, and opens the tab. `seed` is { name, files, entryFile, dweb }.
    'dweb/open-commons': async ({ seed, room, url } = {}) => {
      if (!dwebOn()) return { ok: false, error: 'dweb-disabled' };
      const seedKey = seed?.dweb?.seed;
      // Bound the page-supplied key: it's used to dedupe + persisted in app
      // metadata, so a short plain string only (the real cap on file size
      // lives in appClient.create). 64 is generous for 'commons'-class keys.
      if (typeof seedKey !== 'string' || !seedKey || seedKey.length > 64) {
        return { ok: false, error: 'seed-required' };
      }
      try {
        const apps = await appRegistry.list();
        let rec = apps.find((/** @type {any} */ a) => a.dweb?.seed === seedKey);
        if (!rec) {
          if (!seed.files || typeof seed.files !== 'object') return { ok: false, error: 'seed-files-required' };
          rec = await appClient.create(seed);
          await auditLog.append({ type: 'dweb_seed_installed', details: { appId: rec.id } });
        }
        const params = new URLSearchParams();
        if (typeof room === 'string' && room) params.set('room', room);
        if (typeof url === 'string' && url) params.set('url', url);
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
      if (!dwebOn()) return { ok: false, error: 'dweb-disabled' };
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
      if (!dwebOn()) return { ok: false, error: 'dweb-disabled' };
      await ensureOffscreen();
      return browser.runtime.sendMessage({ type: 'dweb/base-host/start' });
    },
    // The master OFF — the user-facing kill switch, symmetric to start
    // (docs/specs/FEATURE-FIRST-CLASS-MESSAGING.md §2). Persist the preference
    // FIRST so it won't auto-restart on the next unlock (maybeStartBaseNetwork
    // gates on dwebEnabled), then tear down a live host. NOT gated on dwebOn():
    // we must be able to stop precisely as we flip the setting off. Gated only on
    // DWEB_ENABLED — the store package prunes this module entirely.
    'dweb/base/stop': async () => {
      if (!DWEB_ENABLED) return { ok: false, error: 'dweb-disabled' };
      await settingsStore.update({ dwebEnabled: false });
      // Never SPAWN the offscreen just to stop it: if it isn't up, there is no
      // live network to tear down. The offscreen stop handler closes every room,
      // drops the mesh + lobby, and clears the re-sub timer (dweb-base.js).
      const contexts = await browser.runtime.getContexts({ contextTypes: /** @type {any} */ (['OFFSCREEN_DOCUMENT']) });
      if (contexts.length) await browser.runtime.sendMessage({ type: 'dweb/base-host/stop' });
      // The offscreen stop closed every room, incl. the agent inbox — clear any
      // SW-side membership flag so a later restart re-joins cleanly.
      try { onBaseNetworkStopped?.(); } catch { /* best-effort */ }
      return { ok: true, running: false };
    },
    'dweb/base/status': async () => {
      if (!dwebOn()) return { ok: false, error: 'dweb-disabled' };
      await ensureOffscreen();
      return browser.runtime.sendMessage({ type: 'dweb/base-host/status' });
    },
    'dweb/base/announce': async ({ record } = {}) => {
      if (!dwebOn()) return { ok: false, error: 'dweb-disabled' };
      await ensureOffscreen();
      return browser.runtime.sendMessage({ type: 'dweb/base-host/announce', record });
    },
    'dweb/base/find': async ({ dwappId, publisherDid } = {}) => {
      if (!dwebOn()) return { ok: false, error: 'dweb-disabled' };
      await ensureOffscreen();
      return browser.runtime.sendMessage({ type: 'dweb/base-host/find', dwappId, publisherDid });
    },

    // --- THE DWEB APP STORE ---
    // Share a local app: read its files (the same OPFS read as export), then have
    // the offscreen base host publish the signed bundle + announce it. A RESHARE
    // reuses the stored slug — the namespace is locked once chosen so the
    // dwapp_id stays stable. On success we persist the version identity.
    'dweb/base/share-app': async ({ appId, slug } = {}) => {
      if (!dwebOn()) return { ok: false, error: 'dweb-disabled' };
      if (typeof appId !== 'string') return { ok: false, error: 'appId-required' };
      try {
        return await appClient.withWriteLock(appId, async () => {
        const record = await appRegistry.get(appId);
        if (!record) return { ok: false, error: 'app-not-found' };
        const beforeRelease = await repositories.statusApp(appId);
        const releaseChanges = beforeRelease.changed ?? [];
        const releasePaths = releaseChanges.slice(0, 3).map((/** @type {{path:string}} */ change) => change.path);
        const committed = await repositories.commitApp(appId, {
          message: releasePaths.length
            ? `release: update ${releasePaths.join(', ')}${releaseChanges.length > releasePaths.length ? ', …' : ''}`
            : 'publish dweb release',
        });
        const history = await repositories.historyApp(appId, { depth: 100 });
        const previousGit = record.dweb?.git_oid;
        const messages = [];
        for (const item of history) {
          if (previousGit && item.oid === previousGit) break;
          if (item.message) messages.push(item.message.split('\n')[0]);
          if (messages.length >= 20) break;
        }
        const changelog = messages.reverse().join('\n').slice(0, 1200);
        const snapshot = await repositories.snapshot({ kind: 'app', id: appId }, { at: committed.oid });
      const release = {
        previousVersionId: record.dweb?.version_id ?? null,
        gitCommitOid: committed.oid,
        changelog,
      };
      /** @type {Record<string, any>} */
      const files = Object.create(null);
      const decoder = new TextDecoder('utf-8', { fatal: true });
        for (const [path, bytes] of Object.entries(snapshot)) files[path] = decoder.decode(bytes);
        if (!Object.hasOwn(files, record.entryFile)) return { ok: false, error: 'release-entry-missing' };
      // Reshare locks to the stored slug; first share takes the dialog's edited slug.
      const useSlug = record.dweb?.slug || slug || undefined;
      await ensureOffscreen();
      const nextSeq = Math.max(Date.now(), Number(record.dweb?.seq ?? -1) + 1);
      // Manifest `created` is hashed. Persist this exact value so a network-host
      // restart can re-seed the SAME signed version instead of accidentally
      // minting new content identity from unchanged files.
      const releaseCreated = Date.now();
        const publishedName = record.name.slice(0, 64);
        const r = await browser.runtime.sendMessage({ type: 'dweb/base-host/share-app', appId, name: publishedName, entry: record.entryFile, files, slug: useSlug, seq: nextSeq, release, created: releaseCreated });
        if (!r?.ok) return r;
        // `shared` drives the "you're seeding this" delete confirm + the un-share path;
        // the dweb slot records the version identity (merged, so it survives reshares).
        try {
          await appRegistry.update(appId, {
            shared: true,
            dweb: {
              uri: r.uri, publisher: r.publisher ?? null, hash: r.hash, version_id: r.hash,
              slug: r.slug, dwapp_id: r.dwapp_id, seq: r.seq, local: record.dweb?.local ?? true,
              git_oid: committed.oid, source_git_oid: committed.oid,
              previous_version_id: release.previousVersionId ?? undefined,
              changelog, release_created: releaseCreated,
              published_hashes: [...new Set([...(record.dweb?.published_hashes ?? []), r.hash])],
            },
          });
        } catch (error) {
          // Network publication is externally visible. If its revocation record
          // cannot be made durable, immediately remove both card and bytes.
          const compensation = await browser.runtime.sendMessage({
            type: 'dweb/base-host/unshare-app', name: publishedName,
            slug: r.slug, publisher: r.publisher, hash: r.hash, hashes: [r.hash],
          }).catch(() => null);
          const pending = (await kv.get('dweb.pendingPublications.v1')) ?? {};
          if (pending[appId]?.hash === r.hash) {
            const next = { ...pending }; delete next[appId];
            await kv.set('dweb.pendingPublications.v1', next).catch(() => {});
          }
          return {
            ok: false,
            error: `share-persistence-failed: ${/** @type {{message?:string}} */ (error)?.message ?? String(error)}`,
            compensated: compensation?.ok === true,
          };
        }
        // A stale journal is safe: startup sees the hash in the durable App
        // record and clears it without revoking. Journal cleanup is therefore
        // best-effort and must never roll back a committed release.
        try {
          const pending = (await kv.get('dweb.pendingPublications.v1')) ?? {};
          if (pending[appId]?.hash === r.hash) {
            const next = { ...pending }; delete next[appId];
            await kv.set('dweb.pendingPublications.v1', next);
          }
        } catch { /* reconciled on the next base-network start */ }
        return r;
        });
      } catch (error) {
        return { ok: false, error: /** @type {{message?:string}} */ (error)?.message ?? String(error) };
      }
    },
    // Discover: what peers have announced (gossip cache + DHT hits).
    'dweb/base/heard': async () => {
      if (!dwebOn()) return { ok: false, error: 'dweb-disabled' };
      await ensureOffscreen();
      return browser.runtime.sendMessage({ type: 'dweb/base-host/heard' });
    },
    // Install a discovered app: the offscreen fetches its signed bundle over the
    // base mesh, verifies it, and persists it. The card's version identity rides
    // along so the installed record can be matched against future announces.
    'dweb/base/install': async ({ uri, name, dwappId, slug, seq, publisher } = {}) => {
      if (!dwebOn()) return { ok: false, error: 'dweb-disabled' };
      await ensureOffscreen();
      return browser.runtime.sendMessage({ type: 'dweb/base-host/install-app', uri, name, dwappId, slug, seq, publisher });
    },
    // Which installed dweb apps have a NEWER version announced? Cross-reference the
    // local catalog against the offscreen discovery Library (the heard cards).
    // Returns a map keyed by local appId. Best-effort + read-only.
    'dweb/base/updates': async () => {
      if (!dwebOn()) return { ok: false, error: 'dweb-disabled' };
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
    // Update an installed app in place to a newer announced version: the offscreen
    // refetches + verifies the new bundle and the SW overwrites the existing app's
    // files. The user keeps ONE copy that just updates.
    'dweb/base/update-app': async ({ appId, uri, name, dwappId, slug, seq, strategy, publisher } = {}) => {
      if (!dwebOn()) return { ok: false, error: 'dweb-disabled' };
      if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
      if (typeof appId !== 'string' || typeof uri !== 'string') return { ok: false, error: 'appId-and-uri-required' };
      await ensureOffscreen();
      return browser.runtime.sendMessage({ type: 'dweb/base-host/update-app', appId, uri, name, dwappId, slug, seq, strategy, publisher });
    },
    // A dwapp room op (join/leave/publish/subscribe/dm/presence/history/…) — one
    // thin relay to the offscreen base host. Events flow back to the app-tab
    // directly as `dweb/base-room/event` runtime messages, so the SW only
    // carries the request/response.
    'dweb/base/room': async (msg = {}) => {
      if (!dwebOn()) return { ok: false, error: 'dweb-disabled' };
      await ensureOffscreen();
      const { type: _t, ...args } = msg;
      return browser.runtime.sendMessage({ type: 'dweb/base-host/room', ...args });
    },
    // The READ surface behind peerd.distributed.{whoami,status,peers,presence} in
    // a Notebook. Side-effect-free: it reports the base host's CURRENT state with
    // rosters; it never STARTS the lobby (maybeStartBaseNetwork does, on unlock).
    'dweb/distributed/info': async () => {
      if (!dwebOn()) return { ok: false, error: 'dweb-disabled' };
      await ensureOffscreen();
      return browser.runtime.sendMessage({ type: 'dweb/base-host/info' });
    },
  };
};
