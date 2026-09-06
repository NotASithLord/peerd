// @ts-check
// Firefox Preview cannot request an update poll. This exact owner reads the
// signed-package feed and offers only the repository's versioned XPI.

import { withDeadline } from '../shared/cold-util.js';

export const FIREFOX_UPDATE_CUSTODY_KEY = 'kernel.firefoxUpdateCustody.v1';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const VERSION = /^\d+(?:\.\d+)*$/;
const RELEASE = /^\/NotASithLord\/peerd\/releases\/download\/v(\d+(?:\.\d+)*)\/peerd-preview-firefox\.xpi$/;

const validVersion = (/** @type {unknown} */ value) => typeof value === 'string'
  && value.length > 0 && value.length <= 32 && VERSION.test(value);

/** @param {string} left @param {string} right */
export const compareFirefoxUpdateVersions = (left, right) => {
  const a = left.split('.');
  const b = right.split('.');
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const av = BigInt(a[index] ?? '0');
    const bv = BigInt(b[index] ?? '0');
    if (av !== bv) return av > bv ? 1 : -1;
  }
  return 0;
};

/** @param {unknown} feed @param {string} addonId */
export const selectFirefoxPreviewUpdate = (feed, addonId) => {
  const updates = /** @type {any} */ (feed)?.addons?.[addonId]?.updates;
  if (!Array.isArray(updates)) return null;
  /** @type {{version:string,url:string}|null} */
  let selected = null;
  for (const item of updates) {
    if (!validVersion(item?.version) || typeof item?.update_link !== 'string') continue;
    let url;
    try { url = new URL(item.update_link); } catch { continue; }
    const releaseVersion = RELEASE.exec(url.pathname)?.[1];
    if (url.protocol !== 'https:' || url.hostname !== 'github.com'
        || url.port || url.username || url.password || url.search || url.hash
        || releaseVersion !== item.version) continue;
    if (!selected || compareFirefoxUpdateVersions(item.version, selected.version) > 0) {
      selected = { version: item.version, url: url.href };
    }
  }
  return selected ? Object.freeze(selected) : null;
};

/** @param {any} value */
const normalize = (value) => {
  const pending = selectFirefoxPreviewUpdate({ addons: { pending: { updates: [{
    version: value?.pending?.version,
    update_link: value?.pending?.url,
  }] } } }, 'pending');
  return Object.freeze({
    schema: 1,
    lastCheckAt: Number.isFinite(value?.lastCheckAt) && value.lastCheckAt >= 0
      ? value.lastCheckAt : null,
    pending,
    notifiedVersion: validVersion(value?.notifiedVersion) ? value.notifiedVersion : null,
  });
};

/** @param {any} manifest */
const manifestFeed = (manifest) => {
  const gecko = manifest?.browser_specific_settings?.gecko;
  if (typeof gecko?.id !== 'string' || typeof gecko?.update_url !== 'string') return null;
  let url;
  try { url = new URL(gecko.update_url); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'peerd.ai'
      || url.pathname !== '/updates/firefox-preview.json'
      || url.port || url.username || url.password || url.search || url.hash) return null;
  return { addonId: gecko.id, url: url.href };
};

/** @param {any} deps */
export const createKernelFirefoxUpdateCustody = ({
  runtime, session, fetchFn, ready, isEnabled, notify,
  now = Date.now, log = () => {}, feedTimeoutMs = 15_000,
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
}) => {
  if (![runtime?.getManifest, session?.get, session?.set, fetchFn, ready,
    isEnabled, notify].every((value) => typeof value === 'function')
      || !Number.isFinite(feedTimeoutMs) || feedTimeoutMs <= 0) {
    throw new TypeError('kernel-firefox-update-custody-config-invalid');
  }
  let tail = Promise.resolve();
  /** @type {Promise<boolean>|null} */
  let checking = null;
  const read = async () => normalize(await session.get(FIREFOX_UPDATE_CUSTODY_KEY));
  /** @param {(state:ReturnType<typeof normalize>)=>any|Promise<any>} mutate */
  const update = (mutate) => {
    const operation = tail.then(async () => {
      const next = normalize(await mutate(await read()));
      await session.set(FIREFOX_UPDATE_CUSTODY_KEY, next);
      return next;
    });
    tail = operation.then(() => {}, () => {});
    return operation;
  };
  const postPending = async () => {
    let delivered = false;
    await update((state) => {
      const candidate = state.pending;
      if (!isEnabled() || !candidate || state.notifiedVersion === candidate.version) return state;
      const current = runtime.getManifest()?.version;
      if (!validVersion(current)
          || compareFirefoxUpdateVersions(candidate.version, current) <= 0) {
        return { ...state, pending: null, notifiedVersion: null };
      }
      delivered = notify(
        `peerd v${candidate.version} is available (you have v${current}). Firefox can install it now.`,
        { kind: 'open-url', label: 'Install update', url: candidate.url },
      );
      return delivered ? { ...state, notifiedVersion: candidate.version } : state;
    });
    return delivered;
  };
  const runCheck = async () => {
    await ready();
    if (!isEnabled()) return false;
    const manifest = runtime.getManifest();
    const source = manifestFeed(manifest);
    if (!source || !validVersion(manifest.version)) return false;
    const state = await read();
    if (state.lastCheckAt !== null && now() - state.lastCheckAt < CHECK_INTERVAL_MS) {
      await postPending();
      return false;
    }
    /** @type {any} */
    let response;
    /** @type {any} */
    let feed;
    try {
      const controller = new AbortController();
      response = await withDeadline(
        () => fetchFn(source.url, {
          cache: 'no-store', credentials: 'omit', redirect: 'error',
          signal: controller.signal,
        }),
        feedTimeoutMs,
        () => {
          controller.abort('firefox-update-feed-timeout');
          return new Error('firefox-update-feed-timeout');
        },
        setTimeoutFn,
        clearTimeoutFn,
      );
      if (response?.ok) {
        feed = await withDeadline(
          () => response.json(),
          feedTimeoutMs,
          () => {
            controller.abort('firefox-update-feed-timeout');
            return new Error('firefox-update-feed-timeout');
          },
          setTimeoutFn,
          clearTimeoutFn,
        );
      }
    } catch (cause) {
      log('[update] Firefox feed fetch failed', cause);
      return false;
    }
    if (!response?.ok) {
      log('[update] Firefox feed response refused', response?.status);
      return false;
    }
    const candidate = selectFirefoxPreviewUpdate(feed, source.addonId);
    const pending = candidate
      && compareFirefoxUpdateVersions(candidate.version, manifest.version) > 0
      ? candidate : null;
    await update((latest) => ({
      ...latest,
      lastCheckAt: now(),
      pending,
      notifiedVersion: pending?.version === latest.pending?.version
        ? latest.notifiedVersion : null,
    }));
    await postPending();
    return true;
  };
  const checkNow = () => {
    checking ??= runCheck().finally(() => { checking = null; });
    return checking;
  };
  return Object.freeze({
    start: checkNow,
    checkNow,
    // why: checkNow owns both the fresh-feed and throttled-pending paths. A UI
    // reconnect must not display a cached offer before a due feed can withdraw it.
    onUiConnect: checkNow,
    onQuiet: async () => false,
    onSettingsChanged: checkNow,
  });
};
