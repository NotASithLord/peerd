// @ts-check
// Transitional compatibility-worker adapter. The native thin entry imports
// the independent Actors, Contacts, and Toolbox adapters directly; this file
// keeps their existing compatibility-worker wiring in one module so the old
// cold graph does not grow while it remains the differential oracle.

import { SEMANTIC_DISPATCH_PROTOCOL } from '../shared/structured-clone-size.js';

const refused = (/** @type {string} */ error) => ({ ok: false, error });
const text = (/** @type {unknown} */ value, max = 512) => typeof value === 'string'
  ? value.slice(0, max) : value;
const actorCard = (/** @type {any} */ actor) => ({
  sessionId: text(actor?.sessionId), rootSessionId: text(actor?.rootSessionId),
  parentSessionId: text(actor?.parentSessionId), parentToolUseId: text(actor?.parentToolUseId),
  kind: text(actor?.kind), instanceId: text(actor?.instanceId), name: text(actor?.name),
  task: text(actor?.task), depth: actor?.depth,
  grantedTools: Array.isArray(actor?.grantedTools)
    ? actor.grantedTools.slice(0, 128).map((/** @type {unknown} */ value) => text(value)) : [],
  streaming: actor?.streaming === true, running: actor?.running === true,
  cost: typeof actor?.cost?.cost === 'number' ? { cost: actor.cost.cost } : null,
});
const semanticTopology = (/** @type {any} */ topology) => ({
  actors: Object.fromEntries(Object.entries(topology?.actors ?? {})
    .map(([id, actor]) => [text(id), actorCard(actor)])),
  spawned: {
    byToolUse: Object.fromEntries(Object.entries(topology?.spawned?.byToolUse ?? {})
      .map(([id, sessionId]) => [text(id), text(sessionId)])),
    sessions: Object.fromEntries(Object.entries(topology?.spawned?.sessions ?? {})
      .map(([id, actor]) => [text(id), actorCard(actor)])),
  },
  asyncTasks: Object.fromEntries(Object.entries(topology?.asyncTasks ?? {}).map(([id, tasks]) => [
    text(id), (Array.isArray(tasks) ? tasks : []).slice(0, 256).map((task) => ({
      taskId: text(task?.taskId), childSessionId: text(task?.childSessionId),
      task: text(task?.task), status: text(task?.status),
      grantedTools: Array.isArray(task?.grantedTools)
        ? task.grantedTools.slice(0, 128).map((/** @type {unknown} */ value) => text(value)) : [],
    })),
  ])),
});

/**
 * @param {Object} deps
 * @param {(payload:any, options?:any)=>Promise<any>} deps.callSemantic
 * @param {(sender:any)=>boolean} deps.isHomeSender
 * @param {{isLocked:()=>boolean}} deps.vault
 * @param {{getMetadata:(id:string)=>Promise<any>,getLatestNonSyntheticUserMessage:(id:string)=>Promise<any>}} deps.sessions
 * @param {{rootSessionIds:()=>string[],snapshot:(id:string)=>any,activeActorCount:()=>number}} deps.actorLiveProjection
 * @param {{busySessionIds:()=>string[],isBusy:(id:string)=>boolean}} deps.turnSlots
 * @param {{getBody:(name:any)=>Promise<any>,recordRuns:(names:any[],result:{ok:boolean})=>Promise<void>}} deps.toolboxStore
 * @param {{list:()=>Promise<any[]>}} deps.auditLog
 * @param {{list:()=>Promise<any[]>,upsert:(did:string,patch:Record<string,unknown>)=>Promise<any>,remove:(did:string)=>Promise<boolean>}} deps.contacts
 * @param {{list:()=>Promise<any[]>}} deps.appRegistry
 */
