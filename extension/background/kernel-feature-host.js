// @ts-check

import { parseKernelIdentity } from '../shared/kernel-identity.js';
import { createProductionFeatureLeaseRuntime } from './feature-lease-runtime.js';
import { attachFeatureLeaseKeepalive } from './feature-lease-keepalive.js';
import { listOffscreenContexts } from './offscreen-contexts.js';
import { makeVaultAuthorityClient } from './vault-authority-client.js';

/**
 * @param {Object} deps
 * @param {any} deps.browser
 * @param {import('../shared/kernel-identity.js').KernelIdentity} deps.identity
 * @param {boolean} [deps.vaultUnlocked]
 * @param {()=>boolean} [deps.dwebEnabled]
 * @param {string} [deps.offscreenPath]
 * @param {(hostEpoch:string)=>Promise<void>|void} [deps.onHostLost]
 * @param {(recovery:any)=>Promise<void>|void} [deps.onRecovered]
 * @param {(error:unknown)=>void} [deps.onError]
 * @param {typeof createProductionFeatureLeaseRuntime} [deps.createRuntime]
 * @param {typeof attachFeatureLeaseKeepalive} [deps.attachKeepalive]
 * @param {()=>Promise<any>} [deps.loadFirefoxLifetime]
 * @param {typeof listOffscreenContexts} [deps.listContexts]
 * @param {(ms:number)=>Promise<void>} [deps.wait]
 * @param {{kv:any,idb:any,sessionCache:any}} [deps.vaultStorage]
 * @param {Record<string,new (...args:any[])=>Error>} [deps.vaultErrorTypes]
 */
