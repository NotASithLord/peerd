// @ts-check
import { makeHooksRoutes } from './routes/hooks.js';
import { makeMemoryRoutes } from './routes/memory.js';
import { makeSkillsRoutes } from './routes/skills.js';
import { makeKernelLazyOwner } from './kernel-lazy-owner.js';
import {
  makeKernelEffectState, settleKernelEffect, trackKernelEffect,
} from './kernel-route-effect.js';
import { makeSerialLane } from '../shared/cold-util.js';

/** @param {Record<string, any>} deps */
export const makeKernelHooksRoutes = (deps) => {
  const load = makeKernelLazyOwner(deps, (live) => live);
  const write = makeSerialLane();
  const mutation = (/** @type {string} */ name) => async (
    /** @type {any} */ message = {}, /** @type {any} */ _sender = undefined,
  ) => write(async () => {
    const live = await load();
    const state = makeKernelEffectState();
    const kv = {
      get: (/** @type {string} */ key) => live.kv.get(key),
      set: trackKernelEffect(live.kv.set.bind(live.kv), state, live.canWrite ?? null),
    };
    const route = makeHooksRoutes({ ...live, kv })[name];
    return settleKernelEffect(() => route(message), state, 'hooks-write-outcome-unknown');
  });
  return Object.freeze({
    'hooks/list': async (message = {}) => {
      const live = await load();
      return makeHooksRoutes(live)['hooks/list'](message);
    },
    'hooks/save': mutation('hooks/save'),
    'hooks/remove': mutation('hooks/remove'),
    'hooks/toggle': mutation('hooks/toggle'),
  });
};

/** @param {Record<string, any>} deps */
export const makeKernelMemoryInitRoutes = (deps) => {
  const load = makeKernelLazyOwner(deps, (live) => live);
  const routes = makeMemoryRoutes({
    runInit: async () => {
      const live = await load();
      live.canWrite?.();
      return live.runInit();
    },
    postChatNote: deps.postChatNote,
  });
  return Object.freeze({ 'memory/init': routes['memory/init'] });
};

/** @param {Record<string, any>} deps */
export const makeKernelSkillInstallRoutes = (deps) => {
  const load = makeKernelLazyOwner(deps, (live) => live);
  const write = makeSerialLane();
  const mutation = (/** @type {string} */ name) => async (
    /** @type {any} */ message = {}, /** @type {any} */ _sender = undefined,
  ) => write(async () => {
    const live = await load();
    const state = makeKernelEffectState();
    const skillRegistry = {
      install: trackKernelEffect(
        live.skillRegistry.install.bind(live.skillRegistry), state, live.canWrite ?? null,
        (cause) => cause instanceof live.SkillExistsError
          || cause instanceof live.SkillParseError || cause instanceof live.SkillInstallError,
      ),
    };
    const pushState = () => {
      try { Promise.resolve(live.pushState()).catch(() => {}); }
      catch {}
    };
    const route = makeSkillsRoutes({ ...live, skillRegistry, pushState })[name];
    return settleKernelEffect(() => route(message), state, 'skills-install-outcome-unknown');
  });
  return Object.freeze({
    'skills/installGit': mutation('skills/installGit'),
    'skills/installLocal': mutation('skills/installLocal'),
    'skills/installManifest': mutation('skills/installManifest'),
  });
};

/** @param {Record<string, any>} deps
 * @returns {Readonly<Record<string, Function>>} */
