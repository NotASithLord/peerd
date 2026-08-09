// @ts-check
// background/update-check.js - self-update for the self-hosted preview channel.
//
// why this exists: preview installs update via `update_url` feeds
// (peerd.ai/updates → GitHub release artifacts), but the browsers' own polls
// are slow AND peerd's offscreen keepalive holds the MV3 service worker
// alive - which is exactly the state where Chrome parks a downloaded
// extension update waiting for an "idle" that never comes. So on startup we
// ask for the update ourselves and apply it while nothing is live.
//
// Per browser:
//   Chrome - runtime.requestUpdateCheck() forces the update_url poll; a found
//   update downloads in the background and fires runtime.onUpdateAvailable,
//   where we runtime.reload() IF nothing is live (no turn or goal run in
//   flight, no UI port, no engine tab, no other extension page); otherwise a
//   note is posted and the parked update is re-attempted when a UI surface
//   disconnects (onQuiet), or the browser applies it at its next restart.
//   Firefox - has no requestUpdateCheck API at all, so we read the gecko
//   update feed directly (it is served with open CORS) and surface an
//   "update available" notice whose action opens the XPI; Firefox's own
//   daily add-on poll still auto-applies it regardless.
//   Dev (load-unpacked) and store packages carry no self-hosted update_url:
//   start() registers NOTHING there. That gate is load-bearing on Firefox,
//   where the mere PRESENCE of an onUpdateAvailable listener defers every
//   downloaded add-on update until reload()/browser restart (presence-based,
//   unlike Chrome's unload-based deferral) - a listener on the store package
//   would break AMO's automatic updates. The store artifact also omits the
//   autoUpdateEnabled key entirely (store updates belong to the store).
//
// why fetchFn is injected, not a bare fetch: the feed read is the same class
// of chassis-internal DATA fetch as the voice model download (a hardcoded,
// manifest-derived URL, no secret attached - see voice/model-store.js's
// rationale for why the egress allowlist doesn't apply), but this module
// stays IO-free so the decision logic is Bun-testable.

/** Session-storage key for per-browser-session state (throttle + notice). */
export const UPDATE_CHECK_SESSION_KEY = 'updateCheck.v1';

// Re-checks within this window are skipped - startup and panel-open events
// can cluster (SW respawns, panel toggling), and the browsers poll on their
// own cadence anyway; this is a floor, not a schedule. Only a COMPLETED
// check starts the window (an offline boot must not burn it).
export const MIN_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

// The only hosts an update_link may point at. The browsers' own update
// pipelines are protected by package signing (CRX key, AMO signature); this
// link instead becomes a trusted-UI "Install update" button, so a compromised
// feed must not be able to aim it at an arbitrary https URL.
export const ALLOWED_UPDATE_LINK_HOSTS = Object.freeze(['github.com', 'peerd.ai']);

// Release versions are plain dotted numerics; anything else in a feed is
// junk and must not reach compareVersions or the notice copy.
const VERSION_SHAPE = /^\d+(\.\d+)*$/;
const VERSION_MAX_LENGTH = 32;

/**
 * Numeric dotted-version compare ("0.6.0" style). Missing parts count as 0,
 * non-numeric parts as 0 - release versions here are plain x.y.z triples.
 * @param {string} a
 * @param {string} b
 * @returns {number} negative if a < b, 0 if equal, positive if a > b
 */
export const compareVersions = (a, b) => {
  const pa = String(a).split('.');
  const pb = String(b).split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const na = Number.parseInt(pa[i] ?? '0', 10) || 0;
    const nb = Number.parseInt(pb[i] ?? '0', 10) || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
};

/**
 * Pick the newest update entry for our gecko id out of an AMO-style update
 * feed. Defensive against a malformed or hostile feed: entries must carry a
 * plain dotted-numeric version and an https update_link on an allowed host,
 * or they are skipped.
 * @param {unknown} feedJson
 * @param {string} geckoId
 * @returns {{ version: string, updateLink: string } | null}
 */
export const latestGeckoUpdate = (feedJson, geckoId) => {
  if (!feedJson || typeof feedJson !== 'object') return null;
  const addons = /** @type {{ addons?: Record<string, { updates?: unknown }> }} */ (feedJson).addons;
  const updates = addons?.[geckoId]?.updates;
  if (!Array.isArray(updates)) return null;
  /** @type {{ version: string, updateLink: string } | null} */
  let best = null;
  for (const entry of updates) {
    if (!entry || typeof entry !== 'object') continue;
    const { version, update_link: updateLink } = /** @type {Record<string, unknown>} */ (entry);
    if (typeof version !== 'string' || typeof updateLink !== 'string') continue;
    if (version.length > VERSION_MAX_LENGTH || !VERSION_SHAPE.test(version)) continue;
    let url;
    try { url = new URL(updateLink); } catch { continue; }
    if (url.protocol !== 'https:') continue;
    if (!ALLOWED_UPDATE_LINK_HOSTS.includes(url.hostname)) continue;
    if (!best || compareVersions(version, best.version) > 0) {
      best = { version, updateLink };
    }
  }
  return best;
};

