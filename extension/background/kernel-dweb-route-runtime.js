// @ts-check

import {
  applyAppsSurface,
  applySessionsSurface,
  captureAppsSurface,
  shapeMemorySurface,
  shapeSessionsSurface,
  shapeSettingsSurface,
  SurfaceApplyPartialError,
} from '/peerd-runtime/transfer/self-sync-surfaces.js';
import { makeDwebRoutes } from './routes/dweb.js';
import { makeDwebSelfRoutes } from './routes/dweb-self.js';
import { createDwebRollbackGuard } from './dweb-rollback-guard.js';
import { makeDwebShare } from './dweb-share.js';
import { createKernelDwebReseedOwner } from './kernel-dweb-reseed-owner.js';

const base64FileBytes = (/** @type {string} */ value) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
};

/** @param {Record<string,any>} deps */
export const createKernelDwebRouteOwner = (deps) => {
  if (!deps?.enabled || !deps.engine || !deps.relays || !deps.transfer
      || typeof deps.ensureDwebFeature !== 'function'
      || typeof deps.withIdentityMutation !== 'function'
      || typeof deps.currentDwebHostEpoch !== 'function') {
    throw new TypeError('kernel-dweb-route-runtime-config-invalid');
  }
  const { engine, relays, transfer } = deps;
  const active = () => deps.settingsStore.get().dwebEnabled === true && !deps.vault.isLocked();
  const dwebReady = async () => {
    try { await deps.ensureSettingsReady(); }
    catch { return false; }
    return active();
  };
  const sendMessage = (/** @type {any} */ message) => deps.browser.runtime.sendMessage(message);
  const callBaseHost = (/** @type {string} */ type, /** @type {any} */ payload = {}) =>
    sendMessage({ type, ...payload });
  const applySettings = async (/** @type {any} */ patch) => {
    const { dwebEnabled: _transportControl, ...portablePatch } = patch ?? {};
    const normalized = transfer.normalizeImportedSettings(portablePatch);
    if (Object.keys(normalized).length === 0) return { written: 0 };
    transfer.onSettingsChanging(normalized);
    await deps.settingsStore.update(normalized);
    try {
      await transfer.onSettingsChanged(normalized);
      await deps.pushState();
    } catch (cause) {
      throw new SurfaceApplyPartialError('settings', {
        written: Object.keys(normalized).length, sideEffectsCompleted: 0,
      }, /** @type {Error} */ (cause));
    }
    return { written: Object.keys(normalized).length };
  };
  const surfaceShapers = {
    sessions: async () => shapeSessionsSurface({ sessions: await relays.sessions.list() }),
    memory: async () => shapeMemorySurface({ memory: await transfer.memory.exportAll() }),
    settings: async () => shapeSettingsSurface({ settings: deps.settingsStore.stored() }),
    apps: async () => captureAppsSurface({
      records: await engine.appRegistry.list(),
      snapshotApp: async (/** @type {any} */ record) => {
        const snapshot = await engine.appClient.snapshotFilesBase64({ appId: record.id });
        return {
          id: record.id,
          name: record.name,
          entryFile: snapshot.record.entryFile,
          fileKinds: snapshot.record.fileKinds,
          files: Object.fromEntries(Object.entries(snapshot.files).map(
            ([path, file]) => [path, /** @type {any} */ (file).base64],
          )),
        };
      },
    }),
  };
  const surfaceAppliers = {
    sessions: async (/** @type {any} */ payload) => applySessionsSurface(payload, {
      existingIds: new Set((await relays.sessions.list()).map(
        (/** @type {any} */ session) => session.sessionId,
      )),
      putSession: (/** @type {any} */ session) => relays.sessions.importPortable(session),
    }),
    memory: async (/** @type {any} */ payload) => {
      if (!payload || payload.v !== 1 || !Object.hasOwn(payload, 'memory')) {
        throw new Error('memory surface payload is malformed or unsupported');
      }
      return transfer.memory.importAll(payload.memory);
    },
    settings: async (/** @type {any} */ payload) => {
      if (!payload || payload.v !== 1 || !payload.settings
          || typeof payload.settings !== 'object' || Array.isArray(payload.settings)) {
        throw new Error('settings surface payload is malformed or unsupported');
      }
      return applySettings(payload.settings);
    },
    apps: async (/** @type {any} */ payload) => applyAppsSurface(payload, {
      existingHashes: new Set((await engine.appRegistry.list())
        .flatMap((/** @type {any} */ app) => [app.syncContentHash, app.dweb?.hash])
        .filter(Boolean)),
      installApp: (/** @type {any} */ app) => engine.appClient.create({
        name: app.name,
        syncContentHash: app.contentHash,
        entryFile: app.entryFile,
        fileKinds: app.fileKinds,
        files: Object.fromEntries(Object.entries(app.files ?? {}).map(
          ([path, bytes]) => [path, base64FileBytes(/** @type {string} */ (bytes))],
        )),
      }),
    }),
  };
  const shareLocalApp = makeDwebShare({
    enabled: true,
    active,
    withDwebPublication: engine.withDwebPublication,
    withIdentityMutation: deps.withIdentityMutation,
    withAppLifecycle: engine.withAppLifecycle,
    withAppWriteLock: (/** @type {string} */ appId, /** @type {()=>Promise<any>} */ operation) =>
      engine.appQuiescence.runUnlocked(
        appId, () => engine.appClient.withWriteLock(appId, operation),
      ),
    appRegistry: engine.appRegistry,
    repositories: engine.repositories,
    prepareRuntime: async () => {
      await deps.ensureDwebFeature();
      return sendMessage({ type: 'dweb/base-host/start' });
    },
    sendMessage,
  });
  const routes = Object.freeze({
    ...makeDwebRoutes({
      vault: deps.vault,
      auditLog: deps.auditLog,
      kv: deps.kv,
      ensureDwebFeature: deps.ensureDwebFeature,
      browser: deps.browser,
      appRegistry: engine.appRegistry,
      appClient: engine.appClient,
      appTabTracker: engine.appTabTracker,
      appQuiescence: engine.appQuiescence,
      settingsStore: deps.settingsStore,
      shareLocalApp,
      DWEB_ENABLED: true,
      APP_TAB_GROUP_TITLE: 'peerd',
      disableDweb: async () => {
        engine.invalidateDwebPublications();
        return deps.disableDweb();
      },
      withDwebPublication: engine.withDwebPublication,
      withAppLifecycle: engine.withAppLifecycle,
      ensureSettingsReady: deps.ensureSettingsReady,
      repositories: engine.repositories,
      isOffscreenSender: deps.isOffscreenSender,
      createDwebRollbackGuard,
      getCurrentSessionId: deps.getCurrentSessionId,
      dwebPublicationGeneration: engine.dwebPublicationGeneration,
      ensureAppTrackerReady: deps.ensureAppTrackerReady,
    }),
    ...makeDwebSelfRoutes({
      dwebReady,
      isOffscreenSender: deps.isOffscreenSender,
      callBaseHost,
      surfaceShapers,
      surfaceAppliers,
      auditLog: deps.auditLog,
    }),
  });
  const reseed = createKernelDwebReseedOwner({
    active,
    locked: deps.vault.isLocked,
    appRegistry: engine.appRegistry,
    withDwebPublication: engine.withDwebPublication,
    withAppLifecycle: engine.withAppLifecycle,
    repositories: engine.repositories,
    sendMessage,
    currentHostEpoch: deps.currentDwebHostEpoch,
  });
  return Object.freeze({ routes, reseed });
};
