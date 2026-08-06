// @ts-check
// background/routes/engine.js — engine-instance metadata, the Library (apps)
// surface, .peerd artifact export/import, and VM-originated HTTP egress.
//
// apps/delete stays inline in the SW (it reads the reassigned settings to
// decide whether to un-share over the dweb). Everything here closes over only
// stable collaborators. Bodies verbatim, deps injected, imports none.

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any, sender?: any) => Promise<any>>}
 */
export const makeEngineRoutes = (deps) => {
  const {
    vault, auditLog, pushState, browser, vmHttpFetch,
    appRegistry, vmRegistry, jsRegistry, appClient, appTabTracker,
    opfsHelpers, NOTEBOOK_OPFS_ROOT, IMAGE_PIN_STORAGE_KEY,
    buildAppExport, buildNotebookExport, buildVmRecipeExport,
    openEnvelope, inspectEnvelope, exportFilename,
    ArtifactTooLargeError, EnvelopeFormatError, EnvelopeIntegrityError,
    settingsStore, DWEB_ENABLED, applyWebExtract, withDwebPublication, withAppLifecycle,
    listOffscreenContexts, scriptRuns, isOffscreenSender,
  } = deps;

  return {
    // VM-originated HTTP egress. The VM tab's HTTP-marker dispatcher
    // calls this when it sees a wrapper script's request marker. webFetch
    // applies the denylist + audit; response body is base64-encoded back
    // so runtime.sendMessage's JSON serialization preserves the bytes.
    // Max ~50MB body (matches vm_import's cap) so we don't allow a
    // runaway curl to OOM the SW.
    // why vmHttpFetch (not webFetch directly): #53 moved the VM egress glue into
    // an IO-injected factory (vm-net/vm-http-fetch.js) so it's bun-testable — it
    // layers the revalidating IDB GET cache + host-bound git-auth + body cap +
    // chunked base64 on top of webFetch's denylist/SSRF/audit chokepoint.
    'sw/web-fetch': async ({ url, method, headers, body, gitAuth, noCache, extract, runId, ownerSessionId, deadlineAt }, sender = undefined) => {
      if (typeof url !== 'string' || url.length === 0) {
        return { ok: false, error: 'url-required' };
      }
      /** @type {AbortController | null} */
      let runController = null;
      /** @type {AbortSignal | null} */
      let sourceSignal = null;
      /** @type {(() => void) | null} */
      let onAbort = null;
      /** @type {ReturnType<typeof setTimeout> | null} */
      let deadlineTimer = null;
      const carriesRun = runId !== undefined || ownerSessionId !== undefined;
      if (carriesRun) {
        if (typeof runId !== 'string' || typeof ownerSessionId !== 'string'
          || !isOffscreenSender?.(sender)
          || scriptRuns?.ownerFor(runId) !== ownerSessionId
          || scriptRuns?.allows(runId, 'egress') !== true
          || scriptRuns?.admitOp(runId, 'egress') !== true) {
          return { ok: false, error: 'web_fetch_unknown_finished_foreign_or_over_limit_run' };
        }
        sourceSignal = scriptRuns.signalFor(runId);
        if (sourceSignal?.aborted) return { ok: false, error: 'aborted' };
        runController = new AbortController();
        onAbort = () => runController?.abort();
        sourceSignal?.addEventListener('abort', onAbort, { once: true });
        if (typeof deadlineAt === 'number' && Number.isFinite(deadlineAt)) {
          const remaining = deadlineAt - Date.now();
          if (remaining <= 0) runController.abort();
          else deadlineTimer = setTimeout(() => runController?.abort(), remaining);
        }
      }
      // GET callers (the VM HTTP marker fast path) pass only { url } and behave
      // exactly as before; the rich VM path + the Notebook code-mode bridge pass
      // method/headers/body. webFetch applies denylist + SSRF + audit on EVERY
      // method (parity with fetch_url), so a POST here is not a new egress surface.
      // vmHttpFetch layers the IDB GET cache + optional git-auth on top; noCache
      // (module-source fetches) bypasses that cache so every run is re-audited.
      try {
        const resp = await vmHttpFetch({
          url, method, headers, body, gitAuth, noCache: noCache === true,
          ...(runController ? { signal: runController.signal } : {}),
        });
        // Design 2a extract post-step (Notebook tab relay) — why + security
        // posture: shared/fetch-extract.js. Absent `extract` (every VM caller)
        // it is a passthrough, byte-for-byte as before.
        return await applyWebExtract(resp, extract, url);
      } catch (e) {
        const ev = /** @type {{ name?: string, message?: string }} */ (e);
        return { ok: false, error: ev?.name === 'EgressDeniedError'
          ? `denylisted: ${ev.message}` : (ev?.message ?? String(e)) };
      } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        if (sourceSignal && onAbort) sourceSignal.removeEventListener('abort', onAbort);
      }
    },

    // --- App metadata fetch -----------------------------------------------
    // app-tab/index.html requests its name + entry filename here at load
    // time. The parent then reads files from OPFS directly + composes the
    // body before posting to the sandboxed runner.
    'app/get-meta': async ({ appId }) => {
      if (typeof appId !== 'string') return { ok: false, error: 'appId-required' };
      try {
        const meta = await appRegistry.get(appId);
        if (!meta) return { ok: false, error: 'app-not-found' };
        // dweb meta unlocks the app-tab bridge for dwapps (preview builds);
        // harmless null elsewhere.
        return {
          ok: true,
          name: meta.name,
          entryFile: meta.entryFile,
          fileKinds: meta.fileKinds ?? {},
          dweb: meta.dweb ?? null,
        };
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },

    // The App editor reads OPFS directly but sends every mutation through the
    // SW client so byte caps, kind metadata, and rollback stay one contract.
    'app/editor-write': async ({ appId, path, content }) => {
      if (typeof appId !== 'string') return { ok: false, error: 'appId-required' };
      if (typeof path !== 'string') return { ok: false, error: 'path-required' };
      if (typeof content !== 'string') return { ok: false, error: 'content-required' };
      try {
        const result = await appClient.writeFile({ appId, path, content, reload: false });
        return { ok: true, ...result };
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },

    'app/editor-delete': async ({ appId, path }) => {
      if (typeof appId !== 'string') return { ok: false, error: 'appId-required' };
      if (typeof path !== 'string') return { ok: false, error: 'path-required' };
      try {
        await appClient.deleteFile({ appId, path, reload: false });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },

    // vm-tab/index.html fetches its full record here at boot. why a route
    // (not a direct chrome.storage.local read like before): the VM catalog
    // moved to IndexedDB (idbKV('vms')), which the tab page reaches through
    // the registry the SW owns — mirroring app/get-meta.
    'vm/get-meta': async ({ vmId }) => {
      if (typeof vmId !== 'string') return { ok: false, error: 'vmId-required' };
      try {
        const record = await vmRegistry.get(vmId);
        if (!record) return { ok: false, error: 'vm-not-found' };
        // why devMode rides along: vm-tab has no settings of its own; it reads
        // it here (once, at boot) to honour the "verbose VM diagnostics" toggle
        // (Settings → Behavior) — surfaces the install/verify output in the
        // terminal at boot (the persistent shell is never traced with `set -x`).
        return { ok: true, record, devMode: !!settingsStore.get().devMode };
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },

    // --- Library (the full-tab apps surface in the options page) ----------
    // Metadata only — the catalog records, never OPFS file bodies (the grid
    // stays light under default persistence). Open goes through the appClient
    // so tab lifecycle + OPFS teardown match the agent's tools.
    // why vault-gated: matches the memory/* + session/* convention — the
    // lock is a privacy curtain over plaintext-IDB user content (the app
    // catalog reveals what the user has been building), and export is
    // exfiltrating. The options page already hides the Library when locked;
    // this is the message-level backstop.
    'apps/list': async () => {
      if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
      try {
        return { ok: true, apps: await appRegistry.list() };
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },
    'apps/favorite': async ({ appId, favorite }) => {
      if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
      if (typeof appId !== 'string') return { ok: false, error: 'appId-required' };
      if (typeof favorite !== 'boolean') return { ok: false, error: 'favorite-boolean-required' };
      try {
        const app = await appRegistry.update(appId, { favorite });
        if (!app) return { ok: false, error: 'app-not-found' };
        return { ok: true, app };
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },
    'apps/rename': async ({ appId, name }) => {
      if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
      if (typeof appId !== 'string') return { ok: false, error: 'appId-required' };
      if (typeof name !== 'string' || !name.trim()) return { ok: false, error: 'name-required' };
      try {
        const app = await appRegistry.update(appId, { name: name.trim().slice(0, 80) });
        if (!app) return { ok: false, error: 'app-not-found' };
        // why: reload an open tab so its title reflects the rename.
        appTabTracker.reloadTab(appId).catch(() => {});
        return { ok: true, app };
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },
    'apps/open': async ({ appId }) => {
      if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
      if (typeof appId !== 'string') return { ok: false, error: 'appId-required' };
      try {
        await appClient.open({ appId });
        return { ok: true };
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },
    'apps/delete': async ({ appId }) => {
      if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
      if (typeof appId !== 'string') return { ok: false, error: 'appId-required' };
      try {
        const result = await withDwebPublication(() => withAppLifecycle(appId, async () => {
          // Revoke the live network copy before removing the only durable record
          // that names it. A transient host failure leaves the local App intact so
          // the user can retry without losing the hashes needed for revocation.
          const record = await appRegistry.get(appId);
          if (!record) return { ok: false, error: 'app-not-found' };
          if (DWEB_ENABLED && (record.dweb || record.shared)) {
            try {
              // Never create a host just to revoke. No offscreen context means
              // no in-memory content store can still be serving these bytes.
              const contexts = await listOffscreenContexts(browser);
              if (contexts.length) {
                const reply = await browser.runtime.sendMessage({
                  type: 'dweb/base-host/unshare-app', appId, name: record.name,
                  slug: record.dweb?.slug ?? null,
                  publisher: record.dweb?.publisher ?? null,
                  unpublish: record.dweb?.local === true,
                  hash: record.dweb?.hash ?? null,
                  hashes: [...new Set([
                    record.dweb?.hash,
                    record.dweb?.room_hash,
                    ...(Array.isArray(record.dweb?.pending_unserve_hashes)
                      ? record.dweb.pending_unserve_hashes
                      : []),
                    ...(Array.isArray(record.dweb?.pending_seed_unserve_hashes)
                      ? record.dweb.pending_seed_unserve_hashes
                      : []),
                  ].filter((hash) => typeof hash === 'string' && hash))],
                });
                if (!reply?.ok) throw new Error(reply?.error ?? 'app-unshare-failed');
              }
            } catch {
              return {
                ok: false,
                error: 'Could not stop sharing, so your local App was kept. Try again when the dweb is available.',
              };
            }
          }
          const deleted = await appClient.delete(appId);
          return deleted ? { ok: true } : { ok: false, error: 'app-not-found' };
        }));
        return result;
      } catch (e) {
        return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
      }
    },

    // --- artifacts: .peerd export/import (DESIGN-10) ---
    //
    // One bundle format under manual shares, web publishing, and (later)
    // dwapps. The engine module owns the format (build/verify/unpack);
    // these routes inject the IO: registry records, OPFS trees, the
    // stored TOFU image pin. Same inspect-then-apply shape as the
    // settings transfer — and like every import here, apply mints
    // a FRESH id, never overwriting an existing artifact.
    'export/artifact': async ({ kind, id }) => {
      if (typeof id !== 'string' || !id) return { ok: false, error: 'id-required' };
      /** @param {string[]} rootPath @param {'text' | 'bytes'} mode */
      const readTree = async (rootPath, mode) => {
        const opfs = opfsHelpers(rootPath);
        /** @type {Record<string, string | Uint8Array>} */
        const files = {};
        for (const f of await opfs.list()) {
          const path = f.path.replace(/^\/+/, '');
          files[path] = mode === 'bytes' ? await opfs.readBytes(path) : await opfs.read(path);
        }
        return files;
      };
      try {
        let record, envelope;
        if (kind === 'app') {
          const snapshot = await appClient.snapshotFiles({ appId: id });
          record = snapshot.record;
          // why every App file is read as bytes: artifact transfer is lossless;
          // the persisted kind map decides which bytes are editable text.
          envelope = await buildAppExport({ record, files: snapshot.files });
        } else if (kind === 'notebook') {
          record = await jsRegistry.get(id);
          if (!record) return { ok: false, error: 'notebook-not-found' };
          envelope = await buildNotebookExport({ record, files: await readTree([NOTEBOOK_OPFS_ROOT, id], 'text') });
        } else if (kind === 'vm') {
          record = await vmRegistry.get(id);
          if (!record) return { ok: false, error: 'vm-not-found' };
          // The recipe's whole point is carrying the base-image pin
          // (receiver pins BEFORE first boot). v1 streams ONE stock
          // image, so the sole pin entry is the image; without it
          // (never booted) there is nothing trustworthy to export.
          const stored = await browser.storage.local.get(IMAGE_PIN_STORAGE_KEY);
          const pins = stored?.[IMAGE_PIN_STORAGE_KEY] ?? {};
          const [imageUrl, pin] = Object.entries(pins)[0] ?? [];
          if (!pin) {
            return { ok: false, error: 'no-image-pin — boot this VM once so the base-image fingerprint exists to travel with the recipe' };
          }
          envelope = await buildVmRecipeExport({ record, pin, imageUrl });
        } else {
          return { ok: false, error: 'unknown-kind' };
        }
        auditLog.append({ type: 'artifact_exported', details: { kind, id, name: record.name } }).catch(() => {});
        return { ok: true, filename: exportFilename(record.name, kind), envelope };
      } catch (e) {
        // why cast: the error class arrives via the `any` deps bag, so
        // instanceof can't narrow `e` for tsc — read .message off a view.
        if (e instanceof ArtifactTooLargeError) return { ok: false, error: /** @type {{ message?: string }} */ (e).message };
        throw e;
      }
    },

    // Pre-flight: parse + verify hashes + summarize BEFORE any write
    // (the envelope is self-verifying; nothing is trusted until the
    // chunk hashes match the manifest).
    'import/inspect': async ({ envelope }) => inspectEnvelope(envelope),

    'import/apply': async ({ envelope }) => {
      let opened;
      try {
        opened = await openEnvelope(envelope);
      } catch (e) {
        if (e instanceof EnvelopeFormatError
            || e instanceof EnvelopeIntegrityError
            || e instanceof ArtifactTooLargeError) {
          // why cast: the error classes arrive via the `any` deps bag, so
          // instanceof can't narrow `e` for tsc — read .message off a view.
          return { ok: false, error: /** @type {{ message?: string }} */ (e).message };
        }
        throw e;
      }
      const { kind, name, entry, files, fileKinds, meta } = opened;
      // Notebook source files use the existing text contract. Apps receive the
      // raw file map so import preserves every byte, including unknown suffixes.
      const textFiles = () => {
        /** @type {Record<string, string>} */
        const out = {};
        const dec = new TextDecoder();
        for (const [path, bytes] of Object.entries(files)) out[path] = dec.decode(bytes);
        return out;
      };
      let result;
      if (kind === 'app') {
        // appClient.create is the same path the agent's sandbox_create app arm takes:
        // fresh id, registry record, OPFS writes.
        let record;
        try {
          record = await appClient.create({
            name,
            files,
            fileKinds,
            tags: Array.isArray(meta.tags) ? meta.tags : [],
            entryFile: entry,
          });
        } catch (e) {
          return { ok: false, error: /** @type {{ message?: string }} */ (e)?.message ?? String(e) };
        }
        result = { ok: true, kind, id: record.id };
      } else if (kind === 'notebook') {
        const record = await jsRegistry.create({ name });
        const opfs = opfsHelpers([NOTEBOOK_OPFS_ROOT, record.id]);
        for (const [path, content] of Object.entries(textFiles())) {
          await opfs.write(path, content);
        }
        result = { ok: true, kind, id: record.id };
      } else {
        const record = await vmRegistry.create({ name });
        // Seed the TOFU pin BEFORE first boot — the recipe's payoff. A
        // pin we already hold for the same URL is NEVER overwritten:
        // TOFU means local evidence wins, and the boot path fails
        // closed on any mismatch either way.
        const image = meta.image;
        if (typeof image?.url === 'string' && typeof image?.pin?.headSha256 === 'string') {
          const stored = await browser.storage.local.get(IMAGE_PIN_STORAGE_KEY);
          const pins = stored?.[IMAGE_PIN_STORAGE_KEY] ?? {};
          if (!pins[image.url]) {
            pins[image.url] = {
              totalBytes: Number.isInteger(image.pin.totalBytes) ? image.pin.totalBytes : null,
              headSha256: image.pin.headSha256,
              pinnedAt: Date.now(),
            };
            await browser.storage.local.set({ [IMAGE_PIN_STORAGE_KEY]: pins });
          }
        }
        result = { ok: true, kind, id: record.id };
      }
      auditLog.append({ type: 'artifact_imported', details: { kind, id: result.id, name } }).catch(() => {});
      pushState();
      return result;
    },
  };
};
