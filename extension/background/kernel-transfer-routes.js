// @ts-check
import { makeSettingsRoutes } from './routes/settings.js';
import { makeSystemRoutes } from './routes/system.js';
import { makeKernelLazyOwner } from './kernel-lazy-owner.js';
import {
  makeKernelEffectState, settleKernelEffect, trackKernelEffect,
} from './kernel-route-effect.js';
import { makeSerialLane } from '../shared/cold-util.js';

/** @param {Record<string,any>} deps */
export const makeKernelTransferRoutes = (deps) => {
  if (typeof deps.privateTransferAuthorization !== 'symbol') {
    throw new TypeError('kernel-transfer-authorization-required');
  }
  const admitted = (/** @type {any} */ message) =>
    message?.privateTransferAuthorization === deps.privateTransferAuthorization;
  const refused = Object.freeze({ ok: false, error: 'private-transfer-required' });
  const load = makeKernelLazyOwner(deps, (live) => live);
  const read = makeKernelLazyOwner(deps, (live) => ({
    export: makeSettingsRoutes({
      ...live, privateTransferAuthorization: deps.privateTransferAuthorization,
    })['transfer/export'],
    inspect: makeSystemRoutes({
      ...live, privateTransferAuthorization: deps.privateTransferAuthorization,
    })['transfer/inspectImport'],
  }));
  const write = makeSerialLane();
  return Object.freeze({
    'transfer/export': async (/** @type {any} */ message = {}) => admitted(message)
      ? (await read()).export(message) : refused,
    'transfer/inspectImport': async (/** @type {any} */ message = {}) => admitted(message)
      ? (await read()).inspect(message) : refused,
    'transfer/import': async (/** @type {any} */ message = {}) => admitted(message)
      ? write(async () => {
        const live = await load();
        const state = makeKernelEffectState();
        const known = (/** @type {unknown} */ cause) => live.isWriteRefusal?.(cause) === true;
        const canWrite = live.canWrite ?? null;
        const onSettingsChanging = (/** @type {any[]} */ ...args) => {
          try { canWrite?.(); }
          catch (cause) { state.refusal = cause; throw cause; }
          try { return live.onSettingsChanging?.(...args); }
          catch (cause) { state.lost = true; throw cause; }
        };
        const onSettingsChanged = async (/** @type {any[]} */ ...args) => {
          try { return await live.onSettingsChanged?.(...args); }
          catch (cause) { state.lost = true; throw cause; }
        };
        const onProviderConfigChanged = (/** @type {any[]} */ ...args) => {
          try { return live.onProviderConfigChanged?.(...args); }
          catch (cause) { state.lost = true; throw cause; }
        };
        const settingsStore = {
          update: trackKernelEffect(
            live.settingsStore.update.bind(live.settingsStore), state, null, known,
          ),
        };
        const kv = {
          get: live.kv.get.bind(live.kv),
          set: trackKernelEffect(live.kv.set.bind(live.kv), state, canWrite, known),
        };
        const vault = {
          isLocked: () => live.vault.isLocked(),
          setSecret: trackKernelEffect(
            live.vault.setSecret.bind(live.vault), state, canWrite, known,
          ),
        };
        const memory = {
          importAll: trackKernelEffect(
            live.memory.importAll.bind(live.memory), state, canWrite, known,
          ),
        };
        const saveUserHook = trackKernelEffect(live.saveUserHook, state, canWrite, known);
        const dwebTransfer = live.dwebTransfer ? {
          prepareRecord: live.dwebTransfer.prepareRecord.bind(live.dwebTransfer),
          adoptRecord: async (/** @type {any[]} */ ...args) => args[2]?.prepareOnly
            ? live.dwebTransfer.adoptRecord(...args)
            : trackKernelEffect(
                live.dwebTransfer.adoptRecord.bind(live.dwebTransfer), state, canWrite, known,
              )(...args),
        } : live.dwebTransfer;
        const pushState = () => {
          try { Promise.resolve(live.pushState()).catch(() => {}); }
          catch {}
        };
        const route = makeSystemRoutes({
          ...live, settingsStore, kv, vault, memory, saveUserHook, dwebTransfer, pushState,
          onSettingsChanging, onSettingsChanged, onProviderConfigChanged,
          privateTransferAuthorization: deps.privateTransferAuthorization,
        })['transfer/import'];
        try {
          return await settleKernelEffect(
            () => route(message), state, 'transfer-import-outcome-unknown',
          );
        } catch (cause) {
          if (!state.refusal) throw cause;
          return {
            ok: false,
            error: /** @type {{message?:string}} */ (cause)?.message ?? 'write-refused',
            code: /** @type {{code?:string}} */ (cause)?.code ?? 'transfer-import-refused',
            outcomeKnown: true,
          };
        }
      }) : refused,
  });
};
