// @ts-check
import m from '/vendor/mithril/mithril.js';
import browser from '/shared/browser-api.js';
import {
  coldStateIsCurrent,
  normalizeColdStateSnapshot,
} from '/shared/kernel-state-shell.js';
import {
  parseVaultPostureIndex,
  VAULT_POSTURE_INDEX_KEY,
} from '/shared/vault-posture-contract.js';
import { makeUiRuntimeClient } from '/shared/ui-runtime-client.js';
import { VaultGate } from './components/vault-gate.js';

/**
 * @typedef {object} VaultShellState
 * @property {boolean} hydrated
 * @property {{
 *   initialized: boolean,
 *   locked: boolean,
 *   unlockedAt: number,
 *   prfEnrolled: boolean,
 *   hasRecovery: boolean,
 *   lockReason?: 'idle'|'manual'|null,
 * }} vault
 * @property {{authorityEpoch?: string}|undefined} [projection]
 */

/** @type {VaultShellState['vault']} */
const EMPTY_VAULT = Object.freeze({
  initialized: false,
  locked: true,
  unlockedAt: 0,
  prfEnrolled: false,
  hasRecovery: false,
  lockReason: null,
});

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Keep the CSP-safe shell visible for two frames. @param {() => void} start */
export const afterStaticShellPaint = (start) => {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const node = document.querySelector('#app > .boot-shell');
    const rect = node?.getBoundingClientRect();
    const style = node ? getComputedStyle(node) : null;
    if (!node || !rect || rect.width <= 0 || rect.height <= 0
        || style?.visibility === 'hidden' || style?.display === 'none') {
      throw new Error('static vault shell did not paint');
    }
    document.documentElement.dataset.peerdStaticShellPainted = 'true';
    start();
  }));
};

/**
 * @param {{
 *   portName: 'sidepanel'|'home',
 *   appSelector: string,
 *   loadApplication: () => Promise<()=>void>,
 *   appLoadTimeoutMs?: number,
 * }} options
 */
