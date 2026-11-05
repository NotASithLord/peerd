// @ts-check

// Exact App authority for one admitted tool call. The SW owns the OPFS tree,
// catalog, tab, repository lock, session default, and actor binding; the
// controller owns validation, search presentation, paging, and result shaping.

import { sameCanonicalStructuredClone } from '/shared/canonical-clone-digest.js';
import { APP_DATA_PATH_RE } from '/shared/app-dweb-identity.js';
import { MAX_APP_TOTAL_BYTES } from './app-client.js';

const APP_AUTHORITY_ARGUMENT_BYTES = 8 * 1024 * 1024;

const mismatch = () => Object.assign(new Error('App authority mismatch'), {
  outcomeKnown: true, retryable: false,
});

// Host-owned file copy between one Pod and one existing App. The model names
// the Pod, the App and the paths. The bytes stay in the service worker: they
// are read once, hashed, shown to the user, and then written exactly as read.

const POD_APP_COPY_MAX_FILES = 64;
// why: the Pod tab refuses larger files (engine-tabs/pod-tab/pod-tab.js). The
// copy checks first, so the user is never asked to approve a write that fails.
const POD_MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PATH_CHARS = 512;

/** @param {string} error @param {Record<string,unknown>} [extra] */
const refused = (error, extra = {}) => ({
  ok: false, error, performed: false, outcomeKnown: true, outcomeKind: 'pre-effect-failure', ...extra,
});

/** @param {unknown} path @param {boolean} allowLeadingSlash */
const cleanPath = (path, allowLeadingSlash) => {
  // why no control or direction characters: the path is shown in the user's
  // prompt, and a line break or a text-direction override could forge a line.
  if (typeof path !== 'string' || !path || path.length > MAX_PATH_CHARS
      || path.includes('\\') || /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(path)) return null;
  if (!allowLeadingSlash && path.startsWith('/')) return null;
  const parts = path.replace(/^\/+/, '').split('/');
  return parts.every((part) => part && part !== '.' && part !== '..') ? parts.join('/') : null;
};

/**
 * Validate the small model-chosen request. Pod paths may start with '/' like
 * pod_read paths; App paths are relative like app_write_file paths.
 * @param {unknown} direction @param {unknown} podId @param {unknown} appId @param {unknown} files
 */
const validatePodAppCopy = (direction, podId, appId, files) => {
  if (direction !== 'pod_to_app' && direction !== 'app_to_pod') return { error: 'direction must be pod_to_app or app_to_pod' };
  if (typeof podId !== 'string' || !/^pod-[a-z0-9-]{1,120}$/i.test(podId)) return { error: 'podId is invalid' };
  if (typeof appId !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,127}$/i.test(appId)) return { error: 'appId is invalid' };
  if (!Array.isArray(files) || !files.length || files.length > POD_APP_COPY_MAX_FILES) {
    return { error: `files must list 1 to ${POD_APP_COPY_MAX_FILES} entries` };
  }
  const fromPod = direction === 'pod_to_app';
  /** @type {Array<{from:string,to:string}>} */
  const normalized = [];
  const targets = new Set();
  for (const file of files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)
        || Object.keys(file).some((key) => key !== 'from' && key !== 'to')) {
      return { error: 'each file entry is { from, to? } with paths only' };
    }
    const from = cleanPath(file.from, fromPod);
    const to = cleanPath(file.to ?? file.from, !fromPod);
    if (!from || !to) return { error: `unsafe path: ${String(file.to ?? file.from).slice(0, 80)}` };
    if (targets.has(to)) return { error: `duplicate target: ${to}` };
    targets.add(to);
    normalized.push({ from, to });
  }
  return {
    request: {
      direction: /** @type {'pod_to_app'|'app_to_pod'} */ (direction), podId, appId, files: normalized,
    },
  };
};

/**
 * The person an App's files come from, or null when the user made it. A share
 * from this device marks its record local; an install never does.
 * @param {{dweb?:{local?:boolean,publisher?:string|null}|null}} record
 */
