// @ts-check

import { createKernelTurnRuntime } from './kernel-turn-runtime.js';
import { KERNEL_PAGE_PROGRAM_ROUTE_NAMES } from '../shared/kernel-feature-route-inventory.js';

export const KERNEL_TURN_RELAY_ROUTE_NAMES = Object.freeze([
  'a2a/call', 'actors/list', 'actors/call', 'site-fetch/call', ...KERNEL_PAGE_PROGRAM_ROUTE_NAMES,
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
      || !deps.factories || !deps.goal || !deps.custody?.shared
      || typeof deps.custody.bindActorRuntime !== 'function'
      || typeof deps.custody.isActivityStopSender !== 'function') {
    throw new TypeError('kernel-turn-production-config-invalid');
  }
  for (const key of [
    'makeDriverDeps', 'makeRouteDeps', 'makeActorRuntime',
    'makeDriver', 'makeGoals',
  ]) {
    requiredFunction(deps.factories, key);
  }
  if (!Number.isSafeInteger(deps.factories.goalMaxIterations)
      || deps.factories.goalMaxIterations < 1) {
    throw new TypeError('kernel-turn-production-goalMaxIterations-invalid');
  }
  /** @type {any} */
  let runtime = null;
  const shared = deps.custody.shared;
  const actorRuntime = await deps.factories.makeActorRuntime(shared);
  if (!actorRuntime || typeof actorRuntime.actorCount !== 'function'
      || typeof actorRuntime.actorOverview !== 'function') {
    throw new TypeError('kernel-turn-production-actors-invalid');
  }
  const driverDeps = deps.factories.makeDriverDeps({ ...shared, actorRuntime });
  const routeDeps = deps.factories.makeRouteDeps({ ...shared, actorRuntime });
  if (!driverDeps || !routeDeps?.turn || !routeDeps?.session || !routeDeps?.isolation) {
    throw new TypeError('kernel-turn-production-deps-invalid');
  }
  const relays = {
    ...(actorRuntime.relays ?? {}),
    sessions: shared.sessions,
    turnSlots: shared.turnSlots,
    pageActivity: shared.pageActivity,
    isActivityStopSender: deps.custody.isActivityStopSender,
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
  )) {
    throw new TypeError('kernel-turn-production-relay-routes-invalid');
  }
  for (const key of [
    'validateGeneration', 'retireStale',
    'appActorChat', 'activeGoalStates', 'broadcastAgentTab', 'onUiConnect',
    'showWebTabHint', 'isDrivenSource', 'webActorSessionForTab',
    'resumeSchedules',
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
  const releaseCustody = deps.custody.bindActorRuntime(actorRuntime);
  try {
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
      goalMaxIterations: deps.factories.goalMaxIterations,
      onClose: async () => {
        await releaseCustody();
        await actorRuntime.close?.();
        await deps.onClose?.();
      },
    });
  } catch (cause) {
    await releaseCustody();
    await actorRuntime.close?.();
    throw cause;
  }
  return runtime;
};
