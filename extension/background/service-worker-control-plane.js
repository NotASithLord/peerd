// @ts-check

import {
  isEvalSender, isHomeSender, isOffscreenSender, isOptionsSender,
  isSidepanelPortSender, isSidepanelSender,
} from '/shared/sender-trust.js';
import { withDeadline } from '/shared/cold-util.js';
import { STARTUP_UNAVAILABLE_USER_FAILURE } from '/shared/bounded-module-load.js';
import { createProductionFeatureLeaseRuntime } from './feature-lease-runtime.js';
import { listOffscreenContexts } from './offscreen-contexts.js';

const COMMANDS = new Set([
  'voice/init', 'voice/listen', 'voice/stop', 'voice/silence', 'voice/teardown',
]);
const OFFSCREEN_EVENTS = new Set(['voice/chunk', 'voice/auto-stop', 'voice/error']);

/** @param {string} name @param {unknown} sender @param {any} predicates */
export const isAuthorizedUiPortSender = (name, sender, predicates) => {
  if (name === 'sidepanel') return predicates.sidepanel(sender);
  if (name === 'home') return predicates.home(sender);
  if (name === 'eval') return predicates.evaluation(sender);
  return false;
};

/**
 * @param {{
 *   sessions: { get: (id: string) => Promise<any>, setCost: (id: string, cost: any) => Promise<any> },
 *   addUsage: (current: any, usage: any, cost: number) => any,
 *   normalizeTally: (value: any) => any,
 * }} deps
 */
export const makeSessionCostFolder = ({ sessions, addUsage, normalizeTally }) => {
  /** @type {Map<string, Promise<void>>} */
  const tails = new Map();
  return (/** @type {string} */ sessionId, /** @type {any} */ usage, /** @type {number} */ cost) => {
    const tail = (tails.get(sessionId) ?? Promise.resolve())
      .then(async () => {
        const fresh = await sessions.get(sessionId);
        await sessions.setCost(sessionId, addUsage(normalizeTally(fresh?.cost), usage, cost));
      })
      .catch(() => {});
    tails.set(sessionId, tail);
    tail.then(() => { if (tails.get(sessionId) === tail) tails.delete(sessionId); });
    return tail;
  };
};

/** @param {any} browser @param {string} offscreenPath */
export const makeSenderChecks = (browser, offscreenPath) => {
  const common = {
    runtimeId: browser.runtime?.id,
    extensionOrigin: browser.runtime?.getURL?.('') ?? '',
  };
  const sidepanelUrl = browser.runtime?.getURL?.('sidepanel/sidepanel.html') ?? '';
  const homeUrl = browser.runtime?.getURL?.('home/home.html') ?? '';
  const micUrl = browser.runtime?.getURL?.('permissions/mic.html') ?? '';
  return Object.freeze({
    offscreen: (/** @type {any} */ sender) => isOffscreenSender(sender, {
      ...common, offscreenUrl: browser.runtime?.getURL?.(offscreenPath) ?? '',
    }),
    options: (/** @type {any} */ sender) => isOptionsSender(sender, {
      ...common, optionsUrl: browser.runtime?.getURL?.('options/options.html') ?? '',
    }),
    sidepanel: (/** @type {any} */ sender) => isSidepanelSender(sender, {
      ...common, sidepanelUrl,
    }),
    sidepanelPort: (/** @type {any} */ sender) => isSidepanelPortSender(sender, {
      ...common, sidepanelUrl,
    }),
    home: (/** @type {any} */ sender) => isHomeSender(sender, { ...common, homeUrl }),
    mic: (/** @type {any} */ sender) => sender?.id === common.runtimeId
      && sender?.url === micUrl && typeof sender?.tab?.id === 'number',
    evaluation: (/** @type {any} */ sender) => isEvalSender(sender, {
      ...common, homeUrl,
      evalRunnerUrl: browser.runtime?.getURL?.('eval/runner.html') ?? '',
    }),
  });
};

/** @param {any} deps */
export const makeUiForwarder = (deps) => (/** @type {any} */ msg, /** @type {any} */ sender) => {
  const accepted = OFFSCREEN_EVENTS.has(msg?.type)
    ? deps.isOffscreenSender(sender)
    : msg?.type === 'voice/permission-result' && deps.isMicSender(sender);
  if (!accepted) return false;
  try { deps.deliver(msg); } catch {}
  return false;
};

