// @ts-check

import { makeSessionMutationRoutes } from './routes/session-mutations.js';
import { makeSessionRoutes } from './routes/sessions.js';
import { makeSystemRoutes } from './routes/system.js';

const TURN_ROUTES = Object.freeze([
  'agent/send',
  'agent/stop',
  'actor/spawn',
  'session/debugBundle',
]);
const SESSION_ROUTES = Object.freeze([
  'session/archive',
  'session/reset',
  'session/switch',
]);
const ISOLATION_ROUTES = Object.freeze(['actor-isolation/retry']);

export const KERNEL_SESSION_TURN_ROUTE_NAMES = Object.freeze([
  ...TURN_ROUTES,
  ...SESSION_ROUTES,
  ...ISOLATION_ROUTES,
]);

/** @param {Record<string, any>} routes @param {readonly string[]} names */
const select = (routes, names) => Object.fromEntries(names.map((name) => {
  const handler = routes[name];
  if (typeof handler !== 'function') throw new TypeError(`kernel-session-turn-route-missing:${name}`);
  return [name, handler];
}));

/**
 * @param {{
 *   turnDeps:Record<string,any>,
 *   sessionDeps:Record<string,any>,
 *   isolationDeps:Record<string,any>,
 * }} deps
 */
export const makeKernelSessionTurnRoutes = ({ turnDeps, sessionDeps, isolationDeps }) =>
  Object.freeze({
    ...select(makeSessionRoutes(turnDeps), TURN_ROUTES),
    ...select(makeSessionMutationRoutes(sessionDeps), SESSION_ROUTES),
    ...select(makeSystemRoutes(isolationDeps), ISOLATION_ROUTES),
  });
