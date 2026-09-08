// @ts-check

import { describe, it, expect } from '../../framework.js';
import { afterStaticShellPaint, startVaultShell } from '/sidepanel/vault-shell.js';
import {
  KERNEL_STATE_DEFERRED_FIELDS,
  KERNEL_STATE_PROVENANCE,
  KERNEL_STATE_SCHEMA,
} from '/shared/kernel-state-contract.js';

const waitFor = async (/** @type {() => boolean} */ predicate) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('timeout');
};

/**
 * @param {(frames: FrameRequestCallback[], timers: TimerHandler[], root:HTMLElement) => void} run
 * @param {string} [shell]
 */
const withPaintGateFakes = (run, shell = '<main class="boot-shell" style="width:1px;height:1px">peerd</main>') => {
  const windowApi = /** @type {any} */ (window);
  const prior = {
    requestAnimationFrame: window.requestAnimationFrame,
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
  };
  /** @type {FrameRequestCallback[]} */
  const frames = [];
  /** @type {TimerHandler[]} */
  const timers = [];
  windowApi.requestAnimationFrame = (/** @type {FrameRequestCallback} */ callback) => (
    frames.push(callback), frames.length
  );
  windowApi.setTimeout = (/** @type {TimerHandler} */ handler) => (
    timers.push(handler), timers.length
  );
  windowApi.clearTimeout = () => {};
  const root = document.createElement('div');
  root.id = 'app';
  root.innerHTML = shell;
  document.body.append(root);
  try { run(frames, timers, root); }
  finally {
    root.remove();
    delete document.documentElement.dataset.peerdStaticShellPainted;
    delete document.documentElement.dataset.peerdBootStage;
    delete document.documentElement.dataset.peerdBootError;
    window.requestAnimationFrame = prior.requestAnimationFrame;
    window.setTimeout = prior.setTimeout;
    window.clearTimeout = prior.clearTimeout;
  }
};

const unlockedSnapshot = () => ({
  hydrated: true,
  vault: {
    initialized: true, locked: false, unlockedAt: 1,
    prfEnrolled: false, hasRecovery: true, lockReason: null,
  },
  settings: { vaultAutoLockMs: 0, confirmWebWrites: true },
  session: {
    sessionId: null, messages: [],
    permission: { mode: 'act', confirmActions: false },
  },
  providers: { current: 'ollama', model: 'qwen3:8b', hasKey: false },
  composer: {
    provider: 'ollama', model: 'qwen3:8b', keyless: true,
    credentialReady: true, localReady: true, canSend: true, reason: null,
  },
  profile: { id: 'default', peerName: 'peerd', onboardingComplete: true },
  capabilities: {
    actorExecution: {
      status: 'temporarily_unavailable', host: 'background-page-worker',
      reason: 'controller-not-ready', retryable: true,
    },
  },
  actors: {},
  actorProjectionEpoch: null,
  actorProjectionRevision: 0,
  spawned: { byToolUse: {}, sessions: {} },
  asyncTasks: {},
  projection: {
    schema: KERNEL_STATE_SCHEMA,
    provenance: KERNEL_STATE_PROVENANCE,
    authorityEpoch: 'kernel-firefox-port', generation: 1,
    settings: 'hydrated', actorIsolation: 'hydrated',
    semanticController: 'required',
    deferredFields: [...KERNEL_STATE_DEFERRED_FIELDS], failures: [],
  },
});

describe('vault shell static paint gate', () => {
  it('starts once from the fallback when animation frames are throttled', () => {
    withPaintGateFakes((frames, timers) => {
      let starts = 0;
      afterStaticShellPaint(() => { starts += 1; });
      /** @type {() => void} */ (timers.shift())();
      expect(starts).toBe(1);
      while (frames.length > 0) frames.shift()?.(0);
      expect(starts).toBe(1);
    });
  });

  it('starts once when two animation frames win the race', () => {
    withPaintGateFakes((frames, timers) => {
      let starts = 0;
      afterStaticShellPaint(() => { starts += 1; });
      frames.shift()?.(0);
      frames.shift()?.(0);
      expect(starts).toBe(1);
      /** @type {() => void} */ (timers.shift())();
      expect(starts).toBe(1);
    });
  });

  it('renders a visible retry shell when the static boot node is missing', () => {
    withPaintGateFakes((_frames, timers, root) => {
      let starts = 0;
      afterStaticShellPaint(() => { starts += 1; });
      /** @type {() => void} */ (timers.shift())();
      expect(starts).toBe(0);
      expect(document.documentElement.dataset.peerdBootStage).toBe('failed');
      expect(root.querySelector('[role="alert"]') !== null).toBe(true);
      expect(root.textContent).toContain('Application unavailable.');
      expect(root.textContent).toContain('Retry');
    }, '');
  });

  it('replaces a hidden static boot node with a visible retry shell', () => {
    withPaintGateFakes((_frames, timers, root) => {
      let starts = 0;
      afterStaticShellPaint(() => { starts += 1; });
      /** @type {() => void} */ (timers.shift())();
      expect(starts).toBe(0);
      const failure = /** @type {HTMLElement} */ (root.querySelector('[role="alert"]'));
      expect(failure !== null).toBe(true);
      expect(getComputedStyle(failure).display === 'none').toBe(false);
      expect(getComputedStyle(failure).visibility === 'hidden').toBe(false);
      expect(root.textContent).toContain('Retry');
    }, '<main class="boot-shell" style="display:none">peerd</main>');
  });
});

describe('vault shell application load', () => {
  it('enters the application from a valid Port snapshot without message fallback', async () => {
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
    try {
      startVaultShell({
        portName: 'sidepanel',
        appSelector: '.app-shell',
        loadApplication: async () => () => {
          root.innerHTML = '<main class="app-shell">ready</main>';
        },
      });
      messageListeners[0]?.({
        type: 'state',
        state: unlockedSnapshot(),
      });

      await waitFor(() => document.documentElement.dataset.peerdBootStage === 'app-ready');
      expect(root.querySelector('.app-shell')?.textContent).toBe('ready');
    } finally {
      root.remove();
      delete document.documentElement.dataset.peerdBootStage;
      delete document.documentElement.dataset.peerdBootError;
      delete document.documentElement.dataset.peerdVaultPosture;
      if (prior.connect === undefined) delete runtime.connect;
      else runtime.connect = prior.connect;
      if (prior.sendMessage === undefined) delete runtime.sendMessage;
      else runtime.sendMessage = prior.sendMessage;
      if (prior.storage === undefined) delete chromeApi.storage;
      else chromeApi.storage = prior.storage;
    }
  });

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
        state: unlockedSnapshot(),
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
