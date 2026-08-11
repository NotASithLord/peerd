// @ts-check
// SW-side client for Pod tab RPC. Instance resolution and per-Pod command
// serialization mirror Notebook, while background jobs intentionally bypass
// the queue after dispatch so two Workers may run independently.

import browser from '/vendor/browser-polyfill.js';
import { createKeyedQueue } from '/peerd-engine/index.js';

export const POD_TAB_GROUP_TITLE = 'peerd';
const CALL_TIMEOUT_MS = 310_000;

/** @param {{registry:any,tracker:any,sendTabMessage?:(tabId:number,message:any)=>Promise<any>}} deps */
export const createPodClient = ({ registry, tracker, sendTabMessage = browser.tabs.sendMessage.bind(browser.tabs) }) => {
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

  /** @param {string} podId @param {Record<string,any>} message @param {{open?:boolean}} [options] */
  const callTab = async (podId, message, { open = true } = {}) => {
    if (open) await tracker.ensureTab(podId, { active: false, groupTitle: POD_TAB_GROUP_TITLE });
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
    /** @param {string} command @param {{sessionId?:string,podId?:string,timeoutMs?:number,background?:boolean,remoteGitAuthorized?:boolean}} [options] */
    exec: async (command, options = {}) => {
      const id = await resolveQueued(options);
      const response = await callTab(id, {
        type: 'pod/exec', command, timeoutMs: options.timeoutMs,
        background: options.background === true,
        remoteGitAuthorized: options.remoteGitAuthorized === true,
      });
      return { podId: id, ...response.job };
    },
    /** @param {{sessionId?:string,podId?:string}} [options] */
    status: async (options = {}) => {
      const id = await resolveQueued(options);
      if (tracker.getTabId(id) == null) return { podId: id, state: 'stopped', cwd: '/', jobs: [] };
      return (await callTab(id, { type: 'pod/status' }, { open: false })).status;
    },
    /** @param {string} jobId @param {{sessionId?:string,podId?:string}} [options] */
    cancel: async (jobId, options = {}) => {
      const id = await resolveQueued(options);
      return callTab(id, { type: 'pod/cancel', jobId }, { open: false });
    },
    /** @param {string} path @param {{sessionId?:string,podId?:string}} [options] */
    readFile: async (path, options = {}) => {
      const id = await resolveQueued(options);
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
      const id = await resolveQueued(options);
      return (await callTab(id, { type: 'pod/list-files' })).files;
    },
  };
};