export const startVaultShell = ({
  portName, appSelector, loadApplication, appLoadTimeoutMs = 10_000,
}) => {
  const root = document.getElementById('app');
  if (!root) throw new Error('vault shell mount is missing');

  /** @type {VaultShellState} */
  let snapshot = { hydrated: false, vault: EMPTY_VAULT };
  /** @type {import('webextension-polyfill').Runtime.Port | null} */
  let port = null;
  let transitioning = false;
  let stopped = false;
  let authoritativeStateSeen = false;
  let reboundAfterReady = false;
  let refreshGeneration = 0;
  let applicationGeneration = 0;
  const retiredAuthorityEpochs = new Set();
  /** @type {Promise<void> | null} */
  let refreshPromise = null;
  let portRetryMs = 200;
  const uiRuntime = makeUiRuntimeClient({ browser });
  document.documentElement.dataset.peerdBootStage = 'vault-loading';

  const renderFailure = (/** @type {unknown} */ cause = undefined) => {
    document.documentElement.dataset.peerdBootStage = 'failed';
    document.documentElement.dataset.peerdBootError = cause instanceof Error
      ? `${cause.name}:${cause.message}`.slice(0, 512) : 'unknown';
    m.mount(root, null);
    root.innerHTML = '';
    const shell = document.createElement('main');
    shell.className = 'boot-shell';
    shell.setAttribute('role', 'alert');
    const title = document.createElement('div');
    title.className = 'boot-shell__wordmark';
    title.textContent = 'peerd';
    const detail = document.createElement('p');
    detail.textContent = 'Application unavailable.';
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Retry';
    retry.addEventListener('click', () => location.reload(), { once: true });
    shell.append(title, detail, retry);
    root.append(shell);
  };

  const enterApplication = async () => {
    if (transitioning || stopped) return;
    transitioning = true;
    stopped = true;
    const generation = ++applicationGeneration;
    document.documentElement.dataset.peerdBootStage = 'app-loading';
    try { port?.disconnect(); } catch { /* the cold worker may have dropped it */ }
    m.mount(root, {
      view: () => m('main.boot-shell', { role: 'status', 'aria-live': 'polite' }, [
        m('.boot-shell__wordmark', { 'aria-hidden': 'true' }, 'peerd'),
        m('p', 'Opening peerd…'),
      ]),
    });
    try {
      const start = await Promise.race([
        loadApplication(),
        sleep(appLoadTimeoutMs).then(() => { throw new Error('application load timed out'); }),
      ]);
      if (generation !== applicationGeneration) return;
      start();
      // Mithril may commit the first rich-app tree on its next redraw frame.
      // The module/start promise proves registration, not visible mount; give
      // the renderer two frames before enforcing the nonblank postcondition.
      await new Promise((resolve) => requestAnimationFrame(
        () => requestAnimationFrame(resolve),
      ));
      if (!root.querySelector(appSelector)) {
        throw new Error(`application did not mount ${appSelector}`);
      }
      document.documentElement.dataset.peerdBootStage = 'app-ready';
    }
    catch (cause) { applicationGeneration += 1; renderFailure(cause); }
  };

  /** @param {unknown} next @param {string|null} [replacementEpoch] */
  const adopt = (next, replacementEpoch = null) => {
    const normalized = normalizeColdStateSnapshot(next);
    if (!normalized || !coldStateIsCurrent(
      snapshot, normalized, retiredAuthorityEpochs, replacementEpoch,
    )) return false;
    const priorEpoch = snapshot?.projection?.authorityEpoch;
    const nextEpoch = normalized?.projection?.authorityEpoch;
    if (typeof priorEpoch === 'string' && typeof nextEpoch === 'string'
        && priorEpoch !== nextEpoch) retiredAuthorityEpochs.add(priorEpoch);
    snapshot = /** @type {VaultShellState} */ (normalized);
    authoritativeStateSeen = true;
    document.documentElement.dataset.peerdVaultPosture = 'authoritative';
    if (snapshot.vault?.initialized && snapshot.vault?.locked === false) {
      void enterApplication();
      return true;
    }
    if (snapshot.hydrated === true) {
      document.documentElement.dataset.peerdBootStage = 'vault-ready';
    }
    m.redraw();
    return true;
  };

  /** @param {Record<string, unknown>} message */
  const request = async (message) => {
    const type = String(message?.type ?? '');
    const reconcile = type.startsWith('vault/') && type !== 'vault/prfStatus';
    try {
      return /** @type {any} */ (await uiRuntime.send(
        /** @type {{type:string}&Record<string, any>} */ (message),
      ));
    } finally {
      // A missing reply after a vault effect is an unknown outcome. Re-read
      // authority state on both success and failure; never replay the effect.
      if (reconcile) void refreshUntilChanged();
    }
  };

  const Shell = {
    view: () => m(VaultGate, {
      state: /** @type {import('./chat-reducer.js').ChatState} */ (/** @type {unknown} */ (snapshot)),
      send: request,
    }),
  };
  m.mount(root, Shell);

  const hydrateProvisionalPosture = async () => {
    try {
      const stored = await browser.storage.local.get(VAULT_POSTURE_INDEX_KEY);
      if (stopped || authoritativeStateSeen) return;
      const posture = parseVaultPostureIndex(stored?.[VAULT_POSTURE_INDEX_KEY]);
      // Missing posture is provisional only when this origin has no Peerd DB.
      // An upgraded initialized profile can predate the index; keeping that
      // case in the loading shell avoids a false Create Vault/WebAuthn flow.
      const databases = posture || typeof indexedDB.databases !== 'function'
        ? null : await indexedDB.databases();
      const freshInstall = posture === null && Array.isArray(databases)
        && !databases.some((entry) => entry?.name === 'peerd');
      if (!posture && !freshInstall) return;
      snapshot = {
        // This is display-only posture. Credential ceremonies remain disabled
        // until the worker answers with an authoritative snapshot.
        hydrated: false,
        vault: posture ? {
          initialized: posture.initialized,
          locked: true,
          unlockedAt: 0,
          prfEnrolled: posture.prfEnrolled,
          hasRecovery: posture.hasRecovery,
          lockReason: null,
        } : EMPTY_VAULT,
      };
      document.documentElement.dataset.peerdVaultPosture = posture
        ? 'indexed' : 'fresh-provisional';
      document.documentElement.dataset.peerdBootStage = 'vault-posture';
      m.redraw();
    } catch { /* authoritative worker polling remains the fallback */ }
  };
  void hydrateProvisionalPosture();

  const connect = () => {
    if (stopped) return;
    try {
      const connectedPort = browser.runtime.connect({ name: portName });
      port = connectedPort;
      portRetryMs = 200;
      connectedPort.onMessage.addListener((/** @type {any} */ message) => {
        if (port !== connectedPort) return;
        if (message?.type === 'state' && message.state) {
          adopt(message.state, message.state?.projection?.authorityEpoch ?? null);
        }
      });
      connectedPort.onDisconnect.addListener(() => {
        if (port !== connectedPort) return;
        port = null;
        if (!stopped) {
          if (authoritativeStateSeen) {
            snapshot = {
              ...snapshot,
              hydrated: false,
              vault: { ...snapshot.vault, locked: true, unlockedAt: 0 },
            };
          }
          m.redraw();
          void refreshUntilChanged();
          const delay = portRetryMs;
          portRetryMs = Math.min(2_000, portRetryMs * 2);
          setTimeout(connect, delay);
        }
      });
    } catch {
      const delay = portRetryMs;
      portRetryMs = Math.min(2_000, portRetryMs * 2);
      setTimeout(connect, delay);
    }
  };

  const refreshUntilChanged = () => {
    if (refreshPromise || stopped) return refreshPromise ?? Promise.resolve();
    const generation = ++refreshGeneration;
    refreshPromise = (async () => {
      const deadlineTimer = setTimeout(() => {
        if (generation !== refreshGeneration || stopped) return;
        stopped = true;
        refreshGeneration += 1;
        renderFailure();
      }, 60_000);
      try {
        let delay = 100;
        while (!stopped && generation === refreshGeneration) {
          // runtime.sendMessage has no cancellation. Keep exactly one request
          // outstanding while the cold worker evaluates instead of racing it
          // against a timer and amplifying the startup backlog.
          const bootstrap = /** @type {any} */ (await browser.runtime
            .sendMessage({ type: 'bootstrap/ready' }).catch(() => null));
          if (stopped || generation !== refreshGeneration) return;
          if (bootstrap?.ok) {
            const reply = /** @type {any} */ (await browser.runtime
              .sendMessage({ type: 'state/get' }).catch(() => null));
            if (stopped || generation !== refreshGeneration) return;
            const readyEpoch = bootstrap?.assembly?.identity?.kernelEpoch ?? null;
            if (reply?.ok && reply.state && adopt(reply.state, readyEpoch)) {
              if (!reboundAfterReady && !stopped) {
                reboundAfterReady = true;
                const stalePort = port;
                port = null;
                try { stalePort?.disconnect(); } catch { /* already orphaned */ }
                connect();
              }
              return;
            }
          }
          await sleep(delay);
          delay = Math.min(1_000, delay * 2);
        }
      } finally {
        clearTimeout(deadlineTimer);
        if (generation === refreshGeneration) refreshPromise = null;
      }
    })();
    return refreshPromise;
  };

  connect();
  void refreshUntilChanged();
};
