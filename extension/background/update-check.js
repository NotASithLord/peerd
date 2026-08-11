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
//   "update available" notice whose action opens the XPI. We never register
//   an onUpdateAvailable listener there, so Firefox's own update lifecycle
//   remains untouched.
//   Dev (load-unpacked) and store packages carry no self-hosted update_url:
//   start() registers NOTHING there. The Chrome-only listener gate is
//   load-bearing: on Firefox the mere PRESENCE of an onUpdateAvailable
//   listener defers downloaded add-on updates until reload()/browser restart.
//   The store artifact also omits the autoUpdateEnabled key entirely (store
//   updates belong to the store).
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
const RETRY_BASE_MS = 15_000;
const RETRY_MAX_MS = 120_000;
const RETRY_LIMIT = 8;

// The only hosts an update_link may point at. The browsers' own update
// pipelines are protected by package signing (CRX key, AMO signature); this
// link instead becomes a trusted-UI "Install update" button, so a compromised
// feed must not be able to aim it at an arbitrary https URL.
export const ALLOWED_UPDATE_LINK_HOSTS = Object.freeze(['github.com']);

// The notice is trusted product UI, so host allowlisting alone is too broad:
// github.com can host unrelated files and login pages. Accept only the
// repository's versioned Firefox preview release asset.
const FIREFOX_RELEASE_PATH = /^\/NotASithLord\/peerd\/releases\/download\/v(\d+(?:\.\d+)*)\/peerd-preview-firefox\.xpi$/;

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
    const releaseVersion = FIREFOX_RELEASE_PATH.exec(url.pathname)?.[1];
    if (!ALLOWED_UPDATE_LINK_HOSTS.includes(url.hostname)
        || url.username || url.password || url.search || url.hash
        || releaseVersion !== version) continue;
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
 *   pendingNotice?: { version: string, url: string },
 * }} UpdateSessionState
 */

