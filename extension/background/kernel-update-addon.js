// @ts-check

import {
  CONTRIBUTOR_CHANNEL_CALL, CONTRIBUTOR_CHANNEL_OFFER,
  CONTRIBUTOR_CHANNEL_PROTOCOL, CONTRIBUTOR_CHANNEL_REPLY,
  CONTRIBUTOR_CHANNEL_RESULT, parseContributorOffer,
} from '../shared/contributor-channel.js';

export const KERNEL_UPDATE_CUSTODY_KEY = 'kernel.updateCustody.v1';
const VERSION = /^\d+(?:\.\d+)*$/;
const validVersion = (/** @type {unknown} */ value) => typeof value === 'string'
  && value.length > 0 && value.length <= 64 && VERSION.test(value);
/** @param {string} a @param {string} b */
const newer = (a, b) => a.localeCompare(b, 'en', { numeric: true }) >= 0 ? a : b;
/** @param {any} value */
const normalize = (value) => ({ schema: 1,
  pendingVersion: validVersion(value?.pendingVersion) ? value.pendingVersion : null,
  notifiedVersion: validVersion(value?.notifiedVersion) ? value.notifiedVersion : null,
  lastCheckAt: Number.isFinite(value?.lastCheckAt) && value.lastCheckAt >= 0 ? value.lastCheckAt : null,
});

export const createKernelUpdateCustody = (/** @type {any} */ {
  runtime, session, ready, isEnabled, isBusy, listWindowClients, isBlockingWindow,
  notify = () => false, now = Date.now,
  scheduleRetry = (/** @type {()=>void} */ fn, /** @type {number} */ delayMs) => setTimeout(fn, delayMs),
  cancelRetry = (/** @type {unknown} */ handle) => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (handle)),
  log = () => {},
}) => {
  if (![runtime?.reload, runtime?.getManifest, session?.get, session?.set, ready, isEnabled,
    isBusy, listWindowClients, isBlockingWindow].every((value) => typeof value === 'function')) {
    throw new TypeError('kernel-update-custody-config-invalid');
  }

  let tail = Promise.resolve();
  /** @type {Promise<boolean>|null} */ let active = null;
  /** @type {Promise<boolean>|null} */ let check = null;
  /** @type {unknown|null} */ let timer = null;
  let attempts = 0;

  const read = async () => normalize(await session.get(KERNEL_UPDATE_CUSTODY_KEY));
  /** @param {(state:ReturnType<typeof normalize>)=>ReturnType<typeof normalize>} mutate */
  const update = (mutate) => {
    const run = tail.then(async () => {
      const next = mutate(await read());
      await session.set(KERNEL_UPDATE_CUSTODY_KEY, next);
      return next;
    });
    tail = run.then(() => {}, () => {});
    return run;
  };
  const clear = () => { if (timer !== null) cancelRetry(timer); timer = null; attempts = 0; };
  const retry = () => {
    if (timer !== null) return;
    const delay = Math.min(15_000 * 2 ** attempts, 120_000);
    attempts = Math.min(attempts + 1, 4);
    timer = scheduleRetry(() => {
      timer = null;
      void apply().catch((error) => { log('[update] apply failed', error); retry(); });
    }, delay);
  };
  const notePending = async (/** @type {string} */ version) => {
    const state = await read();
    if (state.notifiedVersion === version) return;
    if (!notify(`peerd v${version} is downloaded - it installs when peerd goes quiet or the browser restarts.`)) return;
    await update((latest) => ({ ...latest, notifiedVersion: version }));
  };

  const tryApply = async () => {
    await tail;
    const state = await read();
    const version = state.pendingVersion;
    if (!version) { clear(); return false; }
    const installed = runtime.getManifest()?.version;
    if (validVersion(installed)
        && newer(/** @type {string} */ (installed), version) === installed) {
      await update((latest) => ({ ...latest, pendingVersion: null, notifiedVersion: null }));
      clear();
      return false;
    }
    if (isBusy()) { await notePending(version); retry(); return false; }
    let windows;
    try { windows = await listWindowClients(); }
    catch (error) { log('[update] window unavailable', error); retry(); return false; }
    if (!Array.isArray(windows) || windows.some(isBlockingWindow) || isBusy()) {
      await notePending(version); retry(); return false;
    }
    await update((latest) => ({ ...latest, pendingVersion: version }));
    clear();
    runtime.reload();
    return true;
  };
  const apply = () => {
    if (!active) active = tryApply().finally(() => { active = null; });
    return active;
  };

  const remember = async (/** @type {unknown} */ version) => {
    if (!validVersion(version)) return false;
    const exact = /** @type {string} */ (version);
    await update((state) => ({ ...state, pendingVersion: state.pendingVersion
      ? newer(state.pendingVersion, exact) : exact }));
    await ready();
    await apply();
    return true;
  };

  const checkNow = () => {
    if (!check) check = (async () => {
      await ready();
      if (!isEnabled() || typeof runtime.requestUpdateCheck !== 'function') return false;
      const state = await read();
      if (state.lastCheckAt !== null && now() - state.lastCheckAt < 21_600_000) return false;
      try { await runtime.requestUpdateCheck(); }
      catch (error) { log('[update] request failed', error); return false; }
      await update((latest) => ({ ...latest, lastCheckAt: now() }));
      return true;
    })().finally(() => { check = null; });
    return check;
  };

  return Object.freeze({
    onUpdateAvailable: (/** @type {{version?:unknown}} */ details) => remember(details?.version),
    recover: async (/** @type {{entries?:any[]}} */ recovery = {}) => {
      const versions = (Array.isArray(recovery.entries) ? recovery.entries : [])
        .filter((entry) => entry?.event === 'runtime.onUpdateAvailable')
        .map((entry) => entry?.payload?.version).filter(validVersion);
      if (versions.length) await remember(versions.reduce((best, version) => newer(best, version)));
      else await apply();
    },
    start: async () => { await ready(); await apply(); await checkNow(); },
    onUiConnect: async () => { await apply(); await checkNow(); },
    onQuiet: apply,
    onSettingsChanged: () => checkNow(),
    checkNow,
  });
};