export const makeSemanticRouteKernel = (deps) => {
  const grants = new WeakMap();
  const authorityFor = (
    /** @type {string} */ route,
    /** @type {'A'|'E'} */ replayClass,
    /** @type {string} */ senderClass,
  ) => ({
    ownerId: 'peerd-authority-kernel', sessionId: null, instanceId: null,
    origin: null, target: `semantic:${route}:${senderClass}`, replayClass,
  });
  const dispatch = (
    /** @type {string} */ route,
    /** @type {any} */ message,
    /** @type {any} */ authority,
  ) => {
    const payload = { protocol: SEMANTIC_DISPATCH_PROTOCOL, route, message };
    grants.set(payload, authority);
    return deps.callSemantic(payload);
  };
  const collectOverview = async () => {
    const rootIds = [...new Set([
      ...deps.actorLiveProjection.rootSessionIds(), ...deps.turnSlots.busySessionIds(),
    ])];
    const roots = [];
    for (const sessionId of rootIds) {
      const metadata = await deps.sessions.getMetadata(sessionId);
      const kind = metadata?.kind ?? 'chat';
      if (!metadata || kind === 'spawned' || kind === 'actor'
          || metadata.archivedAt !== undefined) continue;
      const topology = deps.actorLiveProjection.snapshot(sessionId);
      const busy = !!deps.turnSlots.isBusy(sessionId);
      const activeTopology = Object.keys(topology?.actors ?? {}).length > 0
        || Object.keys(topology?.spawned?.sessions ?? {}).length > 0
        || Object.values(topology?.asyncTasks ?? {}).some((tasks) => Array.isArray(tasks)
          && tasks.some((task) => task?.status === 'running' || task?.status === 'done'));
      roots.push({
        sessionId,
        metadata: {
          kind: metadata.kind, title: text(metadata.title),
          provider: text(metadata.provider), model: text(metadata.model),
        },
        topology: semanticTopology(topology), busy,
        latestRequest: busy || activeTopology
          ? { content: text((await deps.sessions.getLatestNonSyntheticUserMessage(sessionId))?.content) }
          : null,
      });
    }
    return { roots };
  };
  /** @type {Promise<any>|null} */ let overviewInFlight = null;
  const routes = Object.freeze({
    'actors/overview': async (/** @type {any} */ message, /** @type {any} */ sender) => {
      if (!deps.isHomeSender(sender)) return refused('actor-overview-unauthorized');
      if (deps.vault.isLocked()) return refused('locked');
      if (overviewInFlight) return overviewInFlight;
      const current = collectOverview().then((kernelContext) => dispatch(
        'actors/overview', { ...message, kernelContext },
        authorityFor('actors/overview', 'A', 'home'),
      ));
      overviewInFlight = current;
      void current.finally(() => {
        if (overviewInFlight === current) overviewInFlight = null;
      }).catch(() => {});
      return current;
    },
    'actors/count': async (/** @type {any} */ message, /** @type {any} */ sender) => {
      if (!deps.isHomeSender(sender)) return refused('actor-overview-unauthorized');
      if (deps.vault.isLocked()) return refused('locked');
      return dispatch('actors/count', {
        ...message, kernelContext: { activeActors: deps.actorLiveProjection.activeActorCount() },
      }, authorityFor('actors/count', 'A', 'home'));
    },
    'contacts/list': (/** @type {any} */ message) => deps.vault.isLocked()
      ? refused('vault-locked')
      : dispatch('contacts/list', message, authorityFor('contacts/list', 'A', 'first-party')),
    'contacts/set': (/** @type {any} */ message) => deps.vault.isLocked()
      ? refused('vault-locked')
      : dispatch('contacts/set', message, authorityFor('contacts/set', 'E', 'first-party')),
    'contacts/forget': (/** @type {any} */ message) => deps.vault.isLocked()
      ? refused('vault-locked')
      : dispatch('contacts/forget', message,
        authorityFor('contacts/forget', 'E', 'first-party')),
    'toolbox/read': (/** @type {any} */ message) => dispatch(
      'toolbox/read', message, authorityFor('toolbox/read', 'A', 'first-party'),
    ),
    'toolbox/record': (/** @type {any} */ message) => dispatch(
      'toolbox/record', message, authorityFor('toolbox/record', 'E', 'first-party'),
    ),
  });
  const authorize = (/** @type {unknown} */ payload) => {
    if (!payload || typeof payload !== 'object') return null;
    const key = /** @type {object} */ (payload);
    const authority = grants.get(key) ?? null;
    grants.delete(key);
    return authority;
  };
  const handleKernelCall = async (
    /** @type {string} */ operation,
    /** @type {any} */ payload,
    /** @type {any} */ context,
  ) => {
    const target = context?.authority?.target;
    try {
      if (operation === 'semantic.toolbox.get-body'
          && target === 'semantic:toolbox/read:first-party') {
        return { ok: true, value: await deps.toolboxStore.getBody(payload?.name) };
      }
      if (operation === 'semantic.toolbox.record-runs'
          && target === 'semantic:toolbox/record:first-party') {
        await deps.toolboxStore.recordRuns(Array.isArray(payload?.names) ? payload.names : [], {
          ok: payload?.ok === true,
        });
        return { ok: true };
      }
      if (operation === 'semantic.contacts.list-saved'
          && target === 'semantic:contacts/list:first-party') {
        return { ok: true, value: await deps.contacts.list() };
      }
      if (operation === 'semantic.contacts.list-apps'
          && target === 'semantic:contacts/list:first-party') {
        return { ok: true, value: await deps.appRegistry.list() };
      }
      if (operation === 'semantic.contacts.list-audit'
          && target === 'semantic:contacts/list:first-party') {
        return { ok: true, value: await deps.auditLog.list() };
      }
      if (operation === 'semantic.contacts.upsert'
          && target === 'semantic:contacts/set:first-party') {
        return { ok: true, value: await deps.contacts.upsert(payload?.did, payload?.patch ?? {}) };
      }
      if (operation === 'semantic.contacts.remove'
          && target === 'semantic:contacts/forget:first-party') {
        return { ok: true, value: await deps.contacts.remove(payload?.did) };
      }
    } catch (cause) {
      return { ok: false, error: cause instanceof Error ? cause.message : String(cause) };
    }
    return { ok: false, code: 'semantic-kernel-operation-denied', outcomeKnown: true };
  };
  return Object.freeze({ routes, authorize, handleKernelCall });
};
