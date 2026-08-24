// @ts-check
import { makeEngineRoutes } from './routes/engine.js';
import { makeKernelLazyOwner } from './kernel-lazy-owner.js';
import {
  kernelUnknownOutcome, makeKernelEffectState, settleKernelEffect, trackKernelEffect,
} from './kernel-route-effect.js';
import { makeSerialLane } from '../shared/cold-util.js';

const POD_ROUTES = Object.freeze([
  'pod/cancel-io', 'pod/get-meta', 'pod/git', 'pod/web-fetch',
]);
const WEB_FETCH_ROUTES = Object.freeze(['sw/web-fetch', 'sw/web-fetch-abort']);
const ARTIFACT_READ_ROUTES = Object.freeze(['export/artifact', 'import/inspect']);

/** @param {Record<string,any>} deps @param {readonly string[]} names @param {string} refused
 * @param {(route:string,message:any,sender:any)=>boolean} admit
 * @param {(deps:Record<string,any>)=>Record<string,any>} [decorate] */
const makeOwner = (deps, names, refused, admit, decorate = (live) => live) => {
  if (typeof admit !== 'function') throw new TypeError('kernel-engine-route-provenance-required');
  const load = makeKernelLazyOwner(deps, (live) => makeEngineRoutes(decorate(live)));
  return Object.freeze(Object.fromEntries(names.map((name) => [name, async (
    /** @type {any} */ message = {}, /** @type {any} */ sender = undefined,
  ) => {
    if (!admit(name, message, sender)) {
      return { ok: false, error: refused, outcomeKnown: true };
    }
    return (await load())[name](message, sender);
  }])));
};

/** @param {Record<string,any>} live */
const preserveNetworkUnknown = (live) => ({
  ...live,
  vmHttpFetch: async (/** @type {any} */ request) => {
    try { return await live.vmHttpFetch(request); }
    catch (cause) {
      const method = String(request?.method ?? 'GET').toUpperCase();
      if (method !== 'GET' || /** @type {{outcomeKnown?:unknown}} */ (cause)?.outcomeKnown === false) {
        return kernelUnknownOutcome('engine-network-outcome-unknown');
      }
      throw cause;
    }
  },
});

/** @param {Record<string,any>} deps */
export const makeKernelPodRoutes = (deps) => makeOwner(
  deps, POD_ROUTES, 'pod-route-unauthorized', deps.isAllowed, preserveNetworkUnknown,
);

/** @param {Record<string,any>} deps */
export const makeKernelWebFetchRoutes = (deps) => makeOwner(
  deps, WEB_FETCH_ROUTES, 'web-fetch-route-unauthorized', deps.isAllowed,
  preserveNetworkUnknown,
);

/** @param {Record<string,any>} deps
 * @returns {Readonly<Record<string,(message?:any,sender?:any)=>Promise<any>>>} */
export const makeKernelArtifactRoutes = (deps) => {
  const read = makeOwner(
    deps, ARTIFACT_READ_ROUTES, 'artifact-route-unauthorized', deps.isAllowed,
  );
  const load = makeKernelLazyOwner(deps, (live) => live);
  const write = makeSerialLane();
  const apply = async (/** @type {any} */ message = {}, /** @type {any} */ sender = undefined) => {
    if (!deps.isAllowed('import/apply', message, sender)) {
      return { ok: false, error: 'artifact-route-unauthorized', outcomeKnown: true };
    }
    return write(async () => {
      const live = await load();
      const state = makeKernelEffectState();
      const canWrite = live.canWrite ?? null;
      const appClient = {
        ...live.appClient,
        create: trackKernelEffect(live.appClient.create.bind(live.appClient), state, canWrite),
      };
      const jsRegistry = {
        ...live.jsRegistry,
        create: trackKernelEffect(live.jsRegistry.create.bind(live.jsRegistry), state, canWrite),
      };
      const vmRegistry = {
        ...live.vmRegistry,
        create: trackKernelEffect(live.vmRegistry.create.bind(live.vmRegistry), state, canWrite),
      };
      const browser = {
        ...live.browser,
        storage: {
          ...live.browser.storage,
          local: {
            ...live.browser.storage.local,
            set: trackKernelEffect(
              live.browser.storage.local.set.bind(live.browser.storage.local), state, canWrite,
            ),
          },
        },
      };
      const opfsHelpers = (/** @type {string[]} */ root) => {
        const opfs = live.opfsHelpers(root);
        return {
          ...opfs,
          write: trackKernelEffect(opfs.write.bind(opfs), state, canWrite),
        };
      };
      const pushState = () => {
        try { Promise.resolve(live.pushState()).catch(() => {}); }
        catch {}
      };
      const route = makeEngineRoutes({
        ...live, appClient, jsRegistry, vmRegistry, browser, opfsHelpers, pushState,
      })['import/apply'];
      return settleKernelEffect(
        () => route(message, sender), state, 'artifact-import-outcome-unknown', true,
      );
    });
  };
  return Object.freeze({ ...read, 'import/apply': apply });
};

/** @param {Record<string,any>} deps */
export const makeKernelAppDeleteRoutes = (deps) => {
  const load = makeKernelLazyOwner(deps, (live) => live);
  const write = makeSerialLane();
  return Object.freeze({
    'apps/delete': async (/** @type {any} */ message = {}, /** @type {any} */ sender = undefined) => {
      if (!deps.isAllowed('apps/delete', message, sender)) {
        return { ok: false, error: 'app-delete-unauthorized', outcomeKnown: true };
      }
      return write(async () => {
        const live = await load();
        const state = makeKernelEffectState();
        const canWrite = live.canWrite ?? null;
        canWrite?.();
        const appClient = {
          ...live.appClient,
          delete: async (/** @type {any[]} */ ...args) => {
            try {
              const deleted = await live.appClient.delete(...args);
              if (deleted) state.completed = true;
              return deleted;
            } catch (cause) {
              state.lost = true;
              throw cause;
            }
          },
        };
        const browser = {
          ...live.browser,
          runtime: {
            ...live.browser.runtime,
            sendMessage: async (/** @type {any[]} */ ...args) => {
              try { return await live.browser.runtime.sendMessage(...args); }
              catch (cause) { state.lost = true; throw cause; }
            },
          },
        };
        const route = makeEngineRoutes({ ...live, appClient, browser })['apps/delete'];
        return settleKernelEffect(
          () => route(message, sender), state, 'app-delete-outcome-unknown', true,
        );
      });
    },
  });
};