const root = /** @type {any} */ (globalThis);
const addonId = Symbol.for('peerd.kernel.target-addon.v1');
if (root[addonId]) throw new Error('kernel-target-addon-owner-conflict');
const createUpdateCustody = (/** @type {any} */ c) => createKernelUpdateCustody({
  runtime: c.browser.runtime,
  session: {
    get: async (/** @type {string} */ key) =>
      (await c.browser.storage.session.get(key))?.[key],
    set: async (/** @type {string} */ key, /** @type {any} */ value) => {
      await c.browser.storage.session.set({ [key]: value });
    },
  },
  ready: async () => { await c.kernelReady; },
  isEnabled: () => c.settingsStore.get().autoUpdateEnabled === true,
  isBusy: () => c.uiPorts.size > 0 || Object.entries(
    c.featureHost.runtime.snapshot()?.leases ?? {},
  ).some(([scope, lease]) => !['dweb', 'vault-authority'].includes(scope)
    && ['starting', 'active', 'unknown'].includes(lease?.status)),
  listWindowClients: async () => {
    const clients = /** @type {any} */ (globalThis).clients;
    if (!clients?.matchAll) throw new Error('kernel-update-window-oracle-unavailable');
    return clients.matchAll({ type: 'window' });
  },
  isBlockingWindow: (/** @type {any} */ client) => client?.url !== c.offscreenUrl,
  notify: (/** @type {string} */ text) => {
    if (c.uiPorts.size === 0) return false;
    c.uiPorts.broadcast({ type: 'turn/system-note', text });
    return true;
  },
  log: (/** @type {any[]} */ ...args) => console.log('[kernel]', ...args),
});

export const createPreviewContributorAuthority = (/** @type {any} */ { kv }) => {
  if (!kv?.get || !kv?.set || !kv?.delete) {
    throw new TypeError('kernel-preview-contributor-config-invalid');
  }
  const key = 'contributor_metrics.aggregate.v1';
  let tail = Promise.resolve();
  const effect = (/** @type {()=>Promise<any>} */ run) => {
    const task = tail.then(run, run);
    tail = task.then(() => {}, () => {});
    return task;
  };
  const handle = async (/** @type {string} */ op, /** @type {any} */ payload,
    /** @type {any} */ ctx) => {
    const kind = op.startsWith('semantic.contributor.') ? op.slice(21) : '';
    const route = kind === 'read' ? 'status' : kind.startsWith('enable') ? 'enable'
      : kind === 'disable-read' || kind === 'clear' ? 'disable' : null;
    const write = kind === 'enable' || kind === 'clear';
    if (!route || ctx?.authority?.target !== `semantic:contributor/${route}:options`) return null;
    if (ctx.signal?.aborted || ctx.deadlineAt <= Date.now()) {
      return { ok: false, code: 'semantic-kernel-operation-expired', outcomeKnown: true };
    }
    const run = async () => {
      if (kind.endsWith('read')) return kv.get(key);
      if (kind === 'clear') {
        await kv.delete(key); return { ok: true };
      }
      const current = await kv.get(key);
      if (JSON.stringify(current ?? null) !== JSON.stringify(payload?.expected ?? null)) {
        return { ok: false, error: 'contributor-state-changed' };
      }
      const value = { version: 1,
        consent: { enabled: true, schemaVersion: 1, disclosureVersion: 1,
          generation: crypto.randomUUID() },
        aggregate: { version: 1, rows: {}, dedupe: [], contexts: {}, contextOrder: [],
          feedback: {}, feedbackOrder: [] } };
      await kv.set(key, value);
      return { ok: true, value };
    };
    try {
      const value = write ? await effect(run) : await run();
      return { ok: true, outcomeKnown: true, value };
    } catch {
      return { ok: false, code: 'semantic-contributor-operation-failed',
        outcomeKnown: !write };
    }
  };
  return Object.freeze({
    handle,
  });
};