/**
 * @param {{
 *   runtime: {
 *     getManifest: () => UpdateManifest,
 *     requestUpdateCheck?: () => Promise<unknown>,
 *     onUpdateAvailable?: {
 *       addListener: (fn: (details: { version: string }) => void) => void,
 *       removeListener?: (fn: (details: { version: string }) => void) => void,
 *     },
 *     reload: () => void,
 *   },
 *   fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
 *   ready: Promise<unknown> | (() => Promise<unknown>),
 *   isEnabled: () => boolean,
 *   busy: () => boolean,
 *   surfacesOpen: () => boolean | Promise<boolean>,
 *   notify: (text: string, action?: { kind: string, label: string, url: string }) => boolean,
 *   sessionKv: {
 *     get: (key: string) => Promise<unknown>,
 *     set: (key: string, value: unknown) => Promise<void>,
 *   },
 *   now?: () => number,
 *   scheduleRetry?: (fn: () => void, delayMs: number) => unknown,
 *   cancelRetry?: (handle: unknown) => void,
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
  scheduleRetry = (fn, delayMs) => setTimeout(fn, delayMs),
  cancelRetry = (handle) => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (handle)),
  log = () => {},
}) => {
  const awaitReady = () => typeof ready === 'function' ? ready() : ready;
  /** @type {string | null} a downloaded update waiting for a quiet moment */
  let pendingDownloadedVersion = null;
  /** @type {string | null} downloaded-update note DELIVERED (per SW lifetime) */
  let downloadNotedVersion = null;
  /** @type {Promise<unknown> | null} coalesces concurrent checkNow calls */
  let inFlightCheck = null;
  /** @type {unknown | null} one retry at a time while a download is parked */
  let retryHandle = null;
  let retryAttempts = 0;
  // A startup event can arrive before stored settings hydrate. If the durable
  // setting is OFF, the synchronous listener still consumed Chrome's native
  // event, so peerd must safely complete that one intercepted update to
  // restore the no-listener outcome.
  let mustApplyInterceptedDownload = false;
  let listenerEligible = false;
  let listenerRegistered = false;

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
    if (!isEnabled()) return null;
    const notice = state.pendingNotice;
    if (!notice || state.notifiedVersion === notice.version) return null;
    const currentVersion = runtime.getManifest().version;
    const validated = latestGeckoUpdate({
      addons: { notice: { updates: [{ version: notice.version, update_link: notice.url }] } },
    }, 'notice');
    if (!validated || compareVersions(validated.version, currentVersion) <= 0) {
      const { pendingNotice: _dropped, ...rest } = state;
      return rest;
    }
    const text = `peerd v${validated.version} is available (you have v${currentVersion}). `
      + 'Firefox installs preview updates on its own daily check, or install it now.';
    if (!notify(text, { kind: 'open-url', label: 'Install update', url: validated.updateLink })) return null;
    return { ...state, notifiedVersion: notice.version };
  });

  const clearRetry = () => {
    if (retryHandle !== null) cancelRetry(retryHandle);
    retryHandle = null;
    retryAttempts = 0;
  };

  const retryLater = () => {
    if (retryHandle !== null || retryAttempts >= RETRY_LIMIT) return;
    const delayMs = Math.min(RETRY_BASE_MS * (2 ** retryAttempts), RETRY_MAX_MS);
    retryAttempts += 1;
    retryHandle = scheduleRetry(() => {
      retryHandle = null;
      void maybeApplyPendingDownload().catch(() => {});
    }, delayMs);
  };

  /** @param {string} version @param {boolean} retry */
  const noteDeferred = (version, retry) => {
    if (downloadNotedVersion !== version
        && notify(`peerd v${version} is downloaded - it installs when peerd goes quiet or the browser restarts.`)) {
      downloadNotedVersion = version;
    }
    if (retry) retryLater();
  };

  // A downloaded update is parked; apply it only when nothing is live.
  // Reloading restarts the whole extension - open panels close, engine tabs
  // (a running WebVM, a notebook mid-compute) are destroyed, the vault
  // re-locks - so every surface and every unit of work blocks it.
  const maybeApplyPendingDownload = async () => {
    const version = pendingDownloadedVersion;
    if (!version || (!isEnabled() && !mustApplyInterceptedDownload)) { clearRetry(); return; }
    if (busy()) { noteDeferred(version, true); return; }
    const open = await surfacesOpen();
    // Work can start while the asynchronous window-client scan is pending.
    // Recheck every synchronous gate in the same task immediately before the
    // reload, so no turn or settings transition can slip through the await.
    if (!isEnabled() && !mustApplyInterceptedDownload) { clearRetry(); return; }
    if (busy() || open) { noteDeferred(version, busy()); return; }
    clearRetry();
    log('[update] applying downloaded update', version);
    pendingDownloadedVersion = null;
    mustApplyInterceptedDownload = false;
    runtime.reload();
  };

  // The browser downloaded an update (our request or its own poll).
  const onUpdateDownloaded = async (/** @type {string} */ version) => {
    await awaitReady(); // stored settings may say OFF; never act on the channel default
    pendingDownloadedVersion = version;
    if (!isEnabled()) mustApplyInterceptedDownload = true;
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
    if (!isEnabled()) return false;
    const latest = latestGeckoUpdate(feed, gecko.id);
    if (!latest || compareVersions(latest.version, manifest.version) <= 0) return true;
    await withSession((state) => (isEnabled() ? {
        ...state,
        pendingNotice: {
          version: latest.version,
          url: latest.updateLink,
        },
      } : null));
    await postPendingNotice();
    return true;
  };

  const runCheck = async (/** @type {string} */ reason) => {
    await awaitReady();
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

  /** @param {{ version: string }} details */
  const onUpdateDownloadedListener = (details) => {
    void onUpdateDownloaded(details?.version ?? '').catch(() => {});
  };

  const syncEnabled = () => {
    const events = runtime.onUpdateAvailable;
    if (!listenerEligible || !events) return;
    if (isEnabled() && !listenerRegistered) {
      events.addListener(onUpdateDownloadedListener);
      listenerRegistered = true;
      if (pendingDownloadedVersion) void maybeApplyPendingDownload().catch(() => {});
    } else if (!isEnabled() && listenerRegistered) {
      events.removeListener?.(onUpdateDownloadedListener);
      listenerRegistered = false;
      if (pendingDownloadedVersion) {
        mustApplyInterceptedDownload = true;
        void maybeApplyPendingDownload().catch(() => {});
      } else {
        clearRetry();
      }
    }
  };

  return {
    /**
     * Register the update-downloaded listener only for self-hosted Chrome.
     * Firefox needs no keepalive workaround and must never register this
     * listener because its presence changes the browser's update lifecycle.
     * Registration remains synchronous on Chrome because a downloaded update
     * can be the event that wakes the worker.
     */
    start() {
      const manifest = runtime.getManifest();
      const selfHostedChrome = Boolean(manifest.update_url)
        && typeof runtime.requestUpdateCheck === 'function';
      if (!selfHostedChrome) return;
      listenerEligible = true;
      // Event listeners that wake an MV3 worker must exist during top-level
      // evaluation. The handler waits for stored settings; syncEnabled removes
      // it after hydration when OFF and safely finishes an event intercepted
      // during that short startup window.
      runtime.onUpdateAvailable?.addListener(onUpdateDownloadedListener);
      listenerRegistered = Boolean(runtime.onUpdateAvailable);
      void awaitReady().then(syncEnabled).catch(() => {});
    },

    checkNow,
    syncEnabled,

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
      void awaitReady().then(() => maybeApplyPendingDownload()).catch(() => {});
    },
  };
};