const outsidePublisher = (record) => {
  const dweb = record?.dweb;
  if (!dweb || dweb.local === true) return null;
  return typeof dweb.publisher === 'string' && dweb.publisher ? dweb.publisher : 'an unknown publisher';
};

/** @param {Uint8Array<ArrayBuffer>} bytes */
const sha256Hex = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
  .map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** @param {number} size */
const sizeLabel = (size) => size < 1024 ? `${size} B`
  : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / (1024 * 1024)).toFixed(1)} MB`;

/** @param {unknown} value */
const shown = (value) => String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 96);

/** @param {unknown} cause */
const messageOf = (cause) => /** @type {{message?:string}} */ (cause)?.message ?? String(cause);

/**
 * @typedef {{name?:unknown,entryFile?:string,shared?:boolean,
 *   dweb?:{local?:boolean,publisher?:string|null}|null}} CopyAppRecord
 * @typedef {Array<{from:string,to:string,bytes:Uint8Array<ArrayBuffer>,sha256:string}>} CopyBuffer
 * @typedef {{
 *   podClient?:{
 *     withWorkspaceLock?:(podId:string,operation:(lockToken:string|null)=>Promise<CopyBuffer>)=>Promise<CopyBuffer>,
 *     readBytes?:(path:string,options:{podId:string,lockToken?:string})=>Promise<Uint8Array<ArrayBuffer>>,
 *     writeFile?:(path:string,bytes:Uint8Array,options:{podId:string})=>Promise<unknown>,
 *     setOutsideFiles?:(podId:string,mark:{publisher:string,appId:string,appName:string,markedAt:number})=>Promise<unknown>,
 *   },
 *   podRegistry?:{get?:(id:string)=>Promise<{name?:unknown}|null>},
 *   appRegistry?:{get?:(id:string)=>Promise<CopyAppRecord|null>},
 *   appClient?:{
 *     withWriteLock?:(appId:string,operation:()=>Promise<CopyBuffer>)=>Promise<CopyBuffer>,
 *     readFileBytes?:(request:{appId:string,path:string})=>Promise<Uint8Array<ArrayBuffer>>,
 *     writeFiles?:(request:{appId:string,files:Array<{path:string,bytes:Uint8Array}>,signal?:AbortSignal})=>Promise<unknown>,
 *   },
 *   confirm?:(prompt:Record<string,unknown>,signal?:AbortSignal)=>Promise<unknown>,
 *   actStillLive:()=>Promise<boolean>,signal?:AbortSignal,sessionId?:string|null,
 * }} CopyDeps
 */

/**
 * @param {{direction:'pod_to_app'|'app_to_pod',podId:string,appId:string,files:Array<{from:string,to:string}>}} request
 * @param {CopyDeps} deps
 */
const copyBetweenPodAndApp = async (request, deps) => {
  const { direction, podId, appId, files } = request;
  const { signal } = deps;
  const withWorkspaceLock = deps.podClient?.withWorkspaceLock;
  const readPodBytes = deps.podClient?.readBytes;
  const writePodFile = deps.podClient?.writeFile;
  const setOutsideFiles = deps.podClient?.setOutsideFiles;
  const readPod = deps.podRegistry?.get;
  const readApp = deps.appRegistry?.get;
  const withAppWriteLock = deps.appClient?.withWriteLock;
  const readAppBytes = deps.appClient?.readFileBytes;
  const writeAppFiles = deps.appClient?.writeFiles;
  const confirm = deps.confirm;
  if (!withWorkspaceLock || !readPodBytes || !writePodFile || !setOutsideFiles || !readPod
      || !readApp || !withAppWriteLock || !readAppBytes || !writeAppFiles || !confirm) {
    return refused('pod_app_copy_unavailable');
  }
  const [app, pod] = await Promise.all([readApp(appId), readPod(podId)]);
  if (!app) return refused(`App not found: ${appId}`);
  if (!pod) return refused(`Pod not found: ${podId}`);
  const toApp = direction === 'pod_to_app';
  if (toApp) {
    const protectedPath = files.find(({ to }) => to === 'peerd.json' || to === app.entryFile
      || APP_DATA_PATH_RE.test(to));
    if (protectedPath) return refused(`this copy cannot replace ${protectedPath.to}`);
  }

  /** @type {CopyBuffer} */
  let buffered;
  try {
    // why one hold for the whole read: every file comes from the same moment,
    // and the user approves exactly these bytes. Nothing is read again.
    const readAll = async (/** @type {(path:string)=>Promise<Uint8Array<ArrayBuffer>>} */ read) => {
      const out = [];
      let total = 0;
      for (const file of files) {
        if (signal?.aborted) throw new Error('the copy was stopped before it finished reading');
        const bytes = await read(file.from);
        total += bytes.byteLength;
        if (toApp && total > MAX_APP_TOTAL_BYTES) throw new Error(`the files are larger than the ${MAX_APP_TOTAL_BYTES}-byte App limit`);
        if (!toApp && bytes.byteLength > POD_MAX_FILE_BYTES) throw new Error(`${file.from} is larger than the ${POD_MAX_FILE_BYTES}-byte Pod file limit`);
        out.push({ ...file, bytes, sha256: await sha256Hex(bytes) });
      }
      return out;
    };
    buffered = toApp
      ? await withWorkspaceLock(podId, (lockToken) => readAll((path) =>
        readPodBytes(path, { podId, ...(lockToken ? { lockToken } : {}) })))
      : await withAppWriteLock(appId, () => readAll((path) => readAppBytes({ appId, path })));
  } catch (cause) {
    return refused(`pod_app_copy_read_failed: ${messageOf(cause)}`);
  }

  const publisher = toApp ? null : outsidePublisher(app);
  const podName = shown(pod.name) || podId;
  const appName = shown(app.name) || appId;
  const lines = buffered.map((file) =>
    `${file.from} to ${file.to}: ${sizeLabel(file.bytes.byteLength)}, SHA-256 ${file.sha256.slice(0, 12)}`);
  const summary = toApp
    ? [
      `Copy ${files.length} file${files.length === 1 ? '' : 's'} from Pod "${podName}" into App "${appName}"?`,
      app.shared === true ? 'This App is shared with other people.' : 'This App is not shared.',
      ...lines,
    ]
    : [
      `Copy ${files.length} file${files.length === 1 ? '' : 's'} from App "${appName}" into Pod "${podName}"?`,
      ...(publisher
        ? [`This App was made by someone else (${shown(publisher)}). After the copy, this Pod cannot use the web or Git remotes until you allow it again in the Pod tab.`]
        : []),
      ...lines,
    ];
  let answer;
  try {
    answer = await confirm({
      tool: 'pod_app_copy', kind: 'pod_app_copy', sideEffect: 'write', actionClass: 'workspace_write', origins: [],
      summary: summary.join('\n'), oneShot: true, sessionId: deps.sessionId ?? null,
    }, signal);
  } catch (cause) {
    return refused(`pod_app_copy_confirmation_failed: ${messageOf(cause)}`);
  }
  if (answer !== true && answer !== 'yes_once' && answer !== 'yes_session') {
    return refused('declined', { declined: true });
  }
  if (signal?.aborted) return refused('pod_app_copy_aborted');
  // why: consent is not Plan/Act authority. The mode may have moved to Plan
  // while the prompt was open, after the outer admission ran.
  if (!await deps.actStillLive()) return refused('plan_mode_refused', { code: 'plan_mode_refused' });
  if (signal?.aborted) return refused('pod_app_copy_aborted');

  const receipt = buffered.map(({ from, to, bytes, sha256 }) => ({ from, to, bytes: bytes.byteLength, sha256 }));
  if (toApp) {
    try {
      await writeAppFiles({
        appId, files: buffered.map(({ to, bytes }) => ({ path: to, bytes })), signal,
      });
    } catch (cause) {
      const detail = /** @type {{performed?:boolean,outcomeKnown?:boolean}} */ (cause);
      return {
        ok: false, error: `pod_app_copy_write_failed: ${messageOf(cause)}`,
        performed: detail?.performed === true, outcomeKnown: detail?.outcomeKnown !== false,
      };
    }
    return { ok: true, direction, podId, appId, files: receipt };
  }

  let marked = false;
  /** @type {string[]} */
  const written = [];
  try {
    // why first: if a write fails part way, the Pod is already marked.
    if (publisher) {
      await setOutsideFiles(podId, {
        publisher, appId, appName: shown(app.name), markedAt: Date.now(),
      });
      marked = true;
    }
    for (const { to, bytes } of buffered) {
      if (signal?.aborted) throw new Error('the copy was stopped before it finished writing');
      await writePodFile(to, bytes, { podId });
      written.push(to);
    }
  } catch (cause) {
    return {
      ok: false, error: `pod_app_copy_write_failed: ${messageOf(cause)}`,
      performed: marked || written.length > 0, outcomeKnown: true, written,
    };
  }
  return {
    ok: true, direction, podId, appId, files: receipt,
    ...(publisher ? { outsideFiles: { publisher } } : {}),
  };
};

/** @param {{binding:any,ctx:any,signal?:AbortSignal,shared?:any,appProgramSemanticToken?:string}} input */
export const createAppToolAuthority = ({
  binding, ctx, signal = ctx?.abortSignal, shared = {}, appProgramSemanticToken,
}) => {
  const args = binding.args;
  const sessionId = ctx?.session?.sessionId;
  const boundAppId = ctx?.actorType === 'app' ? ctx.actorInstanceId : null;
  const requireOperation = (/** @type {string} */ name) => {
    if (binding.operation !== name) throw mismatch();
  };
  const sameApp = (/** @type {unknown} */ appId) => boundAppId
    ? appId === undefined || appId === boundAppId
    : appId === args.appId;
  const appIdFor = (/** @type {string|undefined} */ appId) => boundAppId ?? appId;
  const requireLive = () => {
    if (!signal?.aborted) return;
    throw Object.assign(new Error('App operation stopped before mutation'), {
      outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: false,
    });
  };

  return Object.freeze({
    updateApp: async (
      /** @type {string|undefined} */ appId,
      /** @type {string|undefined} */ name,
      /** @type {string|undefined} */ html,
      /** @type {string[]|undefined} */ tags,
      /** @type {string|undefined} */ entryFile,
    ) => {
      requireOperation('turn.app.update');
      if (!sameApp(appId) || name !== args.name || html !== args.html
          || entryFile !== args.entryFile || !sameCanonicalStructuredClone(
            tags, args.tags, { maxBytes: APP_AUTHORITY_ARGUMENT_BYTES },
          )
          || typeof ctx?.appClient?.update !== 'function') throw mismatch();
      const record = await ctx.appClient.update({
        appId: appIdFor(appId), name, html, tags, entryFile, sessionId, signal,
      });
      return record ? {
        id: record.id, name: record.name, entryFile: record.entryFile,
        updatedAt: record.updatedAt,
      } : null;
    },
    openApp: async (/** @type {string} */ appId) => {
      requireOperation('turn.app.open');
      if (boundAppId || appId !== args.appId || typeof ctx?.appClient?.open !== 'function') {
        throw mismatch();
      }
      return ctx.appClient.open({ appId, sessionId, focus: false });
    },
    searchApps: async (/** @type {string} */ query) => {
      requireOperation('turn.app.search');
      if (boundAppId || query !== String(args.query ?? '').trim()
          || typeof ctx?.appClient?.search !== 'function') throw mismatch();
      const hits = await ctx.appClient.search(query);
      return hits.map((/** @type {any} */ hit) => ({
        app: {
          id: hit.app.id, name: hit.app.name, tags: hit.app.tags,
          updatedAt: hit.app.updatedAt,
        },
        snippet: hit.snippet,
      }));
    },
    readApp: async (/** @type {string} */ appId) => {
      requireOperation('turn.app.read');
      if (!sameApp(appId) || typeof ctx?.appRegistry?.get !== 'function') throw mismatch();
      const targetAppId = appIdFor(appId);
      const record = await ctx.appRegistry.get(targetAppId);
      shared.inspected = record
        ? { id: record.id ?? targetAppId, name: String(record.name ?? '') } : null;
      return shared.inspected;
    },
    deleteApp: async (/** @type {string} */ appId) => {
      requireOperation('turn.app.delete');
      const targetAppId = appIdFor(appId);
      if (!sameApp(appId) || shared.inspected?.id !== targetAppId
          || typeof ctx?.appRegistry?.get !== 'function'
          || typeof ctx?.appClient?.delete !== 'function') throw mismatch();
      const fresh = await ctx.appRegistry.get(targetAppId);
      if (!fresh) throw mismatch();
      // why: the registry probe may wait behind another App mutation. Stop
      // must still win before deletion crosses its first physical edge.
      requireLive();
      return ctx.appClient.delete(targetAppId);
    },
    writeFile: (
      /** @type {string|undefined} */ appId,
      /** @type {string} */ path,
      /** @type {unknown} */ content,
    ) => {
      requireOperation('turn.app.write-file');
      const expected = typeof args.contentBase64 === 'string'
        ? { base64: args.contentBase64 }
        : args.content;
      if (!sameApp(appId) || path !== args.path || !sameCanonicalStructuredClone(
        content, expected, { maxBytes: APP_AUTHORITY_ARGUMENT_BYTES },
      )
          || typeof ctx?.appClient?.writeFile !== 'function') throw mismatch();
      return ctx.appClient.writeFile({
        appId: appIdFor(appId), path, content, sessionId, signal,
      });
    },
    readFile: (/** @type {string|undefined} */ appId, /** @type {string} */ path) => {
      requireOperation('turn.app.read-file');
      if (!sameApp(appId) || path !== args.path
          || typeof ctx?.appClient?.readFile !== 'function') throw mismatch();
      return ctx.appClient.readFile({ appId: appIdFor(appId), path, sessionId });
    },
    listFiles: async (/** @type {string|undefined} */ appId) => {
      requireOperation('turn.app.list-files');
      if (!sameApp(appId) || typeof ctx?.appClient?.listFiles !== 'function') throw mismatch();
      const files = await ctx.appClient.listFiles({ appId: appIdFor(appId), sessionId });
      return files.map((/** @type {any} */ file) => ({ path: file.path, size: file.size }));
    },
    deleteFile: (
      /** @type {string|undefined} */ appId, /** @type {string} */ path,
    ) => {
      requireOperation('turn.app.delete-file');
      if (!sameApp(appId) || path !== args.path
          || typeof ctx?.appClient?.deleteFile !== 'function') throw mismatch();
      return ctx.appClient.deleteFile({ appId: appIdFor(appId), path, sessionId, signal });
    },
    copyPodFiles: async (
      /** @type {unknown} */ direction, /** @type {unknown} */ podId,
      /** @type {unknown} */ appId, /** @type {unknown} */ files,
    ) => {
      requireOperation('turn.app.copy-pod-files');
      // why: an actor is pinned to one instance. Moving bytes between two
      // instances is the orchestrator's call alone.
      if (ctx?.actorType || direction !== args.direction || podId !== args.podId
          || appId !== args.appId || !sameCanonicalStructuredClone(
        files, args.files, { maxBytes: APP_AUTHORITY_ARGUMENT_BYTES },
      )) throw mismatch();
      const checked = validatePodAppCopy(direction, podId, appId, files);
      if (!checked.request) {
        return {
          ok: false, error: checked.error, performed: false, outcomeKnown: true,
          outcomeKind: 'pre-effect-failure',
        };
      }
      return copyBetweenPodAndApp(checked.request, {
        podClient: ctx?.podClient, podRegistry: ctx?.podRegistry,
        appClient: ctx?.appClient, appRegistry: ctx?.appRegistry,
        confirm: ctx?.confirm, signal, sessionId,
        actStillLive: async () => {
          const permission = typeof ctx?.readAuthorityPermission === 'function'
            ? await ctx.readAuthorityPermission().catch(() => ({ mode: 'plan' }))
            : ctx?.permission;
          return permission?.mode === 'act';
        },
      });
    },
    observeRuntime: () => {
      requireOperation('turn.app.observe');
      if (typeof ctx?.appAgentCall !== 'function') return {
        ok: false, error: 'app_playtest_not_available', outcomeKnown: true,
        outcomeKind: 'pre-effect-failure',
      };
      return ctx.appAgentCall('observe', {}, signal);
    },
    actRuntime: (/** @type {string} */ action, /** @type {Record<string,unknown>} */ params) => {
      requireOperation('turn.app.act');
      if (action !== args.action || !sameCanonicalStructuredClone(
        params, args.params ?? {}, { maxBytes: APP_AUTHORITY_ARGUMENT_BYTES },
      )) throw mismatch();
      if (typeof ctx?.appAgentCall !== 'function') return {
        ok: false, error: 'app_playtest_not_available', outcomeKnown: true,
        outcomeKind: 'pre-effect-failure',
      };
      return ctx.appAgentCall('act', { action, params }, signal);
    },
    runCode: async (/** @type {string} */ code, /** @type {number} */ timeoutMs) => {
      requireOperation('turn.app.run-code');
      const expectedTimeout = Math.min(180_000, Math.max(1000, Number(args.timeoutMs ?? 60_000)));
      if (code !== args.code || timeoutMs !== expectedTimeout) throw mismatch();
      const client = ctx?.jsOffscreenClient;
      if (typeof client?.execHeadless !== 'function') return { refusal: 'app_code_unavailable' };
      if (typeof sessionId !== 'string' || !sessionId) {
        return { refusal: 'app_code_requires_actor_session' };
      }
      const scriptRuns = ctx?.scriptRuns;
      if (!scriptRuns) return { refusal: 'app_code_run_registry_unavailable' };
      if (signal?.aborted) return { aborted: true };
      const runId = scriptRuns.mintRunId(sessionId);
      scriptRuns.register(runId, signal, sessionId, { app: true });
      let executionDispatched = false;
      const onAbort = typeof client.abortHeadless === 'function'
        ? () => { client.abortHeadless(runId, sessionId); }
        : null;
      if (onAbort && signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }
      try {
        return await client.execHeadless(code, {
          timeoutMs,
          caps: { app: true, page: false, egress: false, subagent: false, opfs: false },
          ownerSessionId: sessionId,
          runId,
          ...(appProgramSemanticToken ? { appProgramSemanticToken } : {}),
          signal,
          onExecutionDispatch: () => { executionDispatched = true; },
        });
      } catch (cause) {
        const failure = cause instanceof Error ? cause : new Error(String(cause));
        Object.assign(failure, {
          executionDispatched: executionDispatched
            || /** @type {{executionDispatched?:boolean}} */ (cause)?.executionDispatched === true,
          outcomeKnown: executionDispatched
            ? false : /** @type {{outcomeKnown?:boolean}} */ (cause)?.outcomeKnown,
        });
        throw failure;
      } finally {
        scriptRuns.release(runId);
        if (onAbort && signal) {
          try { signal.removeEventListener?.('abort', onAbort); } catch { /* stub */ }
        }
      }
    },
  });
};

export const bindAppToolAuthority = (/** @type {any} */ state, /** @type {any} */ input) => {
  const binding = Object.freeze({ operation: input.operation, args: structuredClone(input.args) });
  return createAppToolAuthority({ ...input, binding, shared: state });
};