/** @param {any} deps */
export const makeVoiceControlPlane = (deps) => {
  const relayToken = crypto.randomUUID();
  const hostTimeoutMs = deps.hostTimeoutMs ?? 15_000;
  let tail = Promise.resolve();
  const queue = (/** @type {()=>Promise<any>} */ operation) => {
    const pending = tail.then(operation, operation);
    tail = pending.then(() => {}, () => {});
    return pending;
  };
  const revoke = () => deps.featureLeases.revoke('media-host', 'feature-disabled');
  const teardown = () => queue(async () => {
    const state = deps.featureLeases.snapshot().leases['media-host'];
    try {
      if (state?.status !== 'active') return { ok: true, inactive: true };
      return await withDeadline(
        () => deps.browser.runtime.sendMessage({
          type: 'voice/teardown', __peerdVoiceRelay: relayToken,
        }),
        hostTimeoutMs,
        () => new Error('voice-host-timeout'),
      );
    } finally {
      await revoke();
    }
  });
  const onMessage = (
    /** @type {any} */ msg,
    /** @type {any} */ sender,
    /** @type {(value:any)=>void} */ sendResponse,
  ) => {
    if (!COMMANDS.has(msg?.type) || msg?.__peerdVoiceRelay === relayToken) return false;
    if (!deps.isSidepanelSender(sender) && !deps.isOptionsSender(sender)) {
      sendResponse({ ok: false, error: 'untrusted-voice-sender' });
      return false;
    }
    const command = async () => {
      const startsMedia = msg.type === 'voice/init' || msg.type === 'voice/listen';
      const state = deps.featureLeases.snapshot().leases['media-host'];
      if (startsMedia) {
        await deps.acquire({ reason: 'feature-demand' });
      } else if (state?.status !== 'active') {
        return { ok: true, inactive: true };
      }
      try {
        const reply = await withDeadline(
          () => deps.browser.runtime.sendMessage({ ...msg, __peerdVoiceRelay: relayToken }),
          hostTimeoutMs,
          () => new Error('voice-host-timeout'),
        );
        if (startsMedia && reply?.ok !== true) await revoke();
        return reply;
      } catch (cause) {
        await revoke().catch(() => {});
        throw cause;
      } finally {
        if (msg.type === 'voice/teardown') await revoke();
      }
    };
    queue(command).then(sendResponse, async (cause) => {
      if (msg.type === 'voice/init' || msg.type === 'voice/listen') {
        await revoke().catch(() => {});
      }
      sendResponse({
        ok: false,
        error: cause instanceof Error ? cause.message : String(cause),
      });
    });
    return true;
  };
  return Object.freeze({ onMessage, teardown });
};

const startupError = (/** @type {string} */ code) => Object.assign(
  Error(code), { code, outcomeKnown: true, retryable: true, phase: 'startup' },
);

/** @template T @param {()=>Promise<T>} loader @param {number} [timeoutMs] */
export const makeRetryableLazy = (loader, timeoutMs = 10_000) => {
  /** @type {Promise<T>|null} */ let pending = null;
  return () => {
    /** @type {ReturnType<typeof setTimeout>} */ let timer;
    pending ||= Promise.resolve().then(loader).catch(() => {
      pending = null;
      throw startupError('module-load-failed');
    });
    return Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(startupError('module-load-timeout')), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
  };
};

/** @param {any} registry @param {string} kind @param {(tabId:number,value:any)=>void} note */
export const makeTrackerNote = (registry, kind, note) => (
  /** @type {number} */ tabId, /** @type {string} */ _kindLabel, /** @type {any} */ id,
) => {
  Promise.resolve(registry.get(id))
    .then((record) => note(tabId, { kind, name: record?.name ?? null }))
    .catch(() => note(tabId, { kind }));
};

