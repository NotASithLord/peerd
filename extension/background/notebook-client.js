// @ts-check
// SW-side Notebook client.
//
// Each Notebook is a tab hosting a Web Worker. This client resolves a
// target Notebook (explicit id or session default, auto-create if
// neither), ensures a tab is alive, and dispatches js/* messages via
// chrome.tabs.sendMessage. Same shape as vm-client; different message
// vocabulary.

import browser from '/vendor/browser-polyfill.js';
import { createKeyedQueue } from '/peerd-engine/index.js';

const MESSAGE_TIMEOUT_MS = 60_000;

export const JS_TAB_GROUP_TITLE = 'peerd';

/**
 * Reply shape from the Notebook tab's js/* handlers. Dynamic over the
 * message channel — typed to the fields the client reads back.
 * @typedef {{ ok?: boolean, error?: string, result?: unknown, content?: unknown, files?: unknown }} JsTabReply
 */

/**
 * @param {Object} deps
 * @param {ReturnType<typeof import('/peerd-engine/index.js').createNotebookRegistry>} deps.registry
 * @param {ReturnType<typeof import('./notebook-tab-tracker.js').createJsTabTracker>} deps.tracker
 */
export const createJsClient = ({ registry, tracker }) => {
  /** @param {{ sessionId?: string, notebookId?: string }} [opts] */
  const resolveId = async ({ sessionId, notebookId } = {}) => {
    if (notebookId) {
      const rec = await registry.get(notebookId);
      if (!rec) throw new Error(`notebook not found: ${notebookId}`);
      return notebookId;
    }
    if (!sessionId) throw new Error('sessionId or notebookId required');
    const defaultId = await registry.getDefaultForSession(sessionId);
    if (defaultId) return defaultId;
    const shortChat = sessionId.length > 6 ? sessionId.slice(-6) : sessionId;
    const created = await registry.create({
      name: `notebook-${shortChat}`,
      ownerSessionId: sessionId,
    });
    await registry.setDefaultForSession(sessionId, created.id);
    return created.id;
  };

  // why a keyed queue (mirrors vm-client.js): the agent loop dispatches
  // consecutive READ-class js tools (js_read_file, js_list_files) CONCURRENTLY,
  // so two implicit-target calls in a fresh chat could BOTH see "no default
  // notebook yet" and race to create two — one becomes an orphan (leaked tab +
  // OPFS scratch) and the reads target different scratch dirs. Serialize lazy
  // default-resolution per session so concurrent first-commands share the one
  // created Notebook. Explicit-id / no-session lookups are pure reads — they
  // skip the lane.
  const queue = createKeyedQueue();
  /** @param {{ sessionId?: string, notebookId?: string }} [opts] */
  const resolveIdQueued = (opts = {}) => {
    if (opts.notebookId || !opts.sessionId) return resolveId(opts);
    return queue.enqueue(`resolve:${opts.sessionId}`, () => resolveId(opts));
  };

  /** @param {string} notebookId @param {{ type: string, [k: string]: unknown }} message */
  const callTab = async (notebookId, message) => {
    // background: agent-driven Notebook tabs never steal focus (DESIGN-12,
    // 2026-06-18). js_create already dropped a "go there" card; an auto-create
    // here opens quietly too. ensureTab early-returns for a live tab.
    await tracker.ensureTab(notebookId, { active: false, groupTitle: JS_TAB_GROUP_TITLE });
    const tabId = tracker.getTabId(notebookId);
    if (tabId == null) throw new Error(`no live tab for ${notebookId} after ensureTab`);
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timeoutId;
    /** @type {Promise<never>} */
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(() => {
        reject(new Error(
          `js ${message.type} timed out after ${MESSAGE_TIMEOUT_MS / 1000}s ` +
          `(tab ${tabId} unresponsive). Reload the Notebook tab.`,
        ));
      }, MESSAGE_TIMEOUT_MS);
    });
    /** @type {JsTabReply} */
    let response;
    try {
      response = /** @type {JsTabReply} */ (await Promise.race([
        browser.tabs.sendMessage(tabId, { ...message, notebookId }),
        timeoutPromise,
      ]));
    } finally {
      clearTimeout(timeoutId);
    }
    if (!response || response.ok !== true) {
      throw new Error(response?.error ?? 'js call returned no response');
    }
    return response;
  };

  return {
    resolveId,

    /** @param {string} code @param {{ sessionId?: string, notebookId?: string, timeoutMs?: number }} [opts] */
    eval: async (code, opts = {}) => {
      const id = await resolveIdQueued(opts);
      const response = await callTab(id, {
        type: 'js/eval',
        code,
        timeoutMs: opts.timeoutMs,
      });
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