export const createKernelFeatureHost = ({
  browser,
  identity,
  vaultUnlocked = false,
  dwebEnabled = () => false,
  offscreenPath = 'offscreen/offscreen.html',
  onHostLost = () => {},
  onRecovered = () => {},
  onError = () => {},
  createRuntime = createProductionFeatureLeaseRuntime,
  attachKeepalive = attachFeatureLeaseKeepalive,
  loadFirefoxLifetime,
  listContexts = listOffscreenContexts,
  wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  vaultStorage,
  vaultErrorTypes = {},
}) => {
  const canonicalIdentity = parseKernelIdentity(identity);
  if (!canonicalIdentity) throw new TypeError('kernel-feature-identity-invalid');
  if (!browser?.runtime || !browser?.storage?.session) {
    throw new TypeError('kernel-feature-browser-invalid');
  }
  const offscreenUrl = browser.runtime.getURL(offscreenPath);
  /** @type {{port:any,documentUrl:string,request:(message:any)=>Promise<any>}|null} */
  let hostCommandChannel = null;
  let nextChannelGeneration = 0;
  let boundChannelGeneration = 0;
  /** @param {{port:any,documentUrl:string}} channel */
  const matchesCurrentHostContext = async (channel) => {
    const contexts = await listContexts(browser);
    return contexts.length === 1
      && contexts[0]?.documentUrl === channel.documentUrl;
  };
  /** @param {{port:any,documentUrl:string}} channel */
  const isCurrentHostChannel = async (channel) => {
    if (hostCommandChannel?.port !== channel.port) return false;
    const current = await matchesCurrentHostContext(channel);
    return hostCommandChannel?.port === channel.port
      && current;
  };

  const ensureOffscreen = async () => {
    const offscreen = browser.offscreen;
    if (typeof offscreen?.createDocument !== 'function') {
      throw new Error('feature-lease-offscreen-unavailable');
    }
    if ((await listContexts(browser)).length > 0) return;
    try {
      await offscreen.createDocument({
        // why: Chrome omits documentId from offscreen runtime senders. A fresh
        // fragment makes the browser-stamped sender URL equal to exactly one
        // current getContexts document without becoming a shared secret.
        url: `${offscreenPath}#${crypto.randomUUID()}`,
        reasons: ['WORKERS', 'USER_MEDIA'],
        justification: 'Demand-scoped feature Workers and local voice transcription.',
      });
      await wait(50);
    } catch (error) {
      if (/single offscreen document|already exists/i.test(
        /** @type {{message?:string}} */ (error)?.message ?? '',
      )) return;
      throw error;
    }
  };

  const runtime = createRuntime({
    identity: canonicalIdentity,
    store: {
      get: async (key) => (await browser.storage.session.get(key))?.[key],
      set: async (key, value) => { await browser.storage.session.set({ [key]: value }); },
    },
    ensureOffscreen,
    hasOffscreen: async () => (await listContexts(browser)).length > 0,
    closeOffscreen: async () => {
      if (typeof browser.offscreen?.closeDocument === 'function') {
        await browser.offscreen.closeDocument();
      }
    },
    sendHostMessage: async (message) => {
      const channel = hostCommandChannel;
      if (!channel || !await isCurrentHostChannel(channel)) {
        throw new Error('feature-lease-host-channel-unavailable');
      }
      return channel.request(message);
    },
    wait,
    vaultUnlocked,
  });

  /** @type {string|null} */
  let authenticatedHostEpoch = null;
  const handleKeepalive = (/** @type {any} */ port) => {
    const documentUrl = port?.sender?.url;
    /** @type {{port:any,documentUrl:string,request:(message:any)=>Promise<any>}|null} */
    let channel = null;
    let disconnected = false;
    let ready = Promise.resolve(false);
    const attached = attachKeepalive({
      port,
      featureLeases: runtime,
      identity: canonicalIdentity,
      authorize: () => ready.then((admitted) => admitted && channel !== null
        && isCurrentHostChannel(channel)),
      authorizeLoss: () => channel !== null && hostCommandChannel?.port === channel.port,
      onAuthenticated: (/** @type {string} */ hostEpoch) => {
        authenticatedHostEpoch = hostEpoch;
      },
      onLost: (/** @type {string} */ hostEpoch) => {
        // why: Chrome may deliver an old Port's disconnect after its successor
        // has authenticated. Only the current lifetime oracle may retire the
        // controller; lease recovery below is independently epoch-fenced.
        if (authenticatedHostEpoch !== hostEpoch) return;
        authenticatedHostEpoch = null;
        return onHostLost(hostEpoch);
      },
      onRecovered,
      onError,
    });
    if (!attached?.request || typeof documentUrl !== 'string'
        || documentUrl.split('#', 1)[0] !== offscreenUrl) return;
    const generation = ++nextChannelGeneration;
    channel = { port, documentUrl, request: attached.request };
    ready = matchesCurrentHostContext(channel).then((current) => {
      if (disconnected || !current || generation <= boundChannelGeneration) {
        if (!current) try { port.disconnect(); } catch { /* already disconnected */ }
        return false;
      }
      boundChannelGeneration = generation;
      const previous = hostCommandChannel?.port;
      hostCommandChannel = channel;
      if (previous && previous !== port) {
        try { previous.disconnect(); } catch { /* already disconnected */ }
      }
      return true;
    }).catch(() => {
      try { port.disconnect(); } catch { /* already disconnected */ }
      return false;
    });
    port.onDisconnect.addListener(() => {
      disconnected = true;
      if (hostCommandChannel?.port === port) hostCommandChannel = null;
    });
  };
  const vaultAuthorityOffscreen = typeof browser.offscreen?.createDocument === 'function';
  const unavailable = async () => { throw new Error('vault-authority-storage-unavailable'); };
  const storage = vaultStorage ?? {
    kv: { get: unavailable, set: unavailable, delete: unavailable, list: unavailable },
    idb: { get: unavailable, put: unavailable, del: unavailable },
    sessionCache: {
      sessionGet: unavailable, sessionSet: unavailable, sessionDelete: unavailable,
    },
  };
  const unlockMethods = new Set([
    'boot', 'attemptResume', 'initialize', 'initializeWithPrfOnly', 'unlock', 'unlockWithPrf',
  ]);
  const vaultAuthority = makeVaultAuthorityClient({
    offscreen: vaultAuthorityOffscreen,
    offscreenUrl,
    workerUrl: browser.runtime.getURL('offscreen/vault-authority-worker.js'),
    kv: storage.kv,
    idb: storage.idb,
    sessionCache: storage.sessionCache,
    errorTypes: vaultErrorTypes,
    withHost: async (operation, context = { method: 'status' }) => {
      if (!vaultAuthorityOffscreen) return operation(null);
      if (unlockMethods.has(context.method)) {
        const acquired = await runtime.acquire('vault-authority', {
          reason: 'feature-demand',
        });
        if (!acquired?.ok) {
          throw new Error(acquired?.code ?? 'vault-authority-host-unavailable');
        }
        try {
          return await operation(acquired.lease);
        } finally {
          if (vaultAuthority.isLocked()) {
            vaultAuthority.close();
            await runtime.revoke('vault-authority', 'feature-disabled');
          }
        }
      }
      return runtime.runWithLease('vault-authority', operation, {
        reason: 'feature-demand',
      });
    },
  });
  /** @type {any|null} */
  let firefoxStorageLifetime = null;
  /** @type {any|null} */
  let firefoxLifetime = null;
  /** @type {Promise<any>|null} */
  let firefoxLifetimeLoading = null;
  /** @type {unknown} */
  let firefoxLifetimeRegistry = null;
  const attachFirefoxActorLifetime = (/** @type {any} */ registry) => {
    if (firefoxLifetimeRegistry && firefoxLifetimeRegistry !== registry) {
      throw new Error('kernel-firefox-lifetime-registry-changed');
    }
    if (firefoxLifetimeRegistry) return firefoxLifetimeFacade;
    if (typeof loadFirefoxLifetime !== 'function') {
      throw new Error('kernel-firefox-lifetime-loader-missing');
    }
    firefoxLifetimeRegistry = registry;
    const event = registry?.event?.(
      'storage.session.onChanged', browser.storage.session.onChanged,
      'kernel-firefox-actor-lifetime',
    );
    if (!event || typeof event.addListener !== 'function') {
      firefoxLifetimeRegistry = null;
      throw new Error('firefox-storage-keepalive-event-unavailable');
    }
    event.addListener((/** @type {Record<string, any>} */ changes) => {
      firefoxStorageLifetime?.onChanged(changes);
    });
    return firefoxLifetimeFacade;
  };
  const loadFirefoxActorLifetime = () => {
    if (firefoxLifetime) return Promise.resolve(firefoxLifetime);
    if (typeof loadFirefoxLifetime !== 'function') {
      return Promise.reject(new Error('kernel-firefox-lifetime-loader-missing'));
    }
    firefoxLifetimeLoading ??= loadFirefoxLifetime().then((module) => {
      /** @type {any|null} */
      let refCounted = null;
      firefoxStorageLifetime = module.makeStorageSessionKeepAlive({
        storage: browser.storage.session,
        key: module.FIREFOX_ACTOR_KEEPALIVE_KEY,
        intervalMs: module.FIREFOX_ACTOR_KEEPALIVE_MS,
        ackTimeoutMs: module.FIREFOX_ACTOR_KEEPALIVE_ACK_MS,
        onLost: (/** @type {unknown} */ error) => {
          refCounted?.fail(error);
          onError(error);
        },
      });
      refCounted = module.makeRefCountedFirefoxBackgroundLifetime({
        start: firefoxStorageLifetime.start,
        stop: firefoxStorageLifetime.stop,
      });
      firefoxLifetime = refCounted;
      return refCounted;
    }).catch((cause) => {
      firefoxLifetimeLoading = null;
      firefoxStorageLifetime = null;
      throw cause;
    });
    return firefoxLifetimeLoading;
  };
  const firefoxLifetimeFacade = Object.freeze({
    run: async (/** @type {()=>Promise<any>|any} */ operation,
      /** @type {any} */ options = undefined) =>
      (await loadFirefoxActorLifetime()).run(operation, options),
    createHandle: (/** @type {{onLost?:(error:Error)=>void}} */ options = {}) => {
      /** @type {any|null} */
      let handle = null;
      return Object.freeze({
        start: async () => { handle ??= (await loadFirefoxActorLifetime()).createHandle(options); await handle.start(); },
        stop: async () => { const active = handle; handle = null; await active?.stop(); },
      });
    },
    fail: (/** @type {unknown} */ cause) => { firefoxLifetime?.fail(cause); },
    stop: async () => { firefoxStorageLifetime?.stop(); },
    snapshot: () => firefoxLifetime?.snapshot() ?? { active: 0, lost: false },
  });

  const settleVaultBoot = async (/** @type {{resumed:boolean}} */ { resumed }) => {
    await runtime.ready;
    if (!resumed) {
      vaultAuthority.close();
      return runtime.lock();
    }
    return runtime.resume({ dwebEnabled: dwebEnabled() });
  };
  const vaultUnlockedNow = async () => {
    await runtime.ready;
    return runtime.resume({ dwebEnabled: dwebEnabled() });
  };
  const vaultLockedNow = async () => {
    vaultAuthority.close();
    await runtime.ready;
    return runtime.lock();
  };
  const ensureDwebFeature = async (/** @type {Promise<any>} */ ready = runtime.ready) => {
    await ready;
    if (!dwebEnabled()) throw new Error('dweb-disabled');
    if (vaultAuthority.isLocked()) {
      const LockedError = vaultErrorTypes.locked ?? Error;
      throw new LockedError('vault-locked');
    }
    const result = await runtime.acquire('dweb', { reason: 'feature-demand' });
    if (!result?.ok) throw new Error(result?.code ?? 'dweb-host-unavailable');
    return result;
  };

  return Object.freeze({
    runtime,
    vault: vaultAuthority,
    ensureOffscreen,
    handleKeepalive,
    ensureDwebFeature,
    attachFirefoxActorLifetime,
    settleVaultBoot,
    vaultInitialized: vaultUnlockedNow,
    vaultUnlocked: vaultUnlockedNow,
    vaultLocked: vaultLockedNow,
  });
};
