// @ts-check

import { SEMANTIC_DISPATCH_PROTOCOL } from '../shared/semantic-dispatch-contract.js';
import { SEMANTIC_HOST_ROUTE_CLASSIFICATIONS } from '../shared/semantic-host-route-manifest.js';
import { STARTUP_UNAVAILABLE_USER_FAILURE } from '../shared/bounded-module-load.js';

const READS = new Set([
  'actors/count', 'actors/overview', 'contacts/list', 'memory/export',
  'memory/suggestions', 'provider/status', 'skills/list',
]);

/** @param {any} deps */
export const createKernelSemanticControl = ({
  callSemantic, isHomeSender, vault, authority,
  localRoutes = {},
  actorCount = () => ({ activeActors: 0 }),
  actorOverview = () => ({ roots: [] }),
  awaitReady = async () => {},
  routes = null,
}) => {
  const grants = new WeakMap();
  const directRoutes = Object.freeze({ ...localRoutes });
  const ownedRoutes = routes ?? [...new Set([
    ...SEMANTIC_HOST_ROUTE_CLASSIFICATIONS.filter((row) =>
      !row.route.startsWith('contributor/')).map((row) => row.route),
    ...Object.keys(directRoutes),
  ])];
  const dispatch = (/** @type {string} */ route, /** @type {any} */ message,
    /** @type {string} */ senderClass, /** @type {any} */ kernelContext = undefined) => {
    const payload = {
      protocol: SEMANTIC_DISPATCH_PROTOCOL,
      route,
      message: { ...message, type: route, ...(kernelContext ? { kernelContext } : {}) },
    };
    grants.set(payload, Object.freeze({
      ownerId: 'peerd-authority-kernel', sessionId: null, instanceId: null,
      origin: null, target: `semantic:${route}:${senderClass}`,
      replayClass: READS.has(route) ? 'A' : 'E',
    }));
    return callSemantic(payload);
  };
  const handlers = Object.fromEntries(ownedRoutes.map((/** @type {string} */ route) => [route,
    async (/** @type {any} */ message = {}, /** @type {any} */ sender = undefined) => {
      const wait = async () => {
        try { await awaitReady(); return null; }
        catch {
          return {
            ok: false, error: STARTUP_UNAVAILABLE_USER_FAILURE,
            code: 'kernel-semantic-startup-failed', outcomeKnown: true,
            retryable: true, phase: 'startup',
          };
        }
      };
      if (directRoutes[route]) {
        const unavailable = await wait();
        if (unavailable) return unavailable;
        if (vault.isLocked()) return { ok: false, error: 'vault-locked' };
        return directRoutes[route](message, sender);
      }
      if (route.startsWith('actors/')) {
        if (!isHomeSender(sender)) return { ok: false, error: 'actor-overview-unauthorized' };
        const unavailable = await wait();
        if (unavailable) return unavailable;
        if (vault.isLocked()) return { ok: false, error: 'locked' };
        return dispatch(route, message, 'home',
          await (route === 'actors/count' ? actorCount() : actorOverview()));
      }
      const unavailable = await wait();
      if (unavailable) return unavailable;
      if (vault.isLocked()) {
        return { ok: false, error: 'vault-locked' };
      }
      return dispatch(route, message, 'first-party');
    },
  ]));
  return Object.freeze({
    routes: Object.freeze(handlers),
    dispatchProjected: dispatch,
    authorize: (/** @type {unknown} */ payload) => {
      if (!payload || typeof payload !== 'object') return null;
      const authorityGrant = grants.get(/** @type {object} */ (payload)) ?? null;
      grants.delete(/** @type {object} */ (payload));
      return authorityGrant;
    },
    handleKernelCall: authority.handle,
  });
};
