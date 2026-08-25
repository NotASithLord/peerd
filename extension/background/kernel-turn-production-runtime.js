// @ts-check

import {
  createMemoryStore,
  createSessionStore,
  makeTurnSlots,
} from '../peerd-runtime/background.js';
import { makeSessionState } from './session-state.js';
import { createPageActivityReporter } from './page-activity.js';
import { createKernelTurnRuntime } from './kernel-turn-runtime.js';

export const KERNEL_TURN_RELAY_ROUTE_NAMES = Object.freeze([
  'a2a/call', 'actors/call', 'page/call', 'site-fetch/call',
]);

const requiredFunction = (/** @type {Record<string,any>} */ value, /** @type {string} */ key) => {
  if (typeof value?.[key] !== 'function') {
    throw new TypeError(`kernel-turn-production-${key}-invalid`);
  }
};

/** @param {any} deps */
export const createKernelTurnProductionRuntime = async (deps) => {
  if (!deps?.seams || !deps.browser || !deps.idb || !deps.kv || !deps.sessionCache
      || !deps.vault || !deps.auditLog || !deps.settingsStore || !deps.uiPorts
      || !deps.factories || !deps.goal) {
    throw new TypeError('kernel-turn-production-config-invalid');
  }
  for (const key of ['makeDriverDeps', 'makeRouteDeps', 'makeActorRuntime']) {
    requiredFunction(deps.factories, key);
  }
  /** @type {any} */
  let actorRuntime = null;
  const sessions = createSessionStore({
    idb: deps.idb,
    onMessageAppended: (/** @type {string} */ sessionId, /** @type {any} */ message) =>
      actorRuntime?.onSessionMessageAppended?.(sessionId, message),
  });
  const memory = createMemoryStore({ idb: deps.idb });
  const sessionState = makeSessionState();
  const turnSlots = makeTurnSlots({
    onAbort: (/** @type {string} */ sessionId) => deps.onAbort?.(sessionId),
  });
  const pageActivity = (deps.makePageActivity ?? createPageActivityReporter)({
    tabs: deps.browser.tabs,
    tabGroups: deps.browser.tabGroups,
    scripting: deps.browser.scripting,
  });
  /** @type {any} */
  let runtime = null;
  const shared = Object.freeze({
    browser: deps.browser, idb: deps.idb, kv: deps.kv,
    sessionCache: deps.sessionCache, vault: deps.vault, auditLog: deps.auditLog,
    settingsStore: deps.settingsStore, uiPorts: deps.uiPorts,
    sessions, memory, sessionState, turnSlots, pageActivity,
    pushState: deps.pushState, postChatNote: deps.postChatNote,
  });
  actorRuntime = await deps.factories.makeActorRuntime(shared);
  if (!actorRuntime || typeof actorRuntime.actorCount !== 'function'
      || typeof actorRuntime.actorOverview !== 'function') {
    throw new TypeError('kernel-turn-production-actors-invalid');
  }
  const driverDeps = deps.factories.makeDriverDeps({ ...shared, actorRuntime });
  const routeDeps = deps.factories.makeRouteDeps({ ...shared, actorRuntime });
  if (!driverDeps || !routeDeps?.turn || !routeDeps?.session || !routeDeps?.isolation) {
    throw new TypeError('kernel-turn-production-deps-invalid');
  }
  const marked = () => new Set(pageActivity.markedTabs());
  const isActivityStopSender = (/** @type {any} */ sender, /** @type {any} */ message) =>
    message?.type === 'agent/stop' && message.activity === 'live'
    && typeof sender?.tab?.id === 'number' && marked().has(sender.tab.id);
  const relays = {
    ...(actorRuntime.relays ?? {}),
    sessions, turnSlots, pageActivity, isActivityStopSender,
    activeGoalStates: () => runtime?.goalRunner.activeStates?.() ?? [],
  };
  if (!relays.scriptRuns || !relays.sessions) {
    throw new TypeError('kernel-turn-production-relay-state-invalid');
  }
  if (!relays.engineReady || typeof relays.engineReady.then !== 'function') {
    throw new TypeError('kernel-turn-production-engine-ready-invalid');
  }
  if (!relays.relayRoutes || KERNEL_TURN_RELAY_ROUTE_NAMES.some(
    (name) => typeof relays.relayRoutes[name] !== 'function',
  ) || typeof relays.relayRoutes['review/run'] === 'function') {
    throw new TypeError('kernel-turn-production-relay-routes-invalid');
  }
  for (const key of [
    'validateGeneration', 'retireStale', 'dispatchToolCall', 'buildActorContext',
    'appActorChat', 'activeGoalStates', 'broadcastAgentTab', 'onUiConnect',
    'showWebTabHint', 'isDrivenSource', 'webActorSessionForTab',
    'handleRichKernelCall', 'resumeSchedules',
  ]) {
    if (typeof relays[key] !== 'function') {
      throw new TypeError(`kernel-turn-production-relay-${key}-invalid`);
    }
  }
  for (const key of [
    'onCreated', 'onUpdated', 'onRemoved', 'onActivated',
    'onNavigationTarget', 'onBeforeRequest', 'reconcile',
  ]) {
    if (typeof relays.eventOwners?.[key] !== 'function') {
      throw new TypeError(`kernel-turn-production-event-${key}-invalid`);
    }
  }
  runtime = createKernelTurnRuntime({
    seams: deps.seams,
    turnDriverDeps: { ...driverDeps, ...shared },
    turnRouteDeps: { ...routeDeps.turn, ...shared },
    sessionDeps: { ...routeDeps.session, ...shared },
    isolationDeps: { ...routeDeps.isolation },
    goal: deps.goal,
    ensureReady: deps.ensureReady,
    actorProjection: actorRuntime,
    relays,
    makeDriver: deps.factories.makeDriver,
    makeGoals: deps.factories.makeGoals,
    onClose: async () => {
      for (const tabId of pageActivity.markedTabs()) await pageActivity.release(tabId);
      await actorRuntime.close?.();
      await deps.onClose?.();
    },
  });
  return runtime;
};
