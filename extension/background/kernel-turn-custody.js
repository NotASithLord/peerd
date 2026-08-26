// @ts-check

import {
  createMemoryStore,
  createSessionStore,
  makeTurnSlots,
} from '/peerd-runtime/kernel-custody.js';
import { createPageActivityReporter } from './page-activity.js';

/** @param {Record<string,any>} deps */
export const createKernelTurnCustody = (deps) => {
  if (!deps?.browser || !deps.idb || !deps.kv || !deps.sessionCache
      || !deps.vault || !deps.auditLog || !deps.settingsStore || !deps.uiPorts) {
    throw new TypeError('kernel-turn-custody-config-invalid');
  }
  /** @type {{onSessionMessageAppended?:(sessionId:string,message:any)=>any}|null} */
  let actorRuntime = null;
  const sessions = createSessionStore({
    idb: deps.idb,
    onMessageAppended: (/** @type {string} */ sessionId, /** @type {any} */ message) =>
      actorRuntime?.onSessionMessageAppended?.(sessionId, message),
  });
  const memory = createMemoryStore({ idb: deps.idb });
  const turnSlots = makeTurnSlots({
    onAbort: deps.onAbort,
    forceReleaseMs: deps.turnForceReleaseMs,
  });
  const pageActivity = (deps.makePageActivity ?? createPageActivityReporter)({
    tabs: deps.browser.tabs,
    tabGroups: deps.browser.tabGroups,
    scripting: deps.browser.scripting,
  });
  const shared = Object.freeze({
    browser: deps.browser,
    idb: deps.idb,
    kv: deps.kv,
    sessionCache: deps.sessionCache,
    vault: deps.vault,
    auditLog: deps.auditLog,
    settingsStore: deps.settingsStore,
    uiPorts: deps.uiPorts,
    sessions,
    memory,
    turnSlots,
    pageActivity,
    pushState: deps.pushState,
    postChatNote: deps.postChatNote,
  });
  const releaseRuntime = async (/** @type {unknown} */ runtime) => {
    if (actorRuntime === runtime) actorRuntime = null;
    for (const sessionId of turnSlots.busySessionIds()) turnSlots.stop(sessionId);
    await Promise.all(pageActivity.markedTabs().map(
      (/** @type {number} */ tabId) => pageActivity.release(tabId),
    ));
  };
  return Object.freeze({
    shared,
    isActivityStopSender: (/** @type {any} */ sender, /** @type {any} */ message) =>
      message?.type === 'agent/stop' && message.activity === 'live'
      && typeof sender?.tab?.id === 'number'
      && pageActivity.markedTabs().includes(sender.tab.id),
    bindActorRuntime: (/** @type {any} */ runtime) => {
      if (!runtime || actorRuntime) throw new Error('kernel-turn-custody-runtime-invalid');
      actorRuntime = runtime;
      return () => releaseRuntime(runtime);
    },
  });
};
