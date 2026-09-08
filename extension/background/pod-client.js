// @ts-check
// SW-side client for Pod tab RPC. Instance resolution and per-Pod command
// serialization mirror Notebook, while background jobs intentionally bypass
// the queue after dispatch so two Workers may run independently.

import browser from '/shared/browser-api.js';
import { createKeyedQueue } from '/peerd-engine/background.js';

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

  /** @param {{sessionId?:string,podId?:string}} [options] */
  const resolveId = async ({ sessionId, podId } = {}) => {
    if (podId) {
      if (!await registry.get(podId)) throw new Error(`Pod not found: ${podId}`);
      return podId;
    }
    if (!sessionId) throw new Error('sessionId or podId required');
    const current = await registry.getDefaultForSession(sessionId);
    if (current) return current;
    const created = await registry.create({ name: `pod-${sessionId.slice(-6)}`, ownerSessionId: sessionId, persistent: true });
    await registry.setDefaultForSession(sessionId, created.id);
    return created.id;
  };

  /** @param {{sessionId?:string,podId?:string}} options */
  const resolveQueued = (options) => options.podId || !options.sessionId
    ? resolveId(options)
    : resolveQueue.enqueue(`resolve:${options.sessionId}`, () => resolveId(options));

  /** Resolve a Pod for a read/cancel operation without creating durable state.
   * @param {{sessionId?:string,podId?:string}} [options] */
  const resolveExistingId = async ({ sessionId, podId } = {}) => {
    if (podId) {
      if (!await registry.get(podId)) throw new Error(`Pod not found: ${podId}`);
      return podId;
    }
    if (!sessionId) throw new Error('sessionId or podId required');
    const current = await registry.getDefaultForSession(sessionId);
    if (!current) throw new Error('No current Pod for this session');
    return current;
  };

  /** @param {string} podId @param {Record<string,any>} message @param {{open?:boolean,signal?:AbortSignal}} [options] */
  const callTab = async (podId, message, { open = true, signal } = {}) => {
    if (open) await tracker.ensureTab(podId, { active: false, groupTitle: POD_TAB_GROUP_TITLE });
    // A foreground Stop may land while a throttled/background Pod tab is still
    // opening. Recheck at the actual dispatch boundary so that cancellation
    // cannot miss an as-yet unknown job and then let the command start late.
    if (signal?.aborted) throw new Error('Pod command cancelled before dispatch');
    const tabId = tracker.getTabId(podId);
    if (tabId == null) throw new Error(`Pod ${podId} is stopped`);
    /** @type {ReturnType<typeof setTimeout>|undefined} */ let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Pod ${message.type} timed out; outcome may be unknown`)), CALL_TIMEOUT_MS); });
    try {
      const response = /** @type {any} */ (await Promise.race([
        sendTabMessage(tabId, { ...message, podId }), timeout,
      ]));
      if (!response?.ok) throw new Error(response?.error ?? 'Pod returned no response');
      return response;
    } finally { clearTimeout(timer); }
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
    /** @param {string} path @param {string} content @param {{sessionId?:string,podId?:string}} [options] */
    writeFile: async (path, content, options = {}) => {
      const id = await resolveQueued(options);
      await callTab(id, { type: 'pod/write-file', path, content });
      return id;
    },
    /** @param {{sessionId?:string,podId?:string}} [options] */
    listFiles: async (options = {}) => {
      const id = await resolveExistingId(options);
      return (await callTab(id, { type: 'pod/list-files' })).files;
    },
    /** Hold the live Pod tab's filesystem lane while trusted repository code runs.
     * @template T @param {string} podId @param {()=>Promise<T>} operation @returns {Promise<T>} */
    withWorkspaceLock: async (podId, operation) => {
      const id = await resolveExistingId({ podId });
      if (tracker.getTabId(id) == null) return operation();
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
        return await operation();
      }
      finally {
        clearIntervalFn(renewal);
        await renewTail;
        await callTab(id, { type: 'pod/workspace-lock', action: 'release', token }, { open: false }).catch(() => {});
      }
    },
  };
};
