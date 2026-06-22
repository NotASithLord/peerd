// @ts-check
// background/routes/engine.js — engine-instance metadata, the Library (apps)
// surface, .peerd artifact export/import, and VM-originated HTTP egress.
//
// apps/delete stays inline in the SW (it reads the reassigned settings to
// decide whether to un-share over the dweb). Everything here closes over only
// stable collaborators. Bodies verbatim, deps injected, imports none.

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any) => Promise<any>>}
 */
export const makeEngineRoutes = (deps) => {
  const {
    vault, auditLog, pushState, browser, vmHttpFetch,
    appRegistry, vmRegistry, jsRegistry, appClient, appTabTracker,
    opfsHelpers, NOTEBOOK_OPFS_ROOT, IMAGE_PIN_STORAGE_KEY,
    buildAppExport, buildNotebookExport, buildVmRecipeExport,
    openEnvelope, inspectEnvelope, exportFilename,
    ArtifactTooLargeError, EnvelopeFormatError, EnvelopeIntegrityError,
    ensureOffscreen, settingsStore, DWEB_ENABLED,
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
    'sw/web-fetch': async ({ url, method, headers, body, gitAuth }) => {
      if (typeof url !== 'string' || url.length === 0) {
        return { ok: false, error: 'url-required' };
      }
      // GET callers (the VM HTTP marker fast path) pass only { url } and behave
      // exactly as before; the rich VM path + the Notebook code-mode bridge pass
      // method/headers/body. webFetch applies denylist + SSRF + audit on EVERY
      // method (parity with call_api), so a POST here is not a new egress surface.
      // vmHttpFetch layers the IDB GET cache + optional git-auth on top.
      try {
        return await vmHttpFetch({ url, method, headers, body, gitAuth });
      } catch (e) {
        const ev = /** @type {{ name?: string, message?: string }} */ (e);
        return { ok: false, error: ev?.name === 'EgressDeniedError'
          ? `denylisted: ${ev.message}` : (ev?.message ?? String(e)) };
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
        return { ok: true, name: meta.name, entryFile: meta.entryFile, dweb: meta.dweb ?? null };
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
        // (Settings → Behavior) — `set -x` in the sourced wrappers + visible
        // install/verify output.
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
        // why read first: deleting drops the record, but UN-SHARING a dwapp needs its
        // name (→ slug) + dweb slot (publisher/hash) to tell the base host to stop
        // announcing + serving the bytes. An app the user shared (or installed → we
        // auto-seed) keeps being served by the offscreen content store until we
        // unannounce it — that's the "I deleted it but a peer could still pull it" bug.
        const record = await appRegistry.get(appId);
        // why distinguish: appClient.delete returns false for an unknown id;
        // reporting that as success would let the UI drop a card that wasn't
        // actually deleted (masking id drift).
        const deleted = await appClient.delete(appId);
        if (!deleted) return { ok: false, error: 'app-not-found' };
        // Best-effort un-share (a dwapp, or any app the user shared). Never blocks or
        // fails the delete: the local copy is already gone; this just stops the network
        // copy. Dweb-off / store: the route is inert, so skip the offscreen round-trip.
        if (DWEB_ENABLED && settingsStore.get().dwebEnabled && record && (record.dweb || record.shared)) {
          try {
            await ensureOffscreen();
            await browser.runtime.sendMessage({
              type: 'dweb/base-host/unshare-app',
              name: record.name,
              publisher: record.dweb?.publisher ?? null,
              hash: record.dweb?.hash ?? null,
            });
          } catch (e) { console.debug('[apps/delete] unshare failed (local delete still applied)', e); }
        }
        return { ok: true };
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
      // The OPFS tree, path → text — the same read surface app-tab's
      // composer uses (opfs.list() prefixes paths with '/').
      /** @param {string[]} rootPath */
      const readTree = async (rootPath) => {
        const opfs = opfsHelpers(rootPath);
        /** @type {Record<string, string>} */
        const files = {};
        for (const f of await opfs.list()) {
          const path = f.path.replace(/^\/+/, '');
          files[path] = await opfs.read(path);
        }
        return files;
      };
      try {
        let record, envelope;
        if (kind === 'app') {
          record = await appRegistry.get(id);
          if (!record) return { ok: false, error: 'app-not-found' };
          envelope = await buildAppExport({ record, files: await readTree(['peerd-apps', id]) });
        } else if (kind === 'notebook') {
          record = await jsRegistry.get(id);
          if (!record) return { ok: false, error: 'notebook-not-found' };
          envelope = await buildNotebookExport({ record, files: await readTree([NOTEBOOK_OPFS_ROOT, id]) });
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
      const { kind, name, entry, files, meta } = opened;
      // OPFS trees travel as bytes; the engine kinds store text (the
      // same contract app-tab/notebook-tab read back out).
      const textFiles = () => {
        /** @type {Record<string, string>} */
        const out = {};
        const dec = new TextDecoder();
        for (const [path, bytes] of Object.entries(files)) out[path] = dec.decode(bytes);
        return out;
      };
      let result;
      if (kind === 'app') {
        // appClient.create is the same path the agent's app_create takes:
        // fresh id, registry record, OPFS writes.
        let record;
        try {
          record = await appClient.create({
            name,
            files: textFiles(),
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