/**
 * @typedef {{
 *   version: string,
 *   update_url?: string,
 *   browser_specific_settings?: { gecko?: { id?: string, update_url?: string } },
 * }} UpdateManifest
 */

/**
 * @typedef {{
 *   lastCheckAt?: number,
 *   notifiedVersion?: string,
 *   pendingNotice?: { version: string, text: string, url: string },
 * }} UpdateSessionState
 */

/**
 * @param {{
 *   runtime: {
 *     getManifest: () => UpdateManifest,
 *     requestUpdateCheck?: () => Promise<unknown>,
 *     onUpdateAvailable?: { addListener: (fn: (details: { version: string }) => void) => void },
 *     reload: () => void,
 *   },
 *   fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
 *   ready: Promise<unknown>,
 *   isEnabled: () => boolean,
 *   busy: () => boolean,
 *   surfacesOpen: () => boolean | Promise<boolean>,
 *   notify: (text: string, action?: { kind: string, label: string, url: string }) => boolean,
 *   sessionKv: {
 *     get: (key: string) => Promise<unknown>,
 *     set: (key: string, value: unknown) => Promise<void>,
 *   },
 *   now?: () => number,
 *   log?: (...args: unknown[]) => void,
 * }} deps
 *   busy is "peerd is doing work" (live turns AND goal runs between turns);
 *   surfacesOpen is "a user-facing extension page exists" (UI ports, portless
 *   engine tabs holding VM/notebook state, any other extension page). Both
 *   must be false before runtime.reload() may fire.
 *   notify returns whether the note was actually DELIVERED to a live UI
 *   surface (false when none is connected) - delivery gates every
 *   notify-once marker so a note nobody saw can post again later.
 *   sessionKv is per-BROWSER-session storage (storage.session): the throttle
 *   and the pending notice must survive event-page/SW respawns but reset
 *   with the browser, matching "check when you start the browser".
 */