const createPreviewContributorRoutes = (/** @type {any} */ {
  kv, optionsUi, offscreenUrl, featureHost,
}) => {
  if (typeof optionsUi !== 'function' || typeof offscreenUrl !== 'string'
      || typeof featureHost?.runtime?.runWithLease !== 'function') {
    throw new TypeError('kernel-preview-contributor-routes-invalid');
  }
  const authority = createPreviewContributorAuthority({ kv });
  const allowed = Object.freeze({
    'contributor/status': Object.freeze({ 'semantic.contributor.read': 1 }),
    'contributor/enable': Object.freeze({
      'semantic.contributor.enable-read': 2, 'semantic.contributor.enable': 1,
    }),
    'contributor/disable': Object.freeze({
      'semantic.contributor.clear': 1, 'semantic.contributor.disable-read': 1,
    }),
  });
  const dispatch = async (/** @type {string} */ route,
    /** @type {any} */ message, /** @type {any} */ sender) => {
    if (!Object.hasOwn(allowed, route) || message?.type !== route || !optionsUi(sender)) {
      return { ok: false, code: 'contributor-channel-admission-denied', outcomeKnown: true };
    }
    let entered = false;
    const result = await featureHost.runtime.runWithLease('controller', async (/** @type {any} */ lease) => {
      entered = true;
      const clients = await /** @type {any} */ (globalThis).clients?.matchAll?.({
        type: 'window', includeUncontrolled: true,
      }) ?? [];
      const exact = clients.filter((/** @type {any} */ client) => client?.url === offscreenUrl);
      if (exact.length !== 1) {
        return { ok: false, code: 'contributor-channel-host-unavailable', outcomeKnown: true };
      }
      const channelId = crypto.randomUUID();
      const offer = {
        type: CONTRIBUTOR_CHANNEL_OFFER, protocol: CONTRIBUTOR_CHANNEL_PROTOCOL,
        channelId, route, lease,
      };
      if (!parseContributorOffer(offer)) {
        return { ok: false, code: 'contributor-channel-offer-invalid', outcomeKnown: true };
      }
      const { port1, port2 } = new MessageChannel();
      return new Promise((resolve) => {
        const deadlineAt = Date.now() + 15_000;
        const counts = new Map();
        let effectDispatched = false;
        let settled = false;
        const finish = (/** @type {any} */ value) => {
          if (settled) return;
          settled = true; clearTimeout(timer);
          try { port1.close(); } catch {}
          resolve(value);
        };
        const lost = () => finish({
          ok: false, code: 'contributor-channel-lost',
          outcomeKnown: !effectDispatched,
          ...(effectDispatched ? { outcomeKind: 'unknown', retryable: false } : {}),
        });
        const timer = setTimeout(lost, 15_000);
        port1.onmessage = (event) => {
          const packet = event.data;
          if (packet?.protocol !== CONTRIBUTOR_CHANNEL_PROTOCOL
              || packet.channelId !== channelId) { lost(); return; }
          if (packet.type === CONTRIBUTOR_CHANNEL_RESULT) {
            finish(packet.result ?? { ok: false, outcomeKnown: effectDispatched ? false : true });
            return;
          }
          if (packet.type !== CONTRIBUTOR_CHANNEL_CALL
              || typeof packet.requestId !== 'string' || typeof packet.operation !== 'string') {
            lost(); return;
          }
          const limits = /** @type {any} */ (allowed)[route];
          const used = counts.get(packet.operation) ?? 0;
          if (used >= (limits[packet.operation] ?? 0)) { lost(); return; }
          counts.set(packet.operation, used + 1);
          if (packet.operation === 'semantic.contributor.enable'
              || packet.operation === 'semantic.contributor.clear') effectDispatched = true;
          Promise.resolve(authority.handle(packet.operation, packet.payload, {
            authority: { target: `semantic:${route}:options` },
            signal: { aborted: false }, deadlineAt,
          })).then((value) => {
            try { port1.postMessage({
              type: CONTRIBUTOR_CHANNEL_REPLY, protocol: CONTRIBUTOR_CHANNEL_PROTOCOL,
              channelId, requestId: packet.requestId,
              result: value ?? { ok: false, outcomeKnown: true },
            }); } catch { lost(); }
          }, lost);
        };
        port1.onmessageerror = lost;
        port1.addEventListener?.('close', lost, { once: true });
        port1.start();
        try { exact[0].postMessage(offer, [port2]); } catch { lost(); }
      });
    }, { reason: 'preview-contributor-demand' });
    return entered ? result
      : { ok: false, code: 'contributor-channel-host-unavailable', outcomeKnown: true };
  };
  return Object.freeze(Object.fromEntries(Object.keys(allowed).map((route) => [
    route, (/** @type {any} */ message, /** @type {any} */ sender) =>
      dispatch(route, message, sender),
  ])));
};
root[addonId] = Object.freeze({
  target: 'preview-chrome', update: createUpdateCustody,
  contributor: createPreviewContributorRoutes,
});
