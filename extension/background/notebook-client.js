// @ts-check
// SW-side Notebook client.
//
// Each Notebook is a tab hosting a Web Worker. This client resolves a
// target Notebook (explicit id or session default, auto-create if
// neither), ensures a tab is alive, and dispatches js/* messages via
// chrome.tabs.sendMessage. Same shape as vm-client; different message
// vocabulary.

import browser from '/shared/browser-api.js';
import { createKeyedQueue } from '/peerd-engine/background.js';
import { createEngineInstanceResolver, raceTabReply, shortSessionSuffix } from './engine-process.js';

const MESSAGE_TIMEOUT_MS = 60_000;

export const JS_TAB_GROUP_TITLE = 'peerd';

/**
 * Reply shape from the Notebook tab's js/* handlers. Dynamic over the
 * message channel — typed to the fields the client reads back.
 * @typedef {{ ok?: boolean, error?: string, code?: string, result?: unknown, content?: unknown, files?: unknown }} JsTabReply
 */

/**
 * @param {Object} deps
 * @param {ReturnType<typeof import('/peerd-engine/background.js').createNotebookRegistry>} deps.registry
 * @param {ReturnType<typeof import('./tab-tracker.js').createJsTabTracker>} deps.tracker
 */
export const createJsClient = ({ registry, tracker }) => {
  // why the shared resolver: explicit id, then the session's current
  // Notebook, then a lazy create is the precedence every engine kind uses. Its
  // resolve lane (the client's keyed queue) matters here because the agent loop
  // dispatches consecutive READ-class js tools concurrently: without it two
  // implicit first calls in a fresh chat could both see "no default notebook
  // yet" and create two, orphaning one (leaked tab + OPFS scratch) and sending
  // the reads to different scratch dirs.
  const queue = createKeyedQueue();
  const instances = createEngineInstanceResolver({
    registry,
    queue,
    notFound: (id) => new Error(`notebook not found: ${id}`),
    missingTarget: () => new Error('sessionId or notebookId required'),
    createOptions: (sessionId) => ({
      name: `notebook-${shortSessionSuffix(sessionId)}`,
      ownerSessionId: sessionId,
    }),
  });
  /** @param {{ sessionId?: string, notebookId?: string }} [opts] */
  const resolveId = ({ sessionId, notebookId } = {}) =>
    instances.resolve({ sessionId, id: notebookId });
  /** @param {{ sessionId?: string, notebookId?: string }} [opts] */
  const resolveIdQueued = ({ sessionId, notebookId } = {}) =>
    instances.resolveQueued({ sessionId, id: notebookId });

  /** @param {string} notebookId @param {{ type: string, [k: string]: unknown }} message @param {AbortSignal} [abortSignal] */
  const callTab = async (notebookId, message, abortSignal) => {
    // background: agent-driven Notebook tabs never steal focus (DESIGN-12,
    // 2026-06-18). sandbox_create already dropped a "go there" card; an auto-create
    // here opens quietly too. ensureTab early-returns for a live tab.
    await tracker.ensureTab(notebookId, { active: false, groupTitle: JS_TAB_GROUP_TITLE });
    const tabId = tracker.getTabId(notebookId);
    if (tabId == null) throw new Error(`no live tab for ${notebookId} after ensureTab`);
    const onAbort = () => {
      browser.tabs.sendMessage(tabId, {
        type: 'js/abort', notebookId, runId: message.runId,
      }).catch(() => {});
    };
    /** @type {JsTabReply} */
    let response;
    try {
      response = /** @type {JsTabReply} */ (await raceTabReply(() => {
        // why dispatch first: an already-aborted signal must not let js/abort
        // race ahead of the exact js/eval it terminates in the receiving tab.
        const messagePromise = browser.tabs.sendMessage(tabId, { ...message, notebookId });
        if (abortSignal?.aborted) onAbort();
        else abortSignal?.addEventListener('abort', onAbort, { once: true });
        return messagePromise;
      }, {
        timeoutMs: MESSAGE_TIMEOUT_MS,
        timeoutError: () => new Error(
          `js ${message.type} timed out after ${MESSAGE_TIMEOUT_MS / 1000}s ` +
          `(tab ${tabId} unresponsive). Reload the Notebook tab.`,
        ),
      }));
    } finally {
      abortSignal?.removeEventListener('abort', onAbort);
    }
    if (!response || response.ok !== true) {
      const err = new Error(response?.error ?? 'js call returned no response');
      // why: re-inflate the OPFS not-found signal the tab flattened into a code,
      // so callers (edit_file 3a) can tell an absent notebook file — a legit
      // whole-file create — from a genuine read fault. Matches the App client,
      // which surfaces a real NotFoundError DOMException directly.
      if (response?.code === 'not_found') err.name = 'NotFoundError';
      throw err;
    }
    return response;
  };

  return {
    resolveId,

    /** @param {string} code @param {{ sessionId?: string, notebookId?: string, timeoutMs?: number, signal?: AbortSignal }} [opts] */
    eval: async (code, opts = {}) => {
      const id = await resolveIdQueued(opts);
      const runId = crypto.randomUUID();
      const response = await callTab(id, {
        type: 'js/eval',
        runId,
        code,
        timeoutMs: opts.timeoutMs,
      }, opts.signal);
      return response.result;
    },

    /** @param {string} path @param {string} content @param {{ sessionId?: string, notebookId?: string }} [opts] */
    writeFile: async (path, content, opts = {}) => {
      const id = await resolveIdQueued(opts);
      await callTab(id, {
        type: 'js/write-file',
        path,
        content,
      });
    },

    /** @param {string} path @param {{ sessionId?: string, notebookId?: string }} [opts] */
    readFile: async (path, opts = {}) => {
      const id = await resolveIdQueued(opts);
      const response = await callTab(id, { type: 'js/read-file', path });
      return response.content;
    },

    /** @param {{ sessionId?: string, notebookId?: string }} [opts] */
    listFiles: async (opts = {}) => {
      const id = await resolveIdQueued(opts);
      const response = await callTab(id, { type: 'js/list-files' });
      return response.files;
    },
  };
};
