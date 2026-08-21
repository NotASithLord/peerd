// @ts-check
// Sealed semantic dispatcher shell. Route families are fixed-literal dynamic
// imports: the first semantic call loads only its reviewed cluster, while every
// cluster remains explicit in packaging and controller build identity.

import { SEMANTIC_HOST_ROUTE_CLASSIFICATIONS } from '../shared/semantic-host-route-manifest.js';
import { createSemanticDispatchRuntime } from './semantic-dispatch-runtime.js';

const actor = (/** @type {string} */ route) => (
  /** @type {any} */ message,
  /** @type {any} */ options,
) => import('./semantic-routes/actors.js')
  .then((module) => module.dispatchActorSemanticRoute(route, message));
const toolbox = (/** @type {string} */ route) => (
  /** @type {any} */ message,
  /** @type {any} */ options,
) => import('./semantic-routes/toolbox.js')
  .then((module) => module.dispatchToolboxSemanticRoute(route, message, options));
const contacts = (/** @type {string} */ route) => (
  /** @type {any} */ message,
  /** @type {any} */ options,
) => import('./semantic-routes/contacts.js')
  .then((module) => module.dispatchContactsSemanticRoute(route, message, options));
const contributor = (/** @type {string} */ route) => (
  /** @type {any} */ message,
  /** @type {any} */ options,
) => import('./semantic-routes/contributor.js')
  .then((module) => module.dispatchContributorSemanticRoute(route, message, options));
const providers = (/** @type {string} */ route) => (
  /** @type {any} */ message,
  /** @type {any} */ options,
) => import('./semantic-routes/providers.js')
  .then((module) => module.dispatchProviderSemanticRoute(route, message, options));
const memory = (/** @type {string} */ route) => (
  /** @type {any} */ message,
  /** @type {any} */ options,
) => import('./semantic-routes/memory.js')
  .then((module) => module.dispatchMemorySemanticRoute(route, message, options));
const runtime = createSemanticDispatchRuntime({
  classifications: SEMANTIC_HOST_ROUTE_CLASSIFICATIONS,
  handlers: {
    'actors/overview': actor('actors/overview'),
    'actors/count': actor('actors/count'),
    'contacts/forget': contacts('contacts/forget'),
    'contacts/list': contacts('contacts/list'),
    'contacts/set': contacts('contacts/set'),
    'contributor/disable': contributor('contributor/disable'),
    'contributor/enable': contributor('contributor/enable'),
    'contributor/status': contributor('contributor/status'),
    'memory/delete': memory('memory/delete'),
    'memory/deleteAll': memory('memory/deleteAll'),
    'memory/export': memory('memory/export'),
    'memory/suggestions': memory('memory/suggestions'),
    'memory/suggestions/approve': memory('memory/suggestions/approve'),
    'memory/suggestions/dismiss': memory('memory/suggestions/dismiss'),
    'memory/write': memory('memory/write'),
    'provider/status': providers('provider/status'),
    'toolbox/read': toolbox('toolbox/read'),
    'toolbox/record': toolbox('toolbox/record'),
  },
});

export const dispatchSemanticRoute = async (/** @type {unknown} */ payload,
  /** @type {any} */ options) => {
  const result = /** @type {any} */ (await runtime.dispatch(payload, options));
  if (typeof result?.code === 'string' && result.code.startsWith('semantic-dispatch-')) {
    return result;
  }
  return { ok: true, outcomeKnown: true, semanticResult: result };
};
