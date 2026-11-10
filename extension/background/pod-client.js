// @ts-check
// SW-side client for Pod tab RPC. Instance resolution and per-Pod command
// serialization mirror Notebook, while background jobs intentionally bypass
// the queue after dispatch so two Workers may run independently.

import browser from '/shared/browser-api.js';
import { createKeyedQueue } from '/peerd-engine/background.js';
import { createEngineInstanceResolver, raceTabReply, shortSessionSuffix } from './engine-process.js';
import { fromBase64, toBase64 } from '/shared/bundle/bytes.js';

export const POD_TAB_GROUP_TITLE = 'peerd';
const CALL_TIMEOUT_MS = 310_000;
const WORKSPACE_LOCK_RENEW_MS = 10_000;

/** @param {{registry:any,tracker:any,sendTabMessage?:(tabId:number,message:any)=>Promise<any>,setIntervalFn?:(callback:()=>void,ms:number)=>any,clearIntervalFn?:(handle:any)=>void}} deps */
export const createPodClient = ({
  registry,
  tracker,
  sendTabMessage = browser.tabs.sendMessage.bind(browser.tabs),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
}) => {
  const resolveQueue = createKeyedQueue();
  // why the shared resolver: explicit podId, then the session's current Pod,
  // then a persistent Pod owned by this session is the precedence every engine
  // kind uses. Reads, status and cancellation use resolveExisting so inspecting
  // a chat with no Pod never creates durable state.
  const instances = createEngineInstanceResolver({
    registry,
    queue: resolveQueue,
    notFound: (id) => new Error(`Pod not found: ${id}`),
    missingTarget: () => new Error('sessionId or podId required'),
    createOptions: (sessionId) => ({
      name: `pod-${shortSessionSuffix(sessionId)}`, ownerSessionId: sessionId, persistent: true,
    }),
    missingDefault: () => new Error('No current Pod for this session'),
  });

  /** @param {{sessionId?:string,podId?:string}} [options] */
  const resolveId = ({ sessionId, podId } = {}) => instances.resolve({ sessionId, id: podId });

  /** @param {{sessionId?:string,podId?:string}} options */
  const resolveQueued = ({ sessionId, podId }) => instances.resolveQueued({ sessionId, id: podId });

  /** Resolve a Pod for a read/cancel operation without creating durable state.
   * @param {{sessionId?:string,podId?:string}} [options] */
  const resolveExistingId = ({ sessionId, podId } = {}) =>
    instances.resolveExisting({ sessionId, id: podId });

  /** @param {string} podId @param {Record<string,any>} message @param {{open?:boolean,signal?:AbortSignal}} [options] */
  const callTab = async (podId, message, { open = true, signal } = {}) => {
    if (open) await tracker.ensureTab(podId, { active: false, groupTitle: POD_TAB_GROUP_TITLE });
    // A foreground Stop may land while a throttled/background Pod tab is still
    // opening. Recheck at the actual dispatch boundary so that cancellation
    // cannot miss an as-yet unknown job and then let the command start late.
    if (signal?.aborted) throw new Error('Pod command cancelled before dispatch');
    const tabId = tracker.getTabId(podId);
    if (tabId == null) throw new Error(`Pod ${podId} is stopped`);
    const response = /** @type {any} */ (await raceTabReply(
      () => sendTabMessage(tabId, { ...message, podId }),
      {
        timeoutMs: CALL_TIMEOUT_MS,
        timeoutError: () => new Error(`Pod ${message.type} timed out; outcome may be unknown`),
      },
    ));
    if (!response?.ok) throw new Error(response?.error ?? 'Pod returned no response');
    return response;
  };

  return {
    resolveId,
    resolveExistingId,
    /** @param {string} command @param {{sessionId?:string,podId?:string,timeoutMs?:number,background?:boolean,remoteGitGrant?:{op:string,url:string}|null,signal?:AbortSignal}} [options] */
    exec: async (command, options = {}) => {
      const id = await resolveQueued(options);
      const jobId = `job-${crypto.randomUUID()}`;
      const signal = options.background === true ? undefined : options.signal;
      if (signal?.aborted) throw new Error('Pod command cancelled before start');
      const onAbort = () => {
        callTab(id, { type: 'pod/cancel', jobId }, { open: false }).catch(() => {});
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        const response = await callTab(id, {
          type: 'pod/exec', jobId, command, timeoutMs: options.timeoutMs,
          background: options.background === true,
          remoteGitGrant: options.remoteGitGrant ?? null,
        }, { signal });
        return { podId: id, ...response.job };
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },
    /** @param {{sessionId?:string,podId?:string,jobId?:string,stream?:'stdout'|'stderr',offset?:number,limit?:number}} [options] */
    status: async (options = {}) => {
      const id = await resolveExistingId(options);
      const record = await registry.get(id);
      if (tracker.getTabId(id) == null) return {
        podId: id, ...(typeof record?.name === 'string' ? { name: record.name } : {}),
        persistent: record?.persistent !== false, state: 'stopped', cwd: '/', jobs: [],
      };
      return (await callTab(id, {
        type: 'pod/status', jobId: options.jobId, stream: options.stream,
        offset: options.offset, limit: options.limit,
      }, { open: false })).status;
    },
    /** @param {string} jobId @param {{sessionId?:string,podId?:string}} [options] */
    cancel: async (jobId, options = {}) => {
      const id = await resolveExistingId(options);
      if (tracker.getTabId(id) == null) return { podId: id, jobId, cancelled: false, state: 'stopped' };
      return callTab(id, { type: 'pod/cancel', jobId }, { open: false });
    },
    /** @param {string} path @param {{sessionId?:string,podId?:string}} [options] */
    readFile: async (path, options = {}) => {
      const id = await resolveExistingId(options);
      return (await callTab(id, { type: 'pod/read-file', path })).content;
    },
    /** Read one workspace file without text decoding. A lock token from
     * withWorkspaceLock reads inside that hold instead of queuing behind it.
     * @param {string} path @param {{sessionId?:string,podId?:string,lockToken?:string}} [options] */
    readBytes: async (path, options = {}) => {
      const id = await resolveExistingId(options);
      const response = await callTab(id, {
        type: 'pod/read-bytes', path, ...(options.lockToken ? { lockToken: options.lockToken } : {}),
      }, { open: !options.lockToken });
      return fromBase64(String(response.base64 ?? ''));
    },
    /** @param {string} path @param {string|Uint8Array} content @param {{sessionId?:string,podId?:string}} [options] */
    writeFile: async (path, content, options = {}) => {
      // why: tab messages are JSON on Chrome, so bytes travel as base64.
      const id = content instanceof Uint8Array
        ? await resolveExistingId(options) : await resolveQueued(options);
      await callTab(id, content instanceof Uint8Array
        ? { type: 'pod/write-file', path, contentBase64: toBase64(content) }
        : { type: 'pod/write-file', path, content });
      return id;
    },
    /** Record or clear outside files, then tell a live Pod tab.
     * @param {string} podId @param {{publisher:string,appId:string,appName:string,markedAt:number}|null} mark */
    setOutsideFiles: async (podId, mark) => {
      const id = await resolveExistingId({ podId });
      if (!await registry.update(id, { outsideFiles: mark })) throw new Error(`Pod not found: ${id}`);
      if (tracker.getTabId(id) != null) {
        await callTab(id, { type: 'pod/outside-files', mark }, { open: false }).catch(() => {});
      }
      return id;
    },
    /** @param {{sessionId?:string,podId?:string}} [options] */
    listFiles: async (options = {}) => {
      const id = await resolveExistingId(options);
      return (await callTab(id, { type: 'pod/list-files' })).files;
    },
    /** Hold the live Pod tab's filesystem lane while trusted repository code runs.
     * The operation receives the lock token, or null when no tab is live.
     * @template T @param {string} podId @param {(lockToken:string|null)=>Promise<T>} operation @returns {Promise<T>} */
    withWorkspaceLock: async (podId, operation) => {
      const id = await resolveExistingId({ podId });
      if (tracker.getTabId(id) == null) return operation(null);
      const token = `lock-${crypto.randomUUID()}`;
      // Start renewal while acquire is queued: the tab registers the token
      // before awaiting older workspace work, so a long predecessor cannot
      // expire a live request. If this MV3 worker is evicted, renewals stop and
      // the tab's lease releases the orphaned hold automatically.
      const acquiring = callTab(id, {
        type: 'pod/workspace-lock', action: 'acquire', token,
      }, { open: false });
      let renewTail = Promise.resolve();
      const renewal = setIntervalFn(() => {
        renewTail = renewTail.then(() => callTab(id, {
          type: 'pod/workspace-lock', action: 'renew', token,
        }, { open: false })).then(() => undefined, () => undefined);
      }, WORKSPACE_LOCK_RENEW_MS);
      try {
        await acquiring;
        return await operation(token);
      }
      finally {
        clearIntervalFn(renewal);
        await renewTail;
        await callTab(id, { type: 'pod/workspace-lock', action: 'release', token }, { open: false }).catch(() => {});
      }
    },
  };
};
