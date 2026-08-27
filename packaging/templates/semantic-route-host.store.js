// @ts-check
// Store semantic dispatcher. Contributor Metrics is absent from this target;
// its route cluster is neither imported nor represented by a fallback handler.

import { SEMANTIC_HOST_ROUTE_CLASSIFICATIONS } from '../shared/semantic-host-route-manifest.js';
import { makeBoundedModuleLoader } from '../shared/bounded-module-load.js';
import { createSemanticDispatchRuntime } from './semantic-dispatch-runtime.js';

const actorRoutes = makeBoundedModuleLoader(() => import('./semantic-routes/actors.js'));
const appRoutes = makeBoundedModuleLoader(() => import('./semantic-routes/apps.js'));
const contactRoutes = makeBoundedModuleLoader(() => import('./semantic-routes/contacts.js'));
const providerRoutes = makeBoundedModuleLoader(() => import('./semantic-routes/providers.js'));
const memoryRoutes = makeBoundedModuleLoader(() => import('./semantic-routes/memory.js'));
const routeHandler = (/** @type {()=>Promise<any>} */ load, /** @type {string} */ method) => (
  /** @type {string} */ route,
) => async (/** @type {any} */ message, /** @type {any} */ options) => {
  let routes;
  try { routes = await load(); }
  catch (cause) {
    const detail = /** @type {any} */ (cause);
    return {
      ok: false,
      code: detail?.code ?? 'semantic-route-module-load-failed',
      error: 'Feature unavailable. Try again.',
      outcomeKnown: true,
      retryable: true,
      phase: 'startup',
    };
  }
  return routes[method](route, message, options);
};
const actor = routeHandler(actorRoutes, 'dispatchActorSemanticRoute');
const apps = routeHandler(appRoutes, 'dispatchAppSemanticRoute');
const contacts = routeHandler(contactRoutes, 'dispatchContactSemanticRoute');
const providers = routeHandler(providerRoutes, 'dispatchProviderSemanticRoute');
const memory = routeHandler(memoryRoutes, 'dispatchMemorySemanticRoute');
const runtime = createSemanticDispatchRuntime({
  classifications: SEMANTIC_HOST_ROUTE_CLASSIFICATIONS,
  handlers: {
    'actors/overview': actor('actors/overview'),
    'actors/count': actor('actors/count'),
    'app/get-meta': apps('app/get-meta'),
    'apps/favorite': apps('apps/favorite'),
    'apps/open': apps('apps/open'),
    'apps/rename': apps('apps/rename'),
    'contacts/forget': contacts('contacts/forget'),
    'contacts/set': contacts('contacts/set'),
    'memory/delete': memory('memory/delete'),
    'memory/deleteAll': memory('memory/deleteAll'),
    'memory/suggestions': memory('memory/suggestions'),
    'memory/suggestions/approve': memory('memory/suggestions/approve'),
    'memory/suggestions/dismiss': memory('memory/suggestions/dismiss'),
    'memory/write': memory('memory/write'),
    'provider/status': providers('provider/status'),
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
