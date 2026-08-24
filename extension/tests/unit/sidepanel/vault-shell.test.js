// @ts-check

import { describe, it, expect } from '../../framework.js';
import { startVaultShell } from '/sidepanel/vault-shell.js';

const waitFor = async (/** @type {() => boolean} */ predicate) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('timeout');
};

describe('vault shell application load', () => {
  it('keeps the failure shell after a timed-out import resolves late', async () => {
    const runtime = /** @type {any} */ (chrome.runtime);
    const chromeApi = /** @type {any} */ (chrome);
    const prior = {
      connect: runtime.connect,
      sendMessage: runtime.sendMessage,
      storage: chromeApi.storage,
    };
    /** @type {Array<(message: any) => void>} */
    const messageListeners = [];
    runtime.connect = () => ({
      onMessage: { addListener: (/** @type {(message: any) => void} */ listener) => { messageListeners.push(listener); } },
      onDisconnect: { addListener: () => {} },
      disconnect: () => {},
    });
    runtime.sendMessage = async () => null;
    chromeApi.storage = { local: { get: async () => ({}) } };

    const root = document.createElement('div');
    root.id = 'app';
    document.body.append(root);
    /** @type {(start: () => void) => void} */
    let resolveLoad = () => {};
    /** @type {Promise<() => void>} */
    const frozenLoad = new Promise((resolve) => { resolveLoad = resolve; });
    let starts = 0;
    try {
      startVaultShell({
        portName: 'sidepanel',
        appSelector: '.app-shell',
        loadApplication: () => frozenLoad,
        appLoadTimeoutMs: 2,
      });
      messageListeners[0]?.({
        type: 'state',
        state: {
          vault: {
            initialized: true, locked: false, unlockedAt: 1,
            prfEnrolled: false, hasRecovery: true, lockReason: null,
          },
          settings: { vaultAutoLockMs: 0, confirmWebWrites: true },
          capabilities: {
            actorExecution: {
              status: 'available', host: 'offscreen-document-worker',
              reason: null, retryable: false,
            },
          },
        },
      });

      await waitFor(() => document.documentElement.dataset.peerdBootStage === 'failed');
      expect(root.textContent).toContain('Application unavailable.');
      expect(root.textContent).toContain('Retry');
      expect(root.querySelector('[role="alert"]') !== null).toBe(true);

      resolveLoad(() => {
        starts += 1;
        root.innerHTML = '<main class="app-shell">late mount</main>';
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      expect(starts).toBe(0);
      expect(root.querySelector('.app-shell')).toBe(null);
      expect(root.textContent).toContain('Application unavailable.');
    } finally {
      root.remove();
      delete document.documentElement.dataset.peerdBootStage;
      delete document.documentElement.dataset.peerdVaultPosture;
      if (prior.connect === undefined) delete runtime.connect;
      else runtime.connect = prior.connect;
      if (prior.sendMessage === undefined) delete runtime.sendMessage;
      else runtime.sendMessage = prior.sendMessage;
      if (prior.storage === undefined) delete chromeApi.storage;
      else chromeApi.storage = prior.storage;
    }
  });
});