export const makeUpdateCheck = ({
  runtime, fetchFn, ready, isEnabled, busy, surfacesOpen, notify, sessionKv,
  now = () => Date.now(),
  log = () => {},
}) => {
  /** @type {string | null} a downloaded update waiting for a quiet moment */
  let pendingDownloadedVersion = null;
  /** @type {string | null} downloaded-update note DELIVERED (per SW lifetime) */
  let downloadNotedVersion = null;
  /** @type {Promise<unknown> | null} coalesces concurrent checkNow calls */
  let inFlightCheck = null;

  /** @returns {Promise<UpdateSessionState>} */
  const sessionState = async () => {
    const state = await sessionKv.get(UPDATE_CHECK_SESSION_KEY);
    return (state && typeof state === 'object') ? state : {};
  };

  // Serialize every read-modify-write of the session record - checkNow and
  // the notice replay can run concurrently (boot vs port connect), and an
  // unserialized read-then-write would double-post the notice.
  /** @type {Promise<unknown>} */
  let sessionChain = Promise.resolve();
  /** @param {(state: UpdateSessionState) => Promise<UpdateSessionState | null> | UpdateSessionState | null} mutate */
  const withSession = (mutate) => {
    const run = sessionChain.then(async () => {
      const state = await sessionState();
      const next = await mutate(state);
      if (next) await sessionKv.set(UPDATE_CHECK_SESSION_KEY, next);
    });
    sessionChain = run.catch(() => {});
    return run;
  };

  // Post the persisted "update available" notice (the Firefox feed path), at
  // most once per version per browser session - counting only deliveries a
  // UI surface received. Persisted, not module state: the Firefox event page
  // suspends when idle, and a notice held in memory would die with it while
  // the throttle survived in storage.session.
  const postPendingNotice = () => withSession((state) => {
    const notice = state.pendingNotice;
    if (!notice || state.notifiedVersion === notice.version) return null;
    if (!notify(notice.text, { kind: 'open-url', label: 'Install update', url: notice.url })) return null;
    return { ...state, notifiedVersion: notice.version };
  });

  // A downloaded update is parked; apply it only when nothing is live.
  // Reloading restarts the whole extension - open panels close, engine tabs
  // (a running WebVM, a notebook mid-compute) are destroyed, the vault
  // re-locks - so every surface and every unit of work blocks it.
  const maybeApplyPendingDownload = async () => {
    const version = pendingDownloadedVersion;
    if (!version || !isEnabled()) return;
    if (busy() || await surfacesOpen()) {
      if (downloadNotedVersion !== version
          && notify(`peerd v${version} is downloaded - it installs when peerd goes quiet or the browser restarts.`)) {
        downloadNotedVersion = version;
      }
      return;
    }
    log('[update] applying downloaded update', version);
    runtime.reload();
  };

  // The browser downloaded an update (our request or its own poll).
  const onUpdateDownloaded = async (/** @type {string} */ version) => {
    await ready; // stored settings may say OFF; never act on the channel default
    if (!isEnabled()) {
      // Firefox defers a downloaded update whenever ANY onUpdateAvailable
      // listener exists, so "disabled" must restore the no-listener default
      // there: apply immediately, live work and all - exactly what Firefox
      // does on its own. Chrome's no-listener default (install at the next
      // SW unload / browser restart) is preserved by doing nothing.
      if (typeof runtime.requestUpdateCheck !== 'function') runtime.reload();
      return;
    }
    pendingDownloadedVersion = version;
    await maybeApplyPendingDownload();
  };

  /** @returns {Promise<boolean>} completed (throttle may start) or failed */
  const checkChrome = async () => {
    if (typeof runtime.requestUpdateCheck !== 'function') return false;
    let result;
    try { result = await runtime.requestUpdateCheck(); }
    catch (error) { log('[update] requestUpdateCheck failed', error); return false; }
    // The polyfill resolves Chrome's two-arg callback as [status, details];
    // a native promise resolves { status, version }. Normalize for the log -
    // behavior needs nothing more: a found update downloads in the background
    // and fires onUpdateAvailable, which onUpdateDownloaded handles.
    const status = typeof result === 'string' ? result
      : Array.isArray(result) ? result[0]
        : (result && typeof result === 'object' && 'status' in result
          ? /** @type {{ status?: unknown }} */ (result).status : undefined);
    log('[update] requestUpdateCheck:', status);
    return true;
  };

  /** @returns {Promise<boolean>} completed (throttle may start) or failed */
  const checkGeckoFeed = async (
    /** @type {UpdateManifest} */ manifest,
    /** @type {{ id?: string, update_url?: string }} */ gecko,
  ) => {
    if (!gecko.update_url || !gecko.id) return false;
    let feed;
    try {
      const response = await fetchFn(gecko.update_url, { cache: 'no-store', credentials: 'omit' });
      if (!response.ok) { log('[update] feed fetch failed', response.status); return false; }
      feed = await response.json();
    } catch (error) { log('[update] feed fetch failed', error); return false; }
    const latest = latestGeckoUpdate(feed, gecko.id);
    if (!latest || compareVersions(latest.version, manifest.version) <= 0) return true;
    await withSession((state) => ({
      ...state,
      pendingNotice: {
        version: latest.version,
        text: `peerd v${latest.version} is available (you have v${manifest.version}). `
          + 'Firefox installs preview updates on its own daily check, or install it now.',
        url: latest.updateLink,
      },
    }));
    await postPendingNotice();
    return true;
  };

  const runCheck = async (/** @type {string} */ reason) => {
    await ready;
    if (!isEnabled()) return;
    const manifest = runtime.getManifest();
    const gecko = manifest.browser_specific_settings?.gecko;
    const chromePath = Boolean(manifest.update_url) && typeof runtime.requestUpdateCheck === 'function';
    if (!chromePath && !gecko?.update_url) return;
    const state = await sessionState();
    if (typeof state.lastCheckAt === 'number' && now() - state.lastCheckAt < MIN_CHECK_INTERVAL_MS) return;
    log('[update] checking for a newer build -', reason);
    const completed = chromePath
      ? await checkChrome()
      : await checkGeckoFeed(manifest, /** @type {{ id?: string, update_url?: string }} */ (gecko));
    if (completed) await withSession((latest) => ({ ...latest, lastCheckAt: now() }));
  };

  /**
   * Ask for a newer build now. Coalesced (boot and a panel connect race on a
   * cold start) and throttled. Chrome preview manifests carry a top-level
   * update_url + the requestUpdateCheck API; Firefox preview carries only
   * the gecko feed URL; dev/store manifests carry neither.
   * @param {string} reason
   */
  const checkNow = (reason) => {
    if (!inFlightCheck) {
      inFlightCheck = runCheck(reason)
        .catch((error) => { log('[update] check failed', error); })
        .finally(() => { inFlightCheck = null; });
    }
    return inFlightCheck;
  };

  return {
    /**
     * Register the update-downloaded listener - ONLY on a self-hosted
     * (preview) manifest, and synchronously at SW boot (a downloaded update
     * can be the very event that wakes the worker). Store/dev packages must
     * not register: on Firefox a listener's mere presence defers every
     * add-on update until reload()/browser restart.
     */
    start() {
      const manifest = runtime.getManifest();
      const selfHosted = (Boolean(manifest.update_url) && typeof runtime.requestUpdateCheck === 'function')
        || Boolean(manifest.browser_specific_settings?.gecko?.update_url);
      if (!selfHosted) return;
      runtime.onUpdateAvailable?.addListener((details) => {
        void onUpdateDownloaded(details?.version ?? '').catch(() => {});
      });
    },

    checkNow,

    /**
     * A UI surface connected: replay an undelivered "update available"
     * notice to it, then re-check (the throttle keeps this cheap).
     */
    onUiConnect() {
      void postPendingNotice()
        .then(() => checkNow('ui-connect'))
        .catch(() => {});
    },

    /**
     * A UI surface disconnected: a parked downloaded update may now be able
     * to apply (the offscreen keepalive means Chrome's own "install when
     * idle" moment never comes on its own).
     */
    onQuiet() {
      void ready.then(() => maybeApplyPendingDownload()).catch(() => {});
    },
  };
};
