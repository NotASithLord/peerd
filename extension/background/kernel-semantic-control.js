// @ts-check

import { SEMANTIC_DISPATCH_PROTOCOL } from '../shared/semantic-dispatch-contract.js';
import { SEMANTIC_HOST_ROUTE_MANIFEST } from '../shared/semantic-host-route-manifest.js';
import { STARTUP_UNAVAILABLE_USER_FAILURE } from '../shared/bounded-module-load.js';

const READS = new Set([
  'actors/count', 'actors/overview', 'contacts/list', 'memory/export',
  'memory/suggestions', 'provider/status', 'skills/list', 'contributor/status',
]);
const KERNEL_ACTOR_ROUTES = Object.freeze(['actors/count', 'actors/overview']);

const CONTRIBUTOR_OPERATIONS = new Set([
  'semantic.contributor.read',
  'semantic.contributor.enable-read',
  'semantic.contributor.enable',
  'semantic.contributor.disable-read',
  'semantic.contributor.clear',
  'semantic.contributor.settlement-read',
  'semantic.contributor.settlement-record',
  'semantic.contributor.feedback-read',
  'semantic.contributor.feedback-record',
]);

/** @param {any} deps */
export const createKernelSemanticControl = ({
  callSemantic, isHomeSender, vault, authority,
  contributorAuthority = null,
  localRoutes = {},
  actorCount = () => ({ activeActors: 0 }),
  actorOverview = () => ({ roots: [] }),
  awaitReady = async () => {},
  routes = null,
}) => {
  if (contributorAuthority !== null && typeof contributorAuthority !== 'function') {
    throw new TypeError('kernel-contributor-authority-invalid');
  }
  const grants = new WeakMap();
  const directRoutes = Object.freeze({ ...localRoutes });
  const ownedRoutes = routes ?? [...new Set([
    ...SEMANTIC_HOST_ROUTE_MANIFEST.filter((row) =>
      !row.route.startsWith('contributor/')).map((row) => row.route),
    ...KERNEL_ACTOR_ROUTES,
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
        // why: this is already a minimized, host-stamped authority projection.
        // Sending it through the single-flight semantic host adds no semantics
        // and makes live observability disappear while actor turns own that host.
        const projected = await (route === 'actors/count' ? actorCount() : actorOverview());
        if (projected?.ok === false) return projected;
        // The turn owner validates and minimizes the authority payload, while
        // the public UI route still owns the ordinary RPC success envelope.
        return { ok: true, ...projected };
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
    dispatchContributor: (/** @type {string} */ route, /** @type {any} */ message) => {
      if (!['contributor/status', 'contributor/enable', 'contributor/disable'].includes(route)
          || contributorAuthority === null) {
        return { ok: false, code: 'contributor-channel-admission-denied', outcomeKnown: true };
      }
      return dispatch(route, message, 'options');
    },
    authorize: (/** @type {unknown} */ payload) => {
      if (!payload || typeof payload !== 'object') return null;
      const authorityGrant = grants.get(/** @type {object} */ (payload)) ?? null;
      grants.delete(/** @type {object} */ (payload));
      return authorityGrant;
    },
    handleKernelCall: (/** @type {string} */ operation, /** @type {unknown} */ payload,
      /** @type {any} */ context) => CONTRIBUTOR_OPERATIONS.has(operation)
      ? contributorAuthority?.(operation, payload, context)
        ?? { ok: false, code: 'semantic-kernel-operation-denied', outcomeKnown: true }
      : authority.handle(operation, payload, context),
  });
};