/** @param {any} deps */
export const makeLazyFirefoxActorControl = (deps) => {
  const loadDirectActorHost = deps.loadDirectActorHost
    ?? (() => import('./direct-actor-host.js'));
  /** @type {ReturnType<typeof import('./firefox-storage-keepalive.js').makeStorageSessionKeepAlive>|null} */
  let keepalive = null;
  /** @type {ReturnType<typeof import('./firefox-storage-keepalive.js').makeRefCountedFirefoxBackgroundLifetime>|null} */
  let lifetime = null;
  const loadLifetime = makeRetryableLazy(async () => {
    if (!deps.enabled) return null;
    const {
      makeRefCountedFirefoxBackgroundLifetime,
      makeStorageSessionKeepAlive,
    } = await import('./firefox-storage-keepalive.js');
    keepalive = makeStorageSessionKeepAlive({
      storage: deps.browser.storage.session,
      key: deps.key,
      intervalMs: deps.intervalMs,
      ackTimeoutMs: deps.ackTimeoutMs,
      onLost: (error) => {
        lifetime?.fail(error);
        deps.onLost(error);
      },
    });
    lifetime = makeRefCountedFirefoxBackgroundLifetime({
      start: () => keepalive?.start(),
      stop: () => keepalive?.stop(),
    });
    return lifetime;
  }, deps.loadTimeoutMs);
  const withLifetime = async (/** @type {()=>any} */ operation, /** @type {any} */ options) =>
    (await loadLifetime())?.run(operation, options) ?? operation();

  /** @type {ReturnType<typeof import('./direct-actor-host.js').makeDirectActorHost>|null} */
  let actorHost = null;
  /** @type {Record<string,(payload:any,sender?:unknown)=>any>|null} */
  let relayRoutes = null;
  const loadActorHost = makeRetryableLazy(async () => {
    const [backgroundLifetime, { makeDirectActorHost }] = await Promise.all([
      loadLifetime(), loadDirectActorHost(),
    ]);
    const handle = backgroundLifetime?.createHandle();
    const host = makeDirectActorHost({
      workerUrl: deps.workerUrl,
      startKeepAlive: () => handle?.start(),
      stopKeepAlive: () => handle?.stop(),
    });
    actorHost = host;
    if (relayRoutes) host.bindRelayRoutes(relayRoutes);
    return host;
  }, deps.loadTimeoutMs);
  const directActorHost = deps.enabled ? Object.freeze({
    sendMessage: async (/** @type {any} */ message) => {
      let host;
      try { host = await loadActorHost(); }
      catch (cause) {
        const code = /** @type {{code?:string}} */ (cause)?.code === 'module-load-timeout'
          ? 'actor_host_load_timeout' : 'actor_host_load_failed';
        return {
          ok: false, started: false, phase: 'startup', code,
          error: STARTUP_UNAVAILABLE_USER_FAILURE, outcomeKnown: true,
        };
      }
      return host.sendMessage(message);
    },
    bindRelayRoutes: (/** @type {Record<string,(payload:any,sender?:unknown)=>any>} */ routes) => {
      relayRoutes = routes;
      actorHost?.bindRelayRoutes(routes);
    },
    isRelaySender: (/** @type {unknown} */ sender) => actorHost?.isRelaySender(sender) === true,
    failKeepAlive: (/** @type {unknown} */ error) => actorHost?.failKeepAlive(error),
    hasActiveRuns: () => actorHost?.hasActiveRuns() === true,
  }) : null;

  return Object.freeze({
    withLifetime,
    directActorHost,
    onChanged: (/** @type {any} */ changes) => keepalive?.onChanged(changes) ?? false,
  });
};

/** @param {any} deps */
export const createFeatureLeaseControlPlane = (deps) => {
  const ensureOffscreen = async () => {
    if (typeof deps.browser.offscreen?.createDocument !== 'function') return;
    try {
      if ((await listOffscreenContexts(deps.browser)).length > 0) return;
      await deps.browser.offscreen.createDocument({
        url: deps.offscreenUrl,
        reasons: ['WORKERS', 'USER_MEDIA'],
        justification: 'Demand-scoped feature Workers and local voice transcription.',
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch (error) {
      if (/single offscreen document|already exists/i.test(
        /** @type {{message?:string}} */ (error)?.message ?? '',
      )) return;
      throw error;
    }
  };
  const runtime = createProductionFeatureLeaseRuntime({
    identity: deps.identity,
    store: {
      get: async (key) => (await deps.browser.storage.session.get(key))?.[key],
      set: async (key, value) => { await deps.browser.storage.session.set({ [key]: value }); },
    },
    ensureOffscreen,
    hasOffscreen: async () => (await listOffscreenContexts(deps.browser)).length > 0,
    closeOffscreen: async () => {
      if (typeof deps.browser.offscreen?.closeDocument === 'function') {
        await deps.browser.offscreen.closeDocument();
      }
    },
    sendHostMessage: (message) => deps.browser.runtime.sendMessage(message),
    vaultUnlocked: deps.vaultUnlocked,
  });
  const refusalError = (/** @type {any} */ result) => Object.assign(
    new Error(result?.code ?? 'feature lease unavailable'),
    {
      code: result?.code ?? 'feature-lease-unavailable',
      outcomeKnown: result?.outcomeKnown === true,
    },
  );
  const run = async (/** @type {any} */ scope, /** @type {any} */ operation, options = {}) => {
    await runtime.ready;
    let entered = false;
    const result = await runtime.runWithLease(scope, async (lease) => {
      entered = true;
      return operation(lease);
    }, options);
    if (!entered) throw refusalError(result);
    return result;
  };
  const acquire = async (/** @type {any} */ scope, options = {}) => {
    await runtime.ready;
    const result = await runtime.acquire(scope, options);
    if (!result?.ok) throw refusalError(result);
    return result;
  };
  return Object.freeze({ runtime, ensureOffscreen, run, acquire });
};
