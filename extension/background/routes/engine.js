// @ts-check
// background/routes/engine.js — engine-instance metadata, the Library (apps)
// surface, .peerd artifact export/import, and VM-originated HTTP egress.
//
// apps/delete stays inline in the SW (it reads the reassigned settings to
// decide whether to un-share over the dweb). Everything here closes over only
// stable collaborators. Bodies verbatim, deps injected, imports none.

/**
 * Await work through the same cancellation boundary as the operation it gates.
 * The underlying one-time hydration may still finish for other callers, but a
 * stopped or expired run no longer waits for it or proceeds to egress.
 * @template T
 * @param {() => Promise<T>} start
 * @param {AbortSignal | null} signal
 * @returns {Promise<T>}
 */
const awaitWithinSignal = (start, signal) => {
  if (!signal) return Promise.resolve().then(start);
  if (signal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(start).then((value) => {
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    }, (error) => {
      signal.removeEventListener('abort', onAbort);
      reject(error);
    });
  });
};

/**
 * @param {Record<string, any>} deps
 * @returns {Record<string, (msg?: any, sender?: any) => Promise<any>>}
 */
export const makeEngineRoutes = (deps) => {
  const {
    vault, auditLog, pushState, browser, vmHttpFetch,
    appRegistry, vmRegistry, jsRegistry, podRegistry, podTabTracker, appClient, appTabTracker,
    appQuiescence,
    opfsHelpers, NOTEBOOK_OPFS_ROOT, IMAGE_PIN_STORAGE_KEY,
    buildAppExport, buildNotebookExport, buildVmRecipeExport,
    openEnvelope, inspectEnvelope, exportFilename,
    ArtifactTooLargeError, EnvelopeFormatError, EnvelopeIntegrityError,
    settingsStore, DWEB_ENABLED, applyWebExtract, withDwebPublication, withAppLifecycle,
    listOffscreenContexts, scriptRuns, isOffscreenSender, awaitDenylistPolicy, assertOpfsWritable,
    repositories, parseAppManifest, podGitRemoteOperation,
  } = deps;
  if (typeof awaitDenylistPolicy !== 'function') {
    throw new TypeError('makeEngineRoutes: awaitDenylistPolicy is required');
  }
  if (!repositories || typeof repositories.coordinate !== 'function') {
    throw new TypeError('makeEngineRoutes: repositories is required');
  }
  if (typeof parseAppManifest !== 'function') {
    throw new TypeError('makeEngineRoutes: parseAppManifest is required');
  }
  if (typeof podGitRemoteOperation !== 'function') {
    throw new TypeError('makeEngineRoutes: podGitRemoteOperation is required');
  }

  /** @param {string} appId @param {() => Promise<any>} operation */
  const coordinateApp = (appId, operation) => repositories.coordinate({ kind: 'app', id: appId }, operation);
  /** @param {string} appId @param {() => Promise<any>} operation */
  const quiesceApp = (appId, operation) => appQuiescence.run(
    appId,
    () => coordinateApp(appId, operation),
    { close: true },
  );

  /** @param {unknown} value */
  const shellLine = (value) => `${String(value ?? '')}\n`;
  /** @param {any} error */
  const podGitFailure = (error) => ({ stdout: '', stderr: `git: ${error?.message ?? String(error)}\n`, exitCode: 1 });
  /** @param {string[]} argv @param {string} name */
  const optionValue = (argv, name) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  /** @type {Map<string, Set<AbortController>>} */
  const podJobControllers = new Map();
  /** @param {string} podId @param {string} jobId */
  const podJobKey = (podId, jobId) => `${podId}:${jobId}`;
  /** @param {string} podId @param {unknown} jobId */
  const registerPodController = (podId, jobId) => {
    if (typeof jobId !== 'string' || !/^job-[a-z0-9-]{1,100}$/i.test(jobId)) return null;
    const key = podJobKey(podId, jobId);
    const controller = new AbortController();
    const controllers = podJobControllers.get(key) ?? new Set();
    controllers.add(controller);
    podJobControllers.set(key, controllers);
    return {
      controller,
      release: () => {
        controllers.delete(controller);
        if (!controllers.size) podJobControllers.delete(key);
      },
    };
  };
  /** @param {unknown} podId @param {any} sender */
  const podSenderError = async (podId, sender) => {
    const record = typeof podId === 'string' ? await podRegistry.get(podId) : null;
    if (!record) return 'pod-not-found';
    const ownedTab = podTabTracker.getTabId(podId);
    return ownedTab == null || sender?.tab?.id !== ownedTab
      ? 'pod-sender-not-instance-pinned'
      : null;
  };
  /** @param {unknown} value */
  const canonicalUrl = (value) => {
    try { return new URL(String(value)).href; }
    catch { return null; }
  };

  /**
   * Pod Git stays behind an exact instance/tab pin. Agent jobs receive one
   * structured, target-bound grant; direct terminal jobs carry the explicit
   * `true` grant minted by their visible first-party host.
   * @param {any} msg
   * @param {any} sender
   */
  const runPodGit = async ({ podId, jobId, argv = [], remoteGrant = null }, sender) => {
    if (typeof podId !== 'string' || !Array.isArray(argv)) {
      return { ok: false, error: 'podId-and-argv-required' };
    }
    const senderError = await podSenderError(podId, sender);
    if (senderError) return { ok: false, error: senderError };
    const ref = { kind: 'pod', id: podId };
    // Grant validation and the resulting Git operation are one repository
    // transaction. Otherwise a concurrent remote set-url can land after the
    // user approves target A but before push reads origin, sending to target B.
    return repositories.coordinate(ref, async () => {
    const [command = '', ...args] = argv.map(String);
    const remoteOp = podGitRemoteOperation(argv);
    if (remoteOp && remoteGrant !== true) {
      let target = null;
      if (remoteOp === 'clone' || remoteOp === 'link') {
        target = args.find((arg) => /^https:\/\//i.test(arg)) ?? null;
      } else {
        target = (await repositories.getRemote(ref))?.url ?? null;
      }
      const granted = remoteGrant && typeof remoteGrant === 'object'
        && remoteGrant.op === remoteOp
        && canonicalUrl(remoteGrant.url) !== null
        && canonicalUrl(remoteGrant.url) === canonicalUrl(target);
      if (!granted) {
        return {
          ok: true,
          result: {
            stdout: '',
            stderr: `git ${command}: remote operation requires an exact explicit authorization\n`,
            exitCode: 126,
          },
        };
      }
    }
    const abortable = remoteOp && typeof jobId === 'string'
      ? registerPodController(podId, jobId)
      : null;
    try {
      if (remoteOp) {
        await awaitWithinSignal(awaitDenylistPolicy, abortable?.controller.signal ?? null);
        if (abortable?.controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
      }
      let result;
      if (command === 'init') {
        const oid = await repositories.init(ref);
        result = { stdout: shellLine(oid ? 'Initialized Peerd Pod repository' : 'Initialized empty Peerd Pod repository'), stderr: '', exitCode: 0 };
      } else if (command === 'status') {
        const state = await repositories.status(ref);
        const changed = state.changed.map((/** @type {{status:string,path:string}} */ entry) => `${entry.status.padEnd(8)} ${entry.path}`);
        result = { stdout: `${state.branch ? `On branch ${state.branch}\n` : 'No commits yet\n'}${changed.length ? `${changed.join('\n')}\n` : 'working tree clean\n'}`, stderr: '', exitCode: 0 };
      } else if (command === 'add') {
        const staged = await repositories.stage(ref, { paths: args.length ? args : ['.'] });
        result = { stdout: staged.staged.length ? `${staged.staged.join('\n')}\n` : '', stderr: '', exitCode: 0 };
      } else if (command === 'commit') {
        const message = optionValue(args, '-m') ?? optionValue(args, '--message');
        if (!message) return { ok: true, result: { stdout: '', stderr: 'git commit: -m <message> is required\n', exitCode: 2 } };
        const committed = await repositories.commit(ref, { message });
        result = { stdout: committed.created ? shellLine(`[${committed.oid?.slice(0, 10)}] ${message}`) : 'nothing to commit\n', stderr: '', exitCode: 0 };
      } else if (command === 'log') {
        const depth = Math.min(200, Math.max(1, Number(optionValue(args, '-n') ?? optionValue(args, '--max-count')) || 20));
        const rows = await repositories.history(ref, { depth });
        result = { stdout: rows.map((/** @type {{oid:string,message:string}} */ row) => `${row.oid.slice(0, 10)} ${row.message}`).join('\n') + (rows.length ? '\n' : ''), stderr: '', exitCode: 0 };
      } else if (command === 'branch') {
        const name = args.find((arg) => !arg.startsWith('-'));
        if (name) {
          const created = await repositories.branch(ref, { name, checkout: false });
          result = { stdout: shellLine(created.branch), stderr: '', exitCode: 0 };
        } else {
          const [names, state] = await Promise.all([repositories.branches(ref), repositories.status(ref)]);
          result = { stdout: names.map((/** @type {string} */ entry) => `${entry === state.branch ? '* ' : '  '}${entry}`).join('\n') + (names.length ? '\n' : ''), stderr: '', exitCode: 0 };
        }
      } else if (command === 'checkout' || command === 'switch') {
        const name = args.find((arg) => !arg.startsWith('-'));
        if (!name) return { ok: true, result: { stdout: '', stderr: `git ${command}: branch required\n`, exitCode: 2 } };
        const checked = await repositories.checkout(ref, { name });
        result = { stdout: shellLine(`Switched to branch '${checked.branch}'`), stderr: '', exitCode: 0 };
      } else if (command === 'clone') {
        const positional = args.filter((arg, index) => !arg.startsWith('-')
          && args[index - 1] !== '-b' && args[index - 1] !== '--branch'
          && args[index - 1] !== '--depth');
        const url = positional[0];
        if (!url) return { ok: true, result: { stdout: '', stderr: 'git clone: HTTPS URL required\n', exitCode: 2 } };
        const cloned = await repositories.clone(ref, {
          url,
          ref: optionValue(args, '-b') ?? optionValue(args, '--branch'),
          depth: Math.min(500, Math.max(1, Number(optionValue(args, '--depth')) || 50)),
          signal: abortable?.controller.signal,
        });
        result = { stdout: shellLine(`Cloned ${cloned.remote.url}`), stderr: '', exitCode: 0 };
      } else if (command === 'fetch') {
        const fetched = await repositories.fetch(ref, { signal: abortable?.controller.signal });
        result = { stdout: shellLine(`Fetched ${fetched.remote.url}`), stderr: '', exitCode: 0 };
      } else if (command === 'push') {
        const branchName = args.find((arg) => !arg.startsWith('-') && arg !== 'origin');
        const pushed = await repositories.push(ref, {
          ...(branchName ? { ref: branchName } : {}),
          signal: abortable?.controller.signal,
        });
        result = pushed.ok
          ? { stdout: shellLine(`Pushed ${pushed.branch} to ${pushed.remote.url}`), stderr: '', exitCode: 0 }
          : { stdout: '', stderr: shellLine(pushed.error || 'push rejected'), exitCode: 1 };
      } else if (command === 'remote') {
        const url = args.find((arg) => /^https:\/\//i.test(arg));
        if (url && (args.includes('add') || args.includes('set-url'))) {
          const remote = await repositories.setRemote(ref, { url });
          result = { stdout: '', stderr: '', exitCode: 0, remote };
        } else {
          const remote = await repositories.getRemote(ref);
          result = { stdout: remote ? `${args.includes('-v') ? `origin\t${remote.url} (fetch)\norigin\t${remote.url} (push)` : 'origin'}\n` : '', stderr: '', exitCode: 0 };
        }
      } else {
        result = { stdout: '', stderr: `git: unsupported Pod subcommand '${command || '(none)'}'\n`, exitCode: 2 };
      }
      auditLog.append({ type: 'pod_git_command', details: { podId, command, exitCode: result.exitCode } }).catch(() => {});
      return { ok: true, result };
    } catch (error) {
      const result = podGitFailure(error);
      auditLog.append({
        type: 'pod_git_command',
        details: {
          podId, command, exitCode: 1,
          error: /** @type {{message?:string}} */ (error)?.message ?? String(error),
        },
      }).catch(() => {});
      return { ok: true, result };
    } finally {
      abortable?.release();
    }
    });
  };

  /** @type {Map<string, AbortController>} */
  const notebookFetchControllers = new Map();
  /** @param {unknown} abortToken @param {unknown} notebookId @param {any} sender */
  const notebookFetchKey = (abortToken, notebookId, sender) => {
    if (typeof abortToken !== 'string' || abortToken.length > 128
      || typeof notebookId !== 'string' || notebookId.length > 128) return null;
    const notebookRoot = browser.runtime.getURL('engine-tabs/notebook-tab/');
    const senderUrl = sender?.url ?? sender?.tab?.url;
    if (!senderUrl?.startsWith(notebookRoot)) return null;
    try {
      if (new URL(senderUrl).hash.slice(1).split(/[?&]/)[0] !== notebookId) return null;
    } catch { return null; }
    return `${notebookId}:${abortToken}`;
  };

  return {
    'pod/git': runPodGit,
    'pod/cancel-io': async ({ podId, jobId }, sender) => {
      const senderError = await podSenderError(podId, sender);
      if (senderError) return { ok: false, error: senderError };
      const controllers = podJobControllers.get(podJobKey(podId, jobId));
      for (const controller of controllers ?? []) controller.abort('Pod job cancelled');
      return { ok: true, cancelled: controllers?.size ?? 0 };
    },
    'pod/web-fetch': async ({ podId, jobId, url, method, headers, body }, sender) => {
      const senderError = await podSenderError(podId, sender);
      if (senderError) return { ok: false, error: senderError };
      if (typeof url !== 'string' || !url) return { ok: false, error: 'url-required' };
      const abortable = registerPodController(podId, jobId);
      try {
        await awaitWithinSignal(awaitDenylistPolicy, abortable?.controller.signal ?? null);
        if (abortable?.controller.signal.aborted) return { ok: false, error: 'aborted' };
        return await vmHttpFetch({
          url, method, headers, body,
          signal: abortable?.controller.signal,
          noCache: true,
          maxBodyBytes: 16 * 1024 * 1024,
        });
      } catch (error) {
        const value = /** @type {{name?:string,message?:string}} */ (error);
        return {
          ok: false,
          error: value?.name === 'AbortError'
            ? 'aborted'
            : value?.name === 'DenylistPolicyUnavailableError'
              ? 'The sensitive-origin policy is unavailable. Network access is blocked.'
              : value?.message ?? String(error),
        };
      } finally {
        abortable?.release();
      }
    },
    'pod/get-meta': async ({ podId }, sender) => {
      const senderError = await podSenderError(podId, sender);
      if (senderError) return { ok: false, error: senderError };
      const record = await podRegistry.get(podId);
      return {
        ok: true,
        record: { id: record.id, name: record.name, persistent: record.persistent !== false },
      };
    },
    // Notebook tabs and the offscreen job host own the actual OPFS handles.
    // They ask here immediately before mutation so the service worker's live
    // schema posture remains authoritative in Chrome and Firefox alike.
    'lifecycle/assert-opfs-writable': async (_msg, sender = undefined) => {
      const notebookHost = browser.runtime.getURL('engine-tabs/notebook-tab/index.html');
      const senderUrl = sender?.url ?? sender?.tab?.url;
      const trustedHost = isOffscreenSender?.(sender)
        || (typeof senderUrl === 'string'
          && senderUrl.split(/[?#]/)[0] === notebookHost);
      if (!trustedHost) return { ok: false, error: 'unauthorized OPFS posture request' };
      try {
        await assertOpfsWritable();
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: /** @type {{ message?: string }} */ (error)?.message ?? String(error),
        };
      }
    },

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
    'sw/web-fetch': async ({ url, method, headers, body, gitAuth, noCache, extract, runId, ownerSessionId, deadlineAt, abortToken, notebookId }, sender = undefined) => {
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
      const notebookKey = notebookFetchKey(abortToken, notebookId, sender);
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
      } else if (notebookKey) {
        if (notebookFetchControllers.has(notebookKey)) {
          return { ok: false, error: 'duplicate_notebook_fetch_token' };
        }
        runController = new AbortController();
        notebookFetchControllers.set(notebookKey, runController);
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
        // why: hydration is part of the egress operation, not a preflight outside
        // it. Admit the run and arm Stop/deadline first, then await policy through
        // that signal. A stopped or expired run cannot reach vmHttpFetch even if
        // the shared hydration later succeeds.
        await awaitWithinSignal(
          awaitDenylistPolicy,
          runController?.signal ?? null,
        );
        if (runController?.signal.aborted) return { ok: false, error: 'aborted' };
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
        return { ok: false, error: ev?.name === 'AbortError'
          ? 'aborted'
          : ev?.name === 'DenylistPolicyUnavailableError'
            ? 'The sensitive-origin policy is unavailable. Network access is blocked.'
          : ev?.name === 'EgressDeniedError'
            ? `denylisted: ${ev.message}` : (ev?.message ?? String(e)) };
      } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
        if (sourceSignal && onAbort) sourceSignal.removeEventListener('abort', onAbort);
        if (notebookKey && notebookFetchControllers.get(notebookKey) === runController) {
          notebookFetchControllers.delete(notebookKey);
        }
      }
    },
    'sw/web-fetch-abort': async ({ abortToken, notebookId }, sender = undefined) => {
      const key = notebookFetchKey(abortToken, notebookId, sender);
      const controller = key ? notebookFetchControllers.get(key) : null;
      controller?.abort();
      return { ok: true, aborted: controller != null };
    },

    // --- App metadata fetch -----------------------------------------------
    // app-tab/index.html requests its name + entry filename here at load
    // time. The parent then reads files from OPFS directly + composes the
    // body before posting to the sandboxed runner.
    'app/get-meta': async ({ appId }) => {
      if (typeof appId !== 'string') return { ok: false, error: 'appId-required' };
      try {
        let meta = await appRegistry.get(appId);
        if (!meta) return { ok: false, error: 'app-not-found' };
        let runtimeDweb = meta.dweb ?? null;
        try {
          const contract = parseAppManifest(await appClient.readFile({ appId, path: 'peerd.json' }));
          const paths = new Set((await appClient.listFiles({ appId })).map((/** @type {{path:string}} */ file) => file.path.replace(/^\/+/, '')));
          if (!paths.has(contract.entry)) return { ok: false, error: `peerd.json entry is missing: ${contract.entry}` };
          runtimeDweb = contract.capabilities.includes('dweb') && DWEB_ENABLED
            ? (meta.dweb ?? { uri: null, publisher: null, hash: null, local: true })
            : null;
          if (contract.entry !== meta.entryFile) meta = await appRegistry.update(appId, { entryFile: contract.entry });
        } catch (error) {
          if ((/** @type {{name?:string}} */ (error)).name !== 'NotFoundError') {
            return { ok: false, error: /** @type {{message?:string}} */ (error)?.message ?? String(error) };
          }
        }
        // dweb meta unlocks the app-tab bridge for dwapps (preview builds);
        // harmless null elsewhere.
        return {
          ok: true,
          name: meta.name,
          entryFile: meta.entryFile,
          fileKinds: meta.fileKinds ?? {},
          dweb: runtimeDweb,
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
    // App-tab editor IO goes through the same mutation coordinator as Git.
    // This keeps a multi-surface browser App from writing around restore/share.
    'app/editor/read': async ({ appId, path }) => {
      if (typeof appId !== 'string' || typeof path !== 'string') return { ok: false, error: 'appId-and-path-required' };
      try { return { ok: true, content: await appClient.readFile({ appId, path }) }; }
      catch (e) { return { ok: false, error: /** @type {{message?:string}} */ (e)?.message ?? String(e) }; }
    },
    'app/editor/list': async ({ appId }) => {
      if (typeof appId !== 'string') return { ok: false, error: 'appId-required' };
      try { return { ok: true, files: await appClient.listFiles({ appId }) }; }
      catch (e) { return { ok: false, error: /** @type {{message?:string}} */ (e)?.message ?? String(e) }; }
    },
    'app/editor/write': async ({ appId, path, content }) => {
      if (typeof appId !== 'string' || typeof path !== 'string' || typeof content !== 'string') return { ok: false, error: 'appId-path-content-required' };
      try { await appClient.writeFile({ appId, path, content }); return { ok: true }; }
      catch (e) { return { ok: false, error: /** @type {{message?:string}} */ (e)?.message ?? String(e) }; }
    },
    'app/editor/delete': async ({ appId, path }) => {
      if (typeof appId !== 'string' || typeof path !== 'string') return { ok: false, error: 'appId-and-path-required' };
      try { await appClient.deleteFile({ appId, path }); return { ok: true }; }
      catch (e) { return { ok: false, error: /** @type {{message?:string}} */ (e)?.message ?? String(e) }; }
    },
    'apps/repository/status': async ({ appId }) => {
      if (typeof appId !== 'string') return { ok: false, error: 'appId-required' };
      try {
        const [status, remote, branches] = await Promise.all([
          repositories.statusApp(appId), repositories.getAppRemote(appId),
          repositories.branches({ kind: 'app', id: appId }),
        ]);
        return { ok: true, status, remote, branches };
      }
      catch (e) { return { ok: false, error: /** @type {{message?:string}} */ (e)?.message ?? String(e) }; }
    },
    'apps/repository/history': async ({ appId, depth }) => {
      if (typeof appId !== 'string') return { ok: false, error: 'appId-required' };
      try { return { ok: true, commits: await repositories.historyApp(appId, { depth, includeSafety: true }) }; }
      catch (e) { return { ok: false, error: /** @type {{message?:string}} */ (e)?.message ?? String(e) }; }
    },
    'apps/repository/diff': async ({ appId, from, to }) => {
      if (typeof appId !== 'string') return { ok: false, error: 'appId-required' };
      try { return { ok: true, diff: await repositories.diffApp(appId, { from: from || 'HEAD', to: to || null }) }; }
      catch (e) { return { ok: false, error: /** @type {{message?:string}} */ (e)?.message ?? String(e) }; }
    },
    'apps/repository/commit': async ({ appId, message }) => {
      if (typeof appId !== 'string') return { ok: false, error: 'appId-required' };
      try {
        const result = await quiesceApp(appId, () => repositories.commitApp(appId, { message: typeof message === 'string' ? message : 'manual edit' }));
        await auditLog.append({ type: 'git_commit_created', details: { kind: 'app', appId, oid: result.oid, changed: result.changed.length } });
        return { ok: true, result };
      } catch (e) { return { ok: false, error: /** @type {{message?:string}} */ (e)?.message ?? String(e) }; }
    },
    'apps/repository/restore': async ({ appId, to }) => {
      if (typeof appId !== 'string' || typeof to !== 'string') return { ok: false, error: 'appId-and-to-required' };
      try {
        const result = await quiesceApp(appId, () => repositories.restoreApp(appId, { to }));
        appTabTracker.reloadTab(appId).catch(() => {});
        await auditLog.append({ type: 'git_version_restored', details: { kind: 'app', appId, to, oid: result.oid } });
        return { ok: true, result };
      } catch (e) { return { ok: false, error: /** @type {{message?:string}} */ (e)?.message ?? String(e) }; }
    },
    'apps/repository/branch': async ({ appId, name, checkout = true }) => {
      if (typeof appId !== 'string' || typeof name !== 'string') return { ok: false, error: 'appId-and-name-required' };
      try { return { ok: true, result: await (checkout === false ? coordinateApp : quiesceApp)(appId, () => repositories.branch({ kind: 'app', id: appId }, { name, checkout: checkout !== false })) }; }
      catch (e) { return { ok: false, error: /** @type {{message?:string}} */ (e)?.message ?? String(e) }; }
    },
    'apps/repository/checkout': async ({ appId, name }) => {
      if (typeof appId !== 'string' || typeof name !== 'string') return { ok: false, error: 'appId-and-name-required' };
      try {
        const result = await quiesceApp(appId, () => repositories.checkout({ kind: 'app', id: appId }, { name }));
        appTabTracker.reloadTab(appId).catch(() => {});
        return { ok: true, result };
      } catch (e) { return { ok: false, error: /** @type {{message?:string}} */ (e)?.message ?? String(e) }; }
    },
    'apps/repository/link': async ({ appId, url }) => {
      if (typeof appId !== 'string' || typeof url !== 'string') return { ok: false, error: 'appId-and-url-required' };
      try {
        const remote = await coordinateApp(appId, () => repositories.setRemote({ kind: 'app', id: appId }, { url }));
        await auditLog.append({ type: 'git_remote_linked', details: { kind: 'app', appId, host: remote.host, url: remote.url } });
        return { ok: true, remote };
      } catch (e) { return { ok: false, error: /** @type {{message?:string}} */ (e)?.message ?? String(e) }; }
    },
    'apps/repository/fetch': async ({ appId }) => {
      if (typeof appId !== 'string') return { ok: false, error: 'appId-required' };
      try {
        const result = await coordinateApp(appId, () => repositories.fetch({ kind: 'app', id: appId }));
        await auditLog.append({ type: 'git_remote_fetched', details: { kind: 'app', appId, host: result.remote.host } });
        return { ok: true, result };
      } catch (e) { return { ok: false, error: /** @type {{message?:string}} */ (e)?.message ?? String(e) }; }
    },
    'apps/repository/push': async ({ appId, branch }) => {
      if (typeof appId !== 'string') return { ok: false, error: 'appId-required' };
      try {
        const result = await quiesceApp(appId, async () => {
          await repositories.commitApp(appId, { message: 'checkpoint before push' });
          return repositories.push({ kind: 'app', id: appId }, { ref: typeof branch === 'string' ? branch : undefined });
        });
        await auditLog.append({ type: 'git_remote_pushed', details: { kind: 'app', appId, host: result.remote.host, branch: result.branch } });
        return { ok: result.ok, result, ...(result.ok ? {} : { error: result.error || 'push rejected (the remote may contain unrelated or newer commits)' }) };
      } catch (e) { return { ok: false, error: /** @type {{message?:string}} */ (e)?.message ?? String(e) }; }
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
        // Refuse before minting metadata. The guarded OPFS helper checks again
        // at each file write, but a preflight avoids an empty registry record
        // when the workspace schema is read-only.
        try { await assertOpfsWritable(); }
        catch (error) {
          return {
            ok: false,
            error: /** @type {{ message?: string }} */ (error)?.message ?? String(error),
          };
        }
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
