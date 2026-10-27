// @ts-check
// home/discover-section.js - the Discover view (dweb preview only).
//
// Apps peers SHARE on the always-on base network show up here: their record
// (name + publisher + content uri) rides gossip (re-announced so late joiners
// hear it) and is durable in the DHT. Installing fetches the signed bundle
// over the base mesh, verifies it, and adds it to your Library, peer to peer,
// with no server. A pure CLIENT (SW routes only; never imports the dweb
// module), so the store build prunes nothing here but it never mounts
// (DWEB_ENABLED gate).
//
// One component, four pages: the root (start list while the peer network is
// off; looking, empty, tile grid or offline grid while it is on), an app
// page, a share-link page and a maker page. Pure rules live in
// discover-model.js (blocked makers in blocked-makers.js, shared with
// Contacts) and view pieces in discover-pages.js.

import m from '/vendor/mithril/mithril.js';
import { immutableAppRoot } from '/shared/address/immutable-app-root.js';
import { disarmText } from '/shared/disarm-text.js';
import { loadDweb } from '/shared/dweb-loader.js';
import { openOptions } from '/shared/open-options.js';
import { packagedStarter, starterKeys } from '/shared/starter-catalog.js';
import { blockedSet, effectOutcome, withoutBlocked } from './blocked-makers.js';
import { discoveryAddress } from './discovery-address.js';
import { exploreOrder, EXPLORE_WINDOW, nextSuggestion, recentRetrievalMiss, suggestionKey } from './explore-order.js';
import {
  BLOCKED, BLOCKED_ERROR, bytesLabel, createEffects, FAILED, failureHint, isFailure, kbLabel, keptCards, letterOf, libraryPeerApps,
  libraryStatus, makerMenu, matchQuery, networkState, noSuggestionNote, pageState, pillFilter, appCountLabel, peerCountLabel, rootView,
  savedContactNames, savedNameForm, saysIt, shareLinkError, shortKey, tileAction, toneOf, UNKNOWN, unknownLines, updateOffer,
  verifiedDeclared, wasmLabel, yourApps,
} from './discover-model.js';
import {
  actionView, appHead, appRow, backLink, blockDialog, blockedLine, cantRunPanel, conflictPanel, emptyState, installPanel,
  keyedParts, makerHead, makerMenuView, makerMeta, noteBox, pills, refreshButton, renameForm, safetyLines, saysItSection,
  searchInput, secondaryButton, shareDialog, shareRow, startRow, statusRow, techDetails, tile, tileButton, updatePanel,
  yourAppsRow,
} from './discover-pages.js';

/** @typedef {import('../options/sections/reset-row.js').Send} Send */
/** @typedef {import('./discover-model.js').DwebApp} DwebApp */
/** @typedef {import('./discover-model.js').DiscoverEffects} DiscoverEffects */
/** @typedef {import('./discover-model.js').LinkOutcome} LinkOutcome */
/** @typedef {import('./discover-model.js').NetworkState} NetworkState */
/** @typedef {import('./discover-model.js').Pill} Pill */
/** @typedef {import('./discover-pages.js').Fact} Fact */
/** @typedef {import('./discover-pages.js').ButtonProps} ButtonProps */
/** @typedef {{page:'root'}|{page:'app', key:string}|{page:'link'}|{page:'maker', did:string}} Route */
/** @typedef {ReturnType<typeof immutableAppRoot>} LinkTarget */
/** @typedef {LinkTarget & {name:string|null, decodedBytes?:number, containsWasm?:boolean, runtimeCompatibility?:{status:string,message:string}, declared?:unknown}} LinkSummary */
/** @typedef {{id:string, name?:string, dweb?:{uri?:string, dwapp_id?:string, version_id?:string|null, seq?:number, seed?:string, hash?:string, publisher?:string, declared?:unknown}}} LibraryRecord */
/**
 * @typedef {{
 *   send: Send,
 *   enabled: boolean,
 *   reconcileState?: () => Promise<unknown>,
 *   openKey?: string|null,
 *   onOpenKey?: () => void,
 *   onLibrary?: () => void,
 *   initialSeed?: number,
 *   effects?: DiscoverEffects,
 * }} Attrs
 */

const PENDING_KEY = 'peerd.manual-app-install.pending';
const RUNTIME_CODES = Object.freeze(['app-runtime-invalid', 'app-runtime-unsupported', 'app-runtime-mismatch']);
const POLL_MS = 4000;
const COPIED_MS = 2000;
const TECH_ID = 'disc-tech-facts';
const COMMONS_NAME = 'Peerd-to-Peerd Commons';
const CHOICE_ERROR = 'peerd could not confirm that the peer network is on. Check again before you try again.';
const RECEIPT_HELD = 'peerd is not sure the install finished. It may still finish by itself. Install stays off until peerd knows.';
const KEEPS_GOING = 'You can leave this page. The install keeps going.';
const CHECKING_LINK = 'Checking the link. peerd downloads the app and checks every file…';
const COMMONS_UNKNOWN = 'peerd is not sure Commons was added or opened. Check your Library and your tabs before you try again.';
const COMMONS_FAILED = 'peerd could not add or open Commons. Try again.';
const NEEDS_NETWORK = 'New apps need the peer network.';
const OFFLINE_EMPTY = `You can still open the apps in your Library. ${NEEDS_NETWORK}`;
const MAKER_EMPTY = 'This maker’s apps show up here when the people you are connected to share them.';
const AUDIT_FAILED = 'peerd could not add it to the security log.';
const SHARING = 'Sharing means other people can get this app from you while your peer network is on.';
const BLOCKED_LINK = 'You blocked the maker of this app. To look at it, unblock them in Contacts.';
const LOOKING = 'Looking for people who share apps…';
// why prefixes: an Open in the Your apps row reports in its own row, and a
// copy in the share dialog in the dialog, never under Technical details.
const YOURS = 'yours:';
const SHARE = 'share:';
const YOURS_MAX = 6;
// why a marker: the receipt could not be kept, so the install was never sent.
const RECEIPT_FAILED = 'receipt-failed';
// why: a heard card carries the maker's own WebAssembly claim. A share link
// shows what peerd found in the files instead.
const WASM_HINT = 'The WebAssembly hint comes from the maker. peerd does not check it.';
// The start row names one packaged starter; the others follow it.
const FEATURED_STARTER = 'csv-lab';
const FEATURED = packagedStarter(FEATURED_STARTER);

// why module scope: the app page says "You can leave this page. The install
// keeps going." A rail switch unmounts this view, and dweb/base/install has no
// dedupe, so the busy/unknown fences must outlive the component or a second
// click can mint a duplicate install. A reload still drops them; the share
// link keeps its sessionStorage receipt for that.
const sharedEffects = createEffects();

/** The Discover view, mounted on the home page (DWEB_ENABLED only).
 * @param {{attrs: Attrs}} initialVnode */
export const DiscoverSection = (initialVnode) => {
  let attrs = initialVnode.attrs;
  const effects = attrs.effects ?? sharedEffects;
  const { busy, running, notices, unconfirmed, installedId, conflicts, committed } = effects;
  let dead = false;
  /** @type {Element|null} */ let rootDom = null;
  let viewEnabled = attrs.enabled;

  /** @type {DwebApp[]} */ let apps = [];
  /** @type {Map<string, DwebApp>} */ let heardCache = new Map();
  let loading = true;
  let heardFailed = false;
  let localReady = false;
  let localFailed = false;
  /** @type {LibraryRecord[]} */ let records = [];
  /** @type {Map<string, string>} */ let installedByUri = new Map();
  /** @type {Map<string, {appId:string, version_id:string|null, seq:number}>} */ let installedByDwappId = new Map();
  /** @type {string|null} */ let commonsId = null;
  /** @type {Map<string, string>} */ let contactNames = new Map();
  // Makers the user blocked, by full did: their apps leave every Discover list.
  /** @type {Set<string>} */ let blockedDids = new Set();
  // why counts: a read that started before this view changed a list (a block,
  // a saved name) must not undo that change on screen.
  let blockedReads = 0;
  let blockedChanged = 0;
  let contactReads = 0;
  let contactsChanged = 0;
  /** @type {string|null} */ let myDid = null;
  // What the service worker says of an installed copy, by app id and version:
  // true (its files changed on this device), false (they are the release
  // peerd checked), null (not known yet, or the read failed). `epoch` is the
  // ask the value answers; `asking` is a read in flight.
  /** @type {Map<string, {value:boolean|null, epoch:number, asking:boolean}>} */ const localChanges = new Map();
  let localChangesEpoch = 0;
  /** @type {NetworkState|null} */ let net = null;
  let retrying = false;

  let choiceBusy = false;
  let choiceRefreshing = false;
  let choiceAttempt = 0;
  /** @type {string|null} */ let choiceError = null;
  /** @type {ReturnType<typeof setTimeout>|null} */ let choiceTimer = null;

  /** @type {Route} */ let route = { page: 'root' };
  /** @type {DwebApp|null} */ let pageApp = null;
  /** @type {{key:string, scroll:number}|null} */ let origin = null;
  // why: a maker page opened from an app's page returns there, and names it.
  /** @type {{route:Route, name:string}|null} */ let makerFrom = null;
  // The page key whose share dialog is open.
  /** @type {string|null} */ let shareFor = null;
  // The maker page's menu, name form and block confirm. A page change closes them.
  let menuOpen = false;
  /** @type {{did:string, value:string, busy:boolean, failed:boolean}|null} */ let renaming = null;
  /** @type {{did:string, name:string}|null} */ let renameUnknown = null;
  /** @type {string|null} */ let blockFor = null;
  let blockBusy = false;
  /** @type {'failed'|'unknown'|null} */ let blockIssue = null;
  // Installs this view finished, so their line says "Installed." and names
  // the app. A remount or a later visit says only where the app is.
  /** @type {Set<string>} */ const fresh = new Set();
  let linkFresh = false;
  /** @type {{key:string, epoch:number, route:Route, answered:boolean}|null} */ let keyAsk = null;
  /** @type {{selector:string|null, scroll:number|null, fallback?:string, ifLost?:boolean}|null} */ let pendingFocus = null;
  /** @type {Pill} */ let pill = 'all';
  let query = '';
  const seed = attrs.initialSeed ?? crypto.getRandomValues(new Uint32Array(1))[0];
  let limit = EXPLORE_WINDOW;
  let makerLimit = EXPLORE_WINDOW;
  /** @type {string[]} */ let orderedIds = [];
  /** @type {Set<string>} */ const suggested = new Set();
  /** @type {string|null} */ let lastPublisher = null;
  /** @type {string|null} */ let surpriseNote = null;
  let refreshing = false;  // drives the manual Refresh spin (the 4s poll stays silent)
  let techOpen = false;
  /** @type {{field:string, value:string, status:'pending'|'copied'|'failed'}|null} */ let copyState = null;
  /** @type {ReturnType<typeof setTimeout>|null} */ let copyTimer = null;
  /** @type {{key:string, text:string, unknown?:boolean}|null} */ let alertLine = null;

  let shareOpen = false;
  let linkInput = '';
  let linkEpoch = 0;
  /** @type {''|'inspect'|'install'|'reconcile'|'open'|'receipt'} */ let linkBusy = '';
  let linkError = '';
  let linkFailure = '';
  let linkNotice = '';
  /** @type {LinkSummary|null} */ let linkPreview = null;
  /** @type {LinkTarget|null} */ let linkPending = null;
  /** @type {string|null} */ let linkAppId = null;

  let commonsBusy = false;

  /** @type {ReturnType<typeof setInterval>|null} */ let timer = null;
  /** @type {(() => void)|null} */ let onVisible = null;
  /** @type {Promise<boolean>|null} */ let localInFlight = null;
  /** @type {Promise<boolean>|null} */ let refreshInFlight = null;
  let refreshEpoch = 0;
  let appliedRefreshEpoch = 0;
  let statusInFlight = false;
  let contactsInFlight = false;
  /** @type {Promise<boolean>|null} */ let blockedInFlight = null;

  const redraw = () => { if (!dead) m.redraw(); };
  const scrollHost = () => rootDom?.closest('.home-content') ?? document.scrollingElement;

  // Cross-reference the Library so Discover doesn't offer to "install" what's
  // already here AND can tell an installed app apart from a newer announce of
  // it. Best-effort: a failure keeps the last confirmed Library.
  const loadLocal = () => {
    if (localInFlight) return localInFlight;
    const started = ++effects.reads;
    localInFlight = (async () => {
      try {
        const list = await attrs.send({ type: 'apps/list' });
        // why: only the mounted view's own read refreshes the catalog on
        // screen. A closed view's read must not release custody that the
        // mounted view, with an older catalog, still needs.
        if (dead) return false;
        if (!list?.ok || !Array.isArray(list.apps)) throw new Error('app-catalog-unavailable');
        /** @type {LibraryRecord[]} */ const rows = list.apps;
        /** @type {Map<string, string>} */ const byUri = new Map();
        /** @type {Map<string, {appId:string, version_id:string|null, seq:number}>} */ const byId = new Map();
        for (const a of rows) {
          if (a?.dweb?.uri) byUri.set(a.dweb.uri, a.id);
          if (a?.dweb?.dwapp_id) byId.set(a.dweb.dwapp_id, { appId: a.id, version_id: a.dweb.version_id ?? null, seq: a.dweb.seq ?? 0 });
        }
        records = rows;
        installedByUri = byUri;
        installedByDwappId = byId;
        // why only a read that started later: an older read can omit an
        // install or list the version an update replaced.
        for (const [id, commit] of committed) if (started > commit.read) committed.delete(id);
        commonsId = rows.find(a => a?.dweb?.seed === 'commons')?.id ?? null;
        // why: Commons in the catalog confirms a settled or unknown add.
        // A confirmed add made Commons before it replied, so a read that
        // started later and lists no Commons says the user deleted it since.
        if (commonsId || (effects.commons === 'adding' && effects.commonsAdded !== null && started > effects.commonsAdded)) {
          effects.commons = null;
        }
        localReady = true;
        localFailed = false;
        for (const [id, target] of unconfirmed) {
          const local = byId.get(id);
          const identityMatches = !!local
            && (target.versionId === null || local.version_id === target.versionId)
            && (target.seq === null || local.seq >= target.seq);
          const uriOnlyMatches = target.action === 'install' && target.versionId === null
            && target.seq === null && !!target.uri && !!byUri.get(target.uri);
          if (identityMatches || uriOnlyMatches) {
            installedId[id] = local?.appId ?? /** @type {string} */ (byUri.get(/** @type {string} */ (target.uri)));
            busy[id] = 'installed';
            if (target.action === 'install') fresh.add(id);
            unconfirmed.delete(id);
          }
          // Absence is not a causal receipt: the original install/update send
          // may still be alive after the UI deadline and can commit later. Keep
          // the effect fenced until the exact App identity appears. Re-enabling
          // on an empty poll can mint duplicate installs with fresh App ids.
        }
        pruneConflicts();
        return true;
      } catch { localFailed = true; return false; /* retain the last confirmed Library */ }
      finally { localInFlight = null; redraw(); }
    })();
    return localInFlight;
  };
  // why after the read in flight: it can start before a commit, and its reply
  // would then show the Library without that commit until the next poll.
  const reloadLocal = () => (localInFlight ?? Promise.resolve()).then(() => loadLocal());

  /** @param {string} id @param {'install'|'update'} action @param {DwebApp} app */
  const markUnknown = (id, action, app) => {
    conflicts.delete(id);
    unconfirmed.set(id, {
      action,
      versionId: typeof app.version_id === 'string' ? app.version_id : null,
      seq: Number.isSafeInteger(app.seq) && /** @type {number} */ (app.seq) >= 0
        ? /** @type {number} */ (app.seq) : null,
      uri: typeof app.uri === 'string' ? app.uri : null,
    });
    busy[id] = UNKNOWN;
  };

  /** @param {string} id @param {'install'|'update'} action @param {DwebApp} app @param {unknown} result */
  const markFailure = (id, action, app, result) => {
    if (/** @type {{outcomeKnown?:boolean}} */ (result)?.outcomeKnown === false) {
      markUnknown(id, action, app);
      return;
    }
    unconfirmed.delete(id);
    conflicts.delete(id);
    const failure = /** @type {{code?:string,error?:string}} */ (result);
    // why keep the runtime reason: Technical details shows it.
    busy[id] = RUNTIME_CODES.includes(failure?.code ?? '') && typeof failure?.error === 'string' ? failure.error
      : failure?.error === BLOCKED_ERROR ? BLOCKED : FAILED;
  };

  const refresh = () => {
    if (refreshInFlight) return refreshInFlight;
    const epoch = ++refreshEpoch;
    refreshInFlight = (async () => {
      let heardRead = false;
      try {
        const r = await attrs.send({ type: 'dweb/base/heard' });
        if (r?.ok === false || !Array.isArray(r?.apps)) throw new Error('discover-unavailable');
        if (epoch >= appliedRefreshEpoch) {
          appliedRefreshEpoch = epoch;
          /** @type {Map<string, DwebApp>} */ const seen = new Map();
          for (const a of /** @type {DwebApp[]} */ (r.apps)) if (a?.dwapp_id) seen.set(a.dwapp_id, a);
          const next = [...seen.values()];
          // A refresh is not an effect receipt. Retain the exact pending card,
          // including its version, until the mutation can be reconciled.
          const retained = new Map(apps.filter(app => app.dwapp_id
            && (unconfirmed.has(app.dwapp_id) || ['installing', 'updating'].includes(busy[app.dwapp_id])))
            .map(app => [app.dwapp_id, app]));
          // why here too: the host drops a blocked maker's cards on its own
          // policy read, which can come after this view's block.
          apps = withoutBlocked([...next.map(app => retained.get(app.dwapp_id) ?? app),
            ...[...retained.values()].filter(app => !seen.has(/** @type {string} */ (app.dwapp_id)))], blockedDids);
          heardCache = keptCards(heardCache, next, id => installedByDwappId.has(id) || unconfirmed.has(id)
            || ['installing', 'updating'].includes(busy[id]));
          heardFailed = false;
          pruneConflicts();
          heardRead = true;
        }
        return true;
      } catch {
        if (epoch >= appliedRefreshEpoch) heardFailed = true;
        return false;
      } finally {
        loading = false;
        refreshInFlight = null;
        // why here: the first heard read that starts after a notification
        // click answers it, success or failure (see answerKey).
        const ask = keyAsk;
        if (!dead && attrs.enabled && ask && !ask.answered && epoch > ask.epoch) {
          settleKey(ask, heardRead ? apps.find(app => app.dwapp_id === ask.key) : null);
        }
        redraw();
      }
    })();
    return refreshInFlight;
  };

  // Read only: checking connection status never grants participation. The
  // lease decides first, so a stopped host is never started by this read.
  const readStatus = async () => {
    if (statusInFlight) return;
    statusInFlight = true;
    try {
      const ready = await attrs.send({ type: 'bootstrap/ready' });
      const lease = ready?.ok ? ready.featureLeases?.leases?.dweb?.status : null;
      const info = lease === 'active' ? await attrs.send({ type: 'dweb/distributed/info' }) : null;
      net = networkState(ready, info) ?? net;
      if (typeof info?.did === 'string') myDid = info.did;
    } catch { /* keep the last known state */ }
    finally { statusInFlight = false; redraw(); }
  };

  const loadContacts = async () => {
    if (contactsInFlight) return;
    contactsInFlight = true;
    const started = ++contactReads;
    try {
      const reply = await attrs.send({ type: 'contacts/list' });
      if (reply?.ok && started > contactsChanged) contactNames = savedContactNames(reply.contacts);
    } catch { /* "Made by" falls back to the short key */ }
    finally { contactsInFlight = false; redraw(); }
  };

  /** @param {Set<string>} next */
  const applyBlocked = (next) => {
    blockedDids = next;
    apps = withoutBlocked(apps, blockedDids);
  };
  // why with the contacts, not in the poll: Contacts unblocks in another view
  // or tab, and a return here reads again. Resolves whether the list was read.
  /** @returns {Promise<boolean>} */
  const loadBlocked = () => {
    if (blockedInFlight) return blockedInFlight;
    const started = ++blockedReads;
    blockedInFlight = (async () => {
      try {
        const next = blockedSet(await attrs.send({ type: 'dweb/blocked-peers' }));
        if (!next || dead) return false;
        if (started > blockedChanged) applyBlocked(next);
        return true;
      } catch { return false; /* keep the last list */ }
      finally { blockedInFlight = null; redraw(); }
    })();
    return blockedInFlight;
  };

  // why on demand, never in the poll: the check reads every file of the app,
  // under its write lock. A page change and a return to the tab ask again,
  // and so does a new version, as the key holds it. why not a manual refresh:
  // no page that shows a Library copy's facts offers one.
  // why the last answer stays until the next one lands: the page must not
  // drop its warning, or move, while peerd checks again. why one read at a
  // time: each read waits for the app's lock, so a read that a later return
  // made stale answers nothing, and then one more read starts.
  const forgetLocalChanges = () => { localChangesEpoch++; };
  /** @param {string} appId @param {string|undefined} version @returns {boolean|null} */
  const localChangesOf = (appId, version) => {
    const key = `${appId}\0${version ?? ''}`;
    const entry = localChanges.get(key) ?? { value: null, epoch: -1, asking: false };
    if (!entry.asking && entry.epoch !== localChangesEpoch) {
      const epoch = localChangesEpoch;
      entry.asking = true;
      localChanges.set(key, entry);
      void (async () => {
        /** @type {boolean|null} */ let changed = null;
        try {
          const reply = await attrs.send({ type: 'dweb/app-local-changes', appId });
          if (reply?.ok && typeof reply.changed === 'boolean') changed = reply.changed;
        } catch { /* not known: the page claims nothing peerd checked */ }
        entry.asking = false;
        if (dead) return;
        if (epoch === localChangesEpoch) { entry.value = changed; entry.epoch = epoch; }
        // why a redraw for a stale answer too: the next draw asks once more.
        redraw();
      })();
    }
    return entry.value;
  };

  const poll = () => { void loadLocal(); void refresh(); void readStatus(); };
  // why only while enabled: with the peer network off Discover sends nothing.
  // Some dweb reads start the host, and the user has not chosen to join.
  const startPolling = () => {
    if (timer) return;
    poll();
    void loadContacts();
    void loadBlocked();
    timer = setInterval(() => { if (!document.hidden) poll(); }, POLL_MS);
    // Returning to the tab should re-sync at once, not after the next 4s tick.
    // why contacts here, not in the poll: another Home tab can save a maker
    // as a contact meanwhile, and the read also walks the audit log.
    onVisible = () => { if (!document.hidden) { poll(); void loadContacts(); void loadBlocked(); forgetLocalChanges(); } };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
  };
  const stopPolling = () => {
    if (timer) clearInterval(timer);
    timer = null;
    if (onVisible) {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      onVisible = null;
    }
  };

  // The shipped network choice, enable only: "Not now" and "Turn off" live
  // in Settings and the Network view.
  const enableNetwork = () => {
    if (choiceBusy || choiceRefreshing || choiceError || dead) return;
    const token = ++choiceAttempt;
    choiceBusy = true;
    let finished = false;
    const current = () => !dead && token === choiceAttempt;
    /** @param {string|null} error */
    const settle = (error) => {
      if (!current() || finished) return;
      finished = true;
      choiceBusy = false;
      choiceError = error;
      if (choiceTimer) clearTimeout(choiceTimer);
      void attrs.reconcileState?.()?.catch(() => {});
      redraw();
    };
    // Startup can outlive the settings RPC. Confirm only the persisted
    // authority view, then let the user continue while transport connects.
    const confirm = async () => {
      try {
        const reply = await attrs.send({ type: 'state/get' });
        if (reply?.ok && reply.state?.settings?.dwebChoiceMade === true
            && reply.state.settings.dwebEnabled === true) settle(null);
      } catch { /* the mutation reply can still confirm persistence */ }
      if (current() && !finished) choiceTimer = setTimeout(confirm, 750);
    };
    attrs.send({ type: 'settings/update', patch: { dwebEnabled: true } })
      .then(reply => settle(reply?.ok ? null : CHOICE_ERROR), () => settle(CHOICE_ERROR));
    choiceTimer = setTimeout(confirm, 250);
    redraw();
  };

  const refreshChoice = async () => {
    if (choiceRefreshing) return;
    choiceRefreshing = true;
    const token = ++choiceAttempt;
    redraw();
    try {
      const reply = await attrs.send({ type: 'state/get' });
      if (dead || token !== choiceAttempt || !reply?.ok || !reply.state?.settings) return;
      choiceError = null;
      void attrs.reconcileState?.()?.catch(() => {});
    } catch { /* keep the unconfirmed outcome visible */ }
    finally {
      if (!dead && token === choiceAttempt) { choiceRefreshing = false; redraw(); }
    }
  };

  const retryConnection = async () => {
    if (retrying) return;
    retrying = true;
    redraw();
    try { await attrs.send({ type: 'dweb/base/start' }); }
    catch { /* show the read-back result rather than replaying a mutation */ }
    finally {
      retrying = false;
      await readStatus();
      // why after the read-back: Try again went off while it ran, so focus
      // fell to the body. Land on it if still offline, else on Refresh.
      pendingFocus = { selector: net?.kind === 'offline' ? '.disc-status button' : '.disc-refresh', fallback: 'h1', scroll: null, ifLost: true };
      redraw();
    }
  };

  /** @param {string} appId */
  const announceInstalled = (appId) => {
    // Tell the Library (sibling section) to re-fetch. No shared store between
    // sections, so a page-level CustomEvent is the decoupled bus.
    try { window.dispatchEvent(new CustomEvent('peerd:app-installed', { detail: { appId } })); } catch { /* no-op */ }
  };

  // why: dweb/base/install has no uri dedupe. While a share-link install of
  // the same version runs or stays unconfirmed, a heard install of it could
  // add a second copy.
  /** @param {DwebApp} app */
  const linkHolds = (app) => !!linkPending && linkPending.uri === app.uri;
  // why the mirror: dweb/base/install-address does not see a heard install
  // or update of the same version that runs or stays unconfirmed. A
  // share-link install of it could add a second copy too.
  /** @param {string} uri */
  const heardHolds = (uri) => {
    const active = [...running.values()].find(target => target.uri === uri);
    const unknown = [...unconfirmed.values()].find(target => target.uri === uri);
    return active ? { action: active.action, running: true } : unknown ? { action: unknown.action, running: false } : null;
  };
  // why: a committed share-link install is in the Library before a Library
  // read shows it. Its id stands for the heard card of that version, so that
  // card never offers a second install. Only the card its publisher signed:
  // any peer can sign a card that names this uri.
  /** @param {DwebApp} app */
  const linkedId = (app) => (linkAppId && app.uri && linkPreview?.uri === app.uri && linkPreview.publisher === app.publisher
    ? linkAppId : null);
  // why the mirror: a settled heard install or update is in the Library
  // before a Library read shows it. Its receipt stands for the share-link
  // page of that version, so that page offers Open, as its app page does.
  /** @param {string} uri @returns {string|null} */
  const heardId = (uri) => [...committed.values()].find(target => target.uri === uri)?.appId ?? apps.filter(app => app.uri === uri).map(facts)
    .find(f => f.sameVersion && f.localId)?.localId ?? null;

  /** @param {DwebApp} app */
  const install = async (app) => {
    // why the guard: install is only ever wired to cards that carry a
    // dwapp_id (it keys every record + the busy/installed maps), and an
    // in-flight or unknown install must never be sent twice. Until one
    // Library read lands, an installed app looks new, so wait for it.
    const id = app.dwapp_id;
    if (!id || !localReady || app.runtimeCompatibility?.status === 'unsupported' || unconfirmed.has(id)
        || ['installing', 'updating'].includes(busy[id]) || linkHolds(app) || linkedId(app)) return;
    busy[id] = 'installing';
    running.set(id, { action: 'install', uri: app.uri });
    delete notices[id];
    alertLine = null;
    redraw();
    try {
      // Pass the card's version identity so the installed record can later be
      // matched against newer announces ("Update ready").
      const r = await attrs.send({ type: 'dweb/base/install', uri: app.uri, name: app.name, dwappId: id, slug: app.slug, seq: app.seq, publisher: app.publisher });
      if (r?.ok) {
        busy[id] = 'installed';
        fresh.add(id);
        if (r.warning === 'audit-write-failed') notices[id] = `Installed, but ${AUDIT_FAILED}`;
        installedId[id] = r.app?.id ?? r.appId ?? null;
        if (installedId[id]) {
          committed.set(id, { appId: installedId[id], version_id: app.version_id ?? null, seq: app.seq ?? 0, read: effects.reads, uri: app.uri,
            declared: r.app?.dweb?.declared });
        }
        announceInstalled(/** @type {string} */ (installedId[id]));
        if (route.page === 'app' && route.key === id) pendingFocus = { selector: '.disc-panel .disc-installed', scroll: null, ifLost: true };
        void reloadLocal();
      } else {
        markFailure(id, 'install', app, r);
      }
    } catch { markUnknown(id, 'install', app); }
    finally { running.delete(id); }
    // why no dead guard: the custody maps outlive this mount, so a remounted
    // view must see the settled state now, not on the next poll.
    m.redraw();
  };

  // Update an installed app in place to this newer announced version. With
  // local edits the host answers 'local-changes' and a token; the resend
  // carries the user's explicit strategy, as the Library does.
  /** @param {DwebApp} app @param {string} appId @param {'fork'|'replace'} [strategy] */
  const update = async (app, appId, strategy) => {
    const id = app.dwapp_id;
    if (!id || app.runtimeCompatibility?.status === 'unsupported' || unconfirmed.has(id)
        || ['installing', 'updating'].includes(busy[id])) return;
    const conflictToken = strategy ? liveConflict(app) : undefined;
    if (strategy && conflictToken === undefined) return;
    busy[id] = 'updating';
    running.set(id, { action: 'update', uri: app.uri });
    delete notices[id];
    alertLine = null;
    redraw();
    try {
      const r = await attrs.send({
        type: 'dweb/base/update-app', appId, uri: app.uri, name: app.name, dwappId: id, slug: app.slug, seq: app.seq,
        publisher: app.publisher, ...(strategy ? { strategy, conflictToken } : {}),
      });
      if (r?.ok) {
        busy[id] = 'installed';
        conflicts.delete(id);
        // why: until a Library read that starts after this commit lands, the
        // updated version is the one installed, whatever an older read says.
        committed.set(id, { appId, version_id: app.version_id ?? null, seq: app.seq ?? 0, read: effects.reads, uri: app.uri,
          declared: r.app?.dweb?.declared });
        const warnings = new Set(Array.isArray(r.warnings) ? r.warnings : []);
        if (r.warning) warnings.add(r.warning);
        const warningMessages = [];
        // why the isolates: the fork name holds the card name a peer signed.
        // FSI and PDI keep its direction inside the quotes, and the name loses
        // its own bidi controls first, so none can close the isolate early.
        const forkName = disarmText(r.fork?.name);
        if (forkName) warningMessages.push(`Kept your changed copy as “\u2068${forkName}\u2069” and updated this app.`);
        if (warnings.has('audit-write-failed')) {
          warningMessages.push(`Updated, but ${AUDIT_FAILED}`);
        } else if (warnings.has('previous-version-cleanup-pending') && !forkName) {
          warningMessages.push('Updated.');
        }
        if (warnings.has('previous-version-cleanup-pending')) {
          warningMessages.push('Older shared bytes will be cleaned up on the next update or delete.');
        }
        if (warningMessages.length) notices[id] = warningMessages.join(' ');
        announceInstalled(appId);
        void reloadLocal();
      } else if (r?.error === 'local-changes' && Number.isSafeInteger(r.conflictToken)) {
        conflicts.set(id, { token: r.conflictToken, versionId: app.version_id ?? null });
        delete busy[id];
      } else {
        markFailure(id, 'update', app, r);
      }
    } catch { markUnknown(id, 'update', app); }
    finally { running.delete(id); }
    m.redraw();
  };

  /** @param {string|null} appId @param {string} key */
  const openApp = async (appId, key) => {
    if (!appId) return;
    alertLine = null;
    try {
      const result = await attrs.send({ type: 'apps/open', appId });
      if (result?.outcomeKnown === false) throw new Error('app-open-outcome-unknown');
      if (!result?.ok) alertLine = { key, text: 'peerd could not open this app. Try again.' };
    } catch { alertLine = { key, text: 'peerd is not sure the app opened. Check your tabs.', unknown: true }; }
    redraw();
  };

  // The manual Refresh: spin while a one-shot re-sync runs. The background
  // 4s poll stays silent (it would flicker the spinner every tick).
  const manualRefresh = async () => {
    if (refreshing) return;
    refreshing = true;
    redraw();
    await Promise.allSettled([loadLocal(), refresh(), readStatus(), loadContacts(), loadBlocked()]);
    refreshing = false;
    redraw();
  };

  /** @param {string} field @param {string} value */
  const copy = async (field, value) => {
    if (dead || copyState?.status === 'pending') return;
    const attempt = { field, value, status: /** @type {'pending'|'copied'|'failed'} */ ('pending') };
    copyState = attempt;
    if (copyTimer) clearTimeout(copyTimer);
    redraw();
    try {
      await navigator.clipboard.writeText(value);
      if (!dead && copyState === attempt) attempt.status = 'copied';
    } catch {
      if (!dead && copyState === attempt) attempt.status = 'failed';
    } finally {
      if (!dead && copyState === attempt && attempt.status === 'copied') {
        copyTimer = setTimeout(() => { if (copyState === attempt) { copyState = null; redraw(); } }, COPIED_MS);
      }
      redraw();
    }
  };
  // why match the value too: a write that started before the facts changed
  // copied the old value, so it must never label the new one as copied.
  /** @param {string} field @param {string} value @returns {ButtonProps} */
  const copyButton = (field, value) => ({
    label: copyState?.field === field && copyState.value === value && copyState.status === 'copied' ? 'Copied' : 'Copy',
    disabled: copyState?.status === 'pending',
    onclick: () => { void copy(field, value); },
  });
  const copyNote = () => copyState?.status === 'failed' && !copyState.field.startsWith(SHARE)
    ? 'Could not copy. Select the text and copy it yourself.' : null;

  const forgetPending = () => { sessionStorage.removeItem(PENDING_KEY); linkPending = null; };

  // why: a share link must pin its signer and entire app revision, and the
  // summary must echo exactly what was parsed before anything is shown.
  const inspectLink = async () => {
    if (!attrs.enabled || linkBusy) return;
    if (linkPending) { openPage({ page: 'link' }, 'paste'); return; }
    linkError = ''; linkPreview = null; linkAppId = null; linkFailure = ''; linkNotice = ''; linkFresh = false;
    let target;
    try { target = immutableAppRoot(linkInput); }
    catch (cause) { linkError = shareLinkError(/** @type {Error} */ (cause).message); return; }
    // why no send: the host refuses a blocked maker's files, so the check would only fail.
    if (blockedDids.has(target.publisher)) { linkError = BLOCKED_LINK; return; }
    const requestEpoch = ++linkEpoch;
    // why the route too: a check can take many seconds. Its page opens only
    // if the user is still where they asked; a page they opened meanwhile
    // stays, and the result is dropped.
    const from = route;
    linkBusy = 'inspect';
    redraw();
    try {
      const reply = await attrs.send({ type: 'dweb/base/inspect-address', address: target.address });
      if (dead || !attrs.enabled || requestEpoch !== linkEpoch) return;
      if (reply?.ok && reply.summary?.address === target.address
          && reply.summary?.uri === target.uri && reply.summary?.publisher === target.publisher
          && reply.summary?.hash === target.hash) {
        const catalog = await attrs.send({ type: 'apps/list' });
        if (dead || !attrs.enabled || requestEpoch !== linkEpoch || route !== from) return;
        if (!catalog?.ok || !Array.isArray(catalog.apps)) throw new Error('catalog-unavailable');
        linkPreview = reply.summary;
        linkAppId = /** @type {LibraryRecord[]} */ (catalog.apps).find(app => app.dweb?.uri === target.uri
          && app.dweb?.hash === target.hash && app.dweb?.publisher === target.publisher)?.id ?? null;
        openPage({ page: 'link' }, 'paste');
      } else {
        // why no host text: the share row has no Technical details to hold it.
        linkError = RUNTIME_CODES.includes(reply?.code) ? 'peerd could not check this app. This browser cannot run it.'
          : reply?.error === BLOCKED_ERROR ? BLOCKED_LINK
            : 'peerd could not check this app. The link may be wrong, or the people who have it may be offline. Check the link, then try again.';
      }
    } catch {
      if (requestEpoch === linkEpoch) linkError = 'peerd could not check this app. Wait until the peer network is connected, then try again.';
    } finally {
      linkBusy = '';
      // why: Check link went off while the check ran, so focus fell to the
      // body. A failure returns it to the link, where the fix is.
      if (linkError) pendingFocus = { selector: '.disc-start-form input', scroll: null, ifLost: true };
      redraw();
    }
  };

  // why: an uncertain install may commit after the renderer deadline or a
  // reload. Absence from a catalog read is not a receipt for another install.
  // Only a success or a known failure releases the receipt.
  /** @param {string} address @returns {Promise<LinkOutcome>} */
  const sendLink = async (address) => {
    try {
      const reply = await attrs.send({ type: 'dweb/base/install-address', address });
      if (reply?.ok && typeof reply.app?.id === 'string') {
        sessionStorage.removeItem(PENDING_KEY);
        announceInstalled(reply.app.id);
        return { appId: reply.app.id, notice: reply.warning === 'audit-write-failed' ? `Installed, but ${AUDIT_FAILED}` : '' };
      }
      if (reply?.ok === false && reply?.outcomeKnown !== false && reply?.performed !== true
          && !['effect-completed', 'host-lost', 'transport-lost'].includes(reply?.outcomeKind)) {
        sessionStorage.removeItem(PENDING_KEY);
        return { failure: RUNTIME_CODES.includes(reply?.code) && typeof reply.error === 'string' ? reply.error
          : reply.error === BLOCKED_ERROR ? BLOCKED : FAILED };
      }
    } catch { /* no receipt: keep the exact pending address fenced */ }
    return {};
  };
  /** @param {NonNullable<DiscoverEffects['link']>} link */
  const followLink = async (link) => {
    const { appId, notice, failure } = await link.outcome;
    if (dead) return;
    linkBusy = '';
    if (appId || failure) {
      // why keep the target: after a remount the receipt is all the page
      // knows about this app, and the page must stay to offer Open or Try again.
      if (linkPending) linkPreview ??= { ...linkPending, name: null };
      linkPending = null;
    }
    if (appId) {
      linkAppId = appId;
      linkFresh = true;
      linkNotice = notice ?? '';
      if (route.page === 'link') pendingFocus = { selector: '.disc-panel .disc-installed', scroll: null, ifLost: true };
      // why: the heard page of this app reads the Library. Read it again, so
      // that page keeps the app after the user enters another link.
      void reloadLocal();
    }
    if (failure) linkFailure = failure;
    redraw();
  };
  const installLink = async () => {
    if (!attrs.enabled || linkBusy || linkPending || !linkPreview || heardHolds(linkPreview.uri)) return;
    const target = immutableAppRoot(linkInput);
    if (target.address !== linkPreview.address) return;
    linkPending = target;
    // Persist BEFORE sending so reload keeps its UI receipt; the host owns cross-tab deduplication.
    try { sessionStorage.setItem(PENDING_KEY, target.address); }
    catch { linkPending = null; linkFailure = RECEIPT_FAILED; return; }
    linkBusy = 'install'; linkFailure = ''; linkNotice = '';
    redraw();
    // why in the effects: the page says "You can leave this page. The install
    // keeps going." A view mounted while it runs follows the same outcome.
    const link = { address: target.address, outcome: sendLink(target.address) };
    effects.link = link;
    await followLink(link);
    if (effects.link === link) effects.link = null;
  };

  const reconcileLink = async () => {
    if (!linkPending || linkBusy) return;
    const pending = linkPending;
    linkBusy = 'reconcile'; linkNotice = '';
    redraw();
    try {
      const result = await attrs.send({ type: 'apps/list' });
      const match = result?.ok && Array.isArray(result.apps) && /** @type {LibraryRecord[]} */ (result.apps).find(app =>
        app.dweb?.uri === pending.uri && app.dweb?.hash === pending.hash
        && app.dweb?.publisher === pending.publisher);
      // why keep the target: after a reload the receipt is all the page
      // knows about this app, and the page must stay to offer Open. The
      // Library read shows it on its heard page too, as after an install.
      if (match && typeof match.id === 'string') {
        linkPreview ??= { ...pending, name: null }; linkAppId = match.id; linkFresh = true; forgetPending(); void reloadLocal();
      } else linkNotice = 'peerd still cannot tell if the install finished. It may still finish by itself. Install stays off until peerd knows.';
    } catch { linkNotice = 'peerd could not read your Library. Check again in a moment.'; }
    finally { linkBusy = ''; redraw(); }
  };

  // why openApp: the share-link page says what the app page says.
  /** @param {string|null} appId */
  const openLinkApp = async (appId) => {
    if (!appId || linkBusy) return;
    linkBusy = 'open';
    redraw();
    try { await openApp(appId, 'link'); } finally { linkBusy = ''; redraw(); }
  };

  const addCommons = async () => {
    if (commonsBusy || effects.commons || !localReady || commonsId) return;
    // why in the effects, and before the first await: the fence and its
    // explanation must outlive a page change and a remount, as an install's
    // do, and loading the seed takes a moment. So the last redraw has no
    // dead guard: a remounted view must see the fence lift.
    effects.commons = 'adding'; effects.commonsAdded = null;
    commonsBusy = true; alertLine = null;
    redraw();
    let sent = false;
    try {
      const client = await loadDweb();
      if (!client.loadSeedApp) throw new Error('Commons is not in this version of peerd.');
      const commonsSeed = await client.loadSeedApp({ fetchText: async (/** @type {string} */ path) => {
        // The seed loader selects only our own packaged extension asset.
        // eslint-disable-next-line no-restricted-globals
        const response = await fetch(path);
        if (!response.ok) throw new Error('peerd could not load Commons. Reload the page, then try again.');
        return response.text();
      } });
      sent = true;
      const reply = await attrs.send({ type: 'dweb/open-commons', seed: commonsSeed });
      // why only a refusal lifts the fence here: after a success, the next
      // Library read is the receipt that lifts it (see loadLocal).
      if (reply?.outcomeKnown === false) effects.commons = 'unknown';
      else if (!reply?.ok) { effects.commons = null; alertLine = { key: 'commons', text: COMMONS_FAILED }; }
      else effects.commonsAdded = effects.reads;
      await reloadLocal();
    } catch (cause) {
      if (sent) effects.commons = 'unknown';
      else { effects.commons = null; alertLine = { key: 'commons', text: /** @type {Error} */ (cause).message }; }
    } finally { commonsBusy = false; m.redraw(); }
  };

  const openCommons = async () => {
    if (!commonsId || commonsBusy) return;
    commonsBusy = true; alertLine = null;
    try {
      const result = await attrs.send({ type: 'apps/open', appId: commonsId });
      if (result?.outcomeKnown === false) throw new Error('app-open-outcome-unknown');
      if (!result?.ok) alertLine = { key: 'commons', text: 'peerd could not open Commons. Try again.' };
    }
    catch { alertLine = { key: 'commons', text: 'peerd is not sure Commons opened. Check your tabs.', unknown: true }; }
    finally { commonsBusy = false; redraw(); }
  };

  // why in-component routes: no shell, hash or history change. Leaving the
  // root keeps its scroll and the tile that opened the page, so Back can
  // return both.
  // why not a block in flight: its outcome still lands, on whatever page is open.
  const closeMakerParts = () => { menuOpen = false; renaming = null; renameUnknown = null; if (!blockBusy) { blockFor = null; blockIssue = null; } };
  /** @param {Route} next @param {string} originKey */
  const openPage = (next, originKey) => {
    if (route.page === 'root') origin = { key: originKey, scroll: scrollHost()?.scrollTop ?? 0 };
    route = next;
    techOpen = false;
    copyState = null;
    alertLine = null;
    surpriseNote = null;
    shareFor = null;
    makerFrom = null;
    closeMakerParts();
    forgetLocalChanges();
    pendingFocus = { selector: '.disc-back', scroll: 0 };
  };
  /** @param {DwebApp} app */
  const openAppPage = (app) => {
    if (!app.dwapp_id) return;
    pageApp = app;
    openPage({ page: 'app', key: app.dwapp_id }, app.dwapp_id);
  };
  /** @param {string} did @param {string} name the page it opens from */
  const openMaker = (did, name) => {
    const from = route;
    makerLimit = EXPLORE_WINDOW;
    openPage({ page: 'maker', did }, did);
    makerFrom = { route: from, name };
    void loadContacts();
    void loadBlocked();
  };
  const goBack = () => {
    closeMakerParts();
    if (route.page === 'maker' && makerFrom) {
      route = makerFrom.route;
      makerFrom = null;
      techOpen = false;
      copyState = null;
      alertLine = null;
      // why the maker link: it opened the maker page, so Back lands there.
      pendingFocus = { selector: '.disc-app-maker', fallback: 'h1', scroll: null };
      return;
    }
    if (route.page === 'link' && !linkPending) shareOpen = false;
    const key = origin?.key ?? null;
    route = { page: 'root' };
    techOpen = false;
    copyState = null;
    alertLine = null;
    surpriseNote = null;
    shareFor = null;
    // why the heading as fallback: the tile may be gone (filtered, past the
    // window, or no longer heard). The heading lands focus at the top of the
    // root, as home.js does for a view change.
    pendingFocus = {
      selector: key === 'paste' ? (shareOpen ? '.disc-start-form button' : '[data-paste-link]')
        : key ? `[data-key="${CSS.escape(key)}"] .disc-tile-open` : null,
      fallback: 'h1',
      scroll: origin?.scroll ?? 0,
    };
    origin = null;
  };
  const openShare = () => { shareOpen = true; pendingFocus = { selector: '.disc-start-form input', scroll: null }; };
  // why the focus moves: the dialog is modal, so focus goes in, and Close,
  // Escape or a click outside returns it to the Share button.
  /** @param {string} key */
  const openShareDialog = (key) => { shareFor = key; pendingFocus = { selector: '[data-share-copy]', scroll: null }; };
  const closeShareDialog = () => { shareFor = null; pendingFocus = { selector: '[data-share-open]', scroll: null }; };
  // why the epoch: a check still running must not open its page after the
  // row closed. The typed link stays for the next open, as after Back.
  const closeShare = () => {
    linkEpoch++; shareOpen = false; linkError = '';
    pendingFocus = { selector: '[data-paste-link]', scroll: null };
  };

  // The maker menu. Escape, Cancel and a finished name return focus to its
  // button, as the Library's menu does.
  const MENU_BUTTON = '[data-maker-menu]';
  /** @param {boolean} refocus */
  const closeMenu = (refocus) => {
    if (!menuOpen) return;
    menuOpen = false;
    if (refocus) pendingFocus = { selector: MENU_BUTTON, scroll: null };
  };
  /** @param {string} did */
  const startRename = (did) => {
    menuOpen = false;
    renaming = { did, value: contactNames.get(did) ?? '', busy: false, failed: false };
    renameUnknown = null;
    pendingFocus = { selector: '.disc-rename input', scroll: null };
  };
  const cancelRename = () => { renaming = null; pendingFocus = { selector: MENU_BUTTON, scroll: null }; };
  // why one write and then a read, never a replay: a lost reply may have saved it.
  /** @param {string} did */
  const saveName = async (did) => {
    const form = renaming;
    const name = form?.value.trim() ?? '';
    if (!form || form.did !== did || form.busy || !name) return;
    form.busy = true; form.failed = false;
    redraw();
    /** @type {'done'|'failed'|'unknown'} */ let outcome = 'unknown';
    /** @type {string|null} */ let kept = null;
    try {
      const reply = await attrs.send({ type: 'contacts/set', did, name });
      outcome = effectOutcome(reply);
      kept = typeof reply?.contact?.name === 'string' ? reply.contact.name : null;
    } catch { /* unknown */ }
    if (dead || renaming !== form) return;
    form.busy = false;
    if (outcome === 'failed') {
      form.failed = true;
      // why Save: the line says to try again, as Block does in its confirm.
      pendingFocus = { selector: '.disc-rename button[type="submit"]', scroll: null, ifLost: true };
    } else {
      renaming = null;
      // why the reply's name, else the store's form of it: a read shows the name as the store saved it.
      if (outcome === 'done') { contactsChanged = contactReads; contactNames = new Map(contactNames).set(did, kept ?? savedNameForm(name)); }
      else { renameUnknown = { did, name: savedNameForm(name) }; void loadContacts(); }
      pendingFocus = { selector: MENU_BUTTON, scroll: null, ifLost: true };
    }
    redraw();
  };

  // The block confirm. It opens on Cancel, and Escape or Cancel returns focus
  // to the menu button. A block is one write; Check again only reads.
  /** @param {string} did */
  const askBlock = (did) => {
    menuOpen = false; renaming = null; blockFor = did; blockIssue = null;
    pendingFocus = { selector: '[data-block-cancel]', scroll: null };
  };
  const cancelBlock = () => {
    if (blockBusy) return;
    blockFor = null; blockIssue = null;
    pendingFocus = { selector: MENU_BUTTON, scroll: null };
  };
  /** @param {string} did @param {'done'|'failed'|'unknown'} outcome */
  const settleBlock = (did, outcome) => {
    if (outcome === 'done') {
      blockedChanged = blockedReads;
      applyBlocked(new Set([...blockedDids, did]));
      blockFor = null; blockIssue = null;
      // why: Back would return to an app of theirs, and their apps left Discover.
      if (route.page === 'maker' && route.did === did) makerFrom = null;
      pendingFocus = { selector: '.disc-blocked', scroll: null };
    } else {
      blockIssue = outcome;
      // why no ifLost: while it ran, focus could only rest on the dialog.
      pendingFocus = { selector: outcome === 'unknown' ? '[data-block-check]' : '[data-block-confirm]', scroll: null };
    }
  };
  // why the dialog takes focus: every control in it goes off while a block or
  // a check runs, and focus must not fall to the page behind the modal.
  const holdBlockFocus = () => { pendingFocus = { selector: '.disc-block', scroll: null }; };
  /** @param {string} did */
  const blockMaker = async (did) => {
    if (blockBusy || blockFor !== did) return;
    blockBusy = true; blockIssue = null;
    holdBlockFocus();
    redraw();
    /** @type {'done'|'failed'|'unknown'} */ let outcome = 'unknown';
    try { outcome = effectOutcome(await attrs.send({ type: 'dweb/peer-block', did })); } catch { /* unknown */ }
    blockBusy = false;
    if (dead) return;
    settleBlock(did, outcome);
    redraw();
  };
  // why a read that starts after the block reply: the stored list is the
  // receipt. It names the maker, or the block did not happen.
  /** @param {string} did */
  const checkBlock = async (did) => {
    if (blockBusy || blockFor !== did) return;
    blockBusy = true;
    holdBlockFocus();
    redraw();
    await blockedInFlight;
    const read = await loadBlocked();
    blockBusy = false;
    if (dead) return;
    if (read) settleBlock(did, blockedDids.has(did) ? 'done' : 'failed');
    else pendingFocus = { selector: '[data-block-check]', scroll: null };
    redraw();
  };
  // why: Show more goes away after the last batch, and the new tiles start
  // where it stood.
  /** @param {DwebApp} app */
  const focusTile = (app) => { pendingFocus = { selector: `[data-key="${CSS.escape(app.dwapp_id ?? '')}"] .disc-tile-open`, scroll: null }; };
  // A "New app to install" notification names its dwapp_id. The click is an
  // explicit request, so an app already in the heard list opens from any
  // page, a restored share-link page too. The bell can be clicked before the
  // next poll hears that card: then the first heard read that starts after
  // the click answers it, success or failure. It opens the page only if it
  // hears the app and the user is still where the click left them. A failed
  // read or any navigation drops the request, so a card heard later never
  // swaps a page under the user. Answered once, then cleared.
  /** @param {{key:string, epoch:number, route:Route, answered:boolean}} ask @param {DwebApp|null|undefined} target */
  const settleKey = (ask, target) => {
    ask.answered = true;
    if (target && route === ask.route) openAppPage(target);
    attrs.onOpenKey?.();
  };
  /** @param {string|null|undefined} key */
  const answerKey = (key) => {
    if (!attrs.enabled || !key) { keyAsk = null; return; }
    if (keyAsk?.key === key) {
      if (!keyAsk.answered && route !== keyAsk.route) settleKey(keyAsk, null);
      return;
    }
    const ask = { key, epoch: refreshEpoch, route, answered: false };
    keyAsk = ask;
    const heard = apps.find(app => app.dwapp_id === key);
    if (heard) { settleKey(ask, heard); return; }
    // why after the read in flight: it started before the request.
    void (refreshInFlight ?? Promise.resolve()).then(() => { if (!dead && attrs.enabled && keyAsk === ask) void refresh(); });
  };
  /** @param {boolean} included */
  const rootOf = (included) => rootView({
    enabled: attrs.enabled, net, heardCount: apps.length, loading, failed: heardFailed, included,
  });
  // why the pill focus: Comes with peerd can swap the looking or empty root
  // for the grid and back. Focus follows to the pressed pill, or, on a root
  // with no pills, to the link that shows those apps again.
  const pillFocus = '.disc-pill[aria-pressed="true"], [data-included]';
  /** @param {Pill} next */
  const selectPill = (next) => {
    if (rootOf(pill === 'included') !== rootOf(next === 'included')) pendingFocus = { selector: pillFocus, fallback: 'h1', scroll: null };
    pill = next; limit = EXPLORE_WINDOW; orderedIds = []; surpriseNote = null;
  };
  /** @param {string} value */
  const setQuery = (value) => { query = value; limit = EXPLORE_WINDOW; orderedIds = []; surpriseNote = null; };
  const clearFilters = () => {
    query = ''; pill = 'all'; limit = EXPLORE_WINDOW; orderedIds = []; surpriseNote = null;
    pendingFocus = { selector: '.disc-search', fallback: 'h1', scroll: null };
  };

  /** @param {DwebApp} app */
  const facts = (app) => {
    const id = app.dwapp_id ?? '';
    const tracked = committed.get(id) ?? installedByDwappId.get(id);
    const linked = linkedId(app);
    // why the publisher in the uri: any peer can sign a card that names
    // another maker's uri. Only a card under its own publisher stands for the
    // Library record at that uri, as the share-link page borrows a name only
    // from the card its publisher signed.
    const byUri = app.uri && app.publisher && app.uri.startsWith(`peerd://${app.publisher}/`) ? installedByUri.get(app.uri) ?? null : null;
    const localId = installedId[id] || byUri || tracked?.appId || linked || null;
    // why: until the Library shows the app, a share-link install of it decides
    // its state here too: running, or unconfirmed with Check again.
    const held = !localId && linkHolds(app);
    return {
      id, localId,
      // why: the Library can hold another version of this app. Only this
      // version may be called "this version" or flagged as unable to run.
      // The catalog's version decides, as it does for an update offer.
      sameVersion: tracked ? !!app.version_id && tracked.version_id === app.version_id
        : !!installedId[id] || !!byUri || !!linked,
      updatable: !!tracked && !!app.version_id
        && app.version_id !== tracked.version_id && (app.seq ?? 0) > (tracked.seq ?? 0),
      uncertain: unconfirmed.has(id) || (held && linkBusy !== 'install'),
      incompatible: app.runtimeCompatibility?.status === 'unsupported',
      mine: !!myDid && (app.publisher === myDid || app.from === myDid),
      state: held ? (linkBusy === 'install' ? 'installing' : UNKNOWN) : busy[id],
    };
  };
  // why bound to the version: the token answers one update offer, as in the
  // Library. Once the Library holds that version, or peers announce another
  // one, the offer is gone and so is its token.
  /** @param {DwebApp} app @returns {number|undefined} */
  const liveConflict = (app) => {
    const entry = conflicts.get(app.dwapp_id ?? '');
    return entry && entry.versionId === (app.version_id ?? null) && facts(app).updatable ? entry.token : undefined;
  };
  const pruneConflicts = () => {
    for (const id of conflicts.keys()) {
      const app = apps.find(a => a.dwapp_id === id);
      if (!app || liveConflict(app) === undefined) conflicts.delete(id);
    }
  };
  // why: a pending mutation must remain visible until its receipt resolves,
  // even if polling already finds it in the Library. Unknown is not absent.
  /** @param {DwebApp} app */
  const pending = (app) => {
    const id = app.dwapp_id;
    return !!id && (unconfirmed.has(id) || !!notices[id] || liveConflict(app) !== undefined
      || ['installing', 'updating'].includes(busy[id]));
  };
  // why the commit first: until a Library read that starts after an install
  // or update lands, its reply is the record of the version installed.
  /** @param {DwebApp} app @param {string} localId */
  const installedDeclared = (app, localId) => {
    const commit = committed.get(app.dwapp_id ?? '');
    return verifiedDeclared(commit?.appId === localId ? commit.declared
      : records.find(record => record.id === localId)?.dweb?.declared, app.version_id);
  };
  /** @param {string|undefined} did */
  const makerOf = (did) => typeof did === 'string' ? { name: contactNames.get(did) ?? null, key: shortKey(did) } : null;
  /** @param {DwebApp} app */
  const nameOf = (app) => app.name || (app.dwapp_id ?? '').slice(0, 12);

  /**
   * `row`: a row on the maker page, which already names the maker.
   * @param {DwebApp} app @param {boolean} offline @param {boolean} [row]
   */
  const appTileProps = (app, offline, row = false) => {
    const f = facts(app);
    const action = offline ? /** @type {const} */ ({ kind: 'open' }) : tileAction({
      incompatible: f.incompatible, busy: f.state, uncertain: f.uncertain,
      installed: !!f.localId, sameVersion: f.sameVersion, updatable: f.updatable, mine: f.mine,
    });
    const name = nameOf(app);
    // why the offline grid too: it lists only what the Library holds.
    const where = offline || f.localId
      ? `In your Library${action.kind === 'update' ? ' · new version ready' : ''}` : null;
    return {
      key: f.id, name, letter: letterOf(name), tone: toneOf(f.id),
      meta: where ?? (row ? kbLabel(app.size) : makerMeta(makerOf(app.publisher), kbLabel(app.size))),
      description: app.description,
      error: rootAlert(f.id, true),
      // why keyed by kind: a poll can turn a focused Open into Update, or
      // "Look at it" into Open. A new node drops the focus, so one key press
      // never runs an action the user did not choose.
      action: keyedParts({ [action.kind]: actionView(action, {
        onOpen: () => { void openApp(f.localId, f.id); },
        onReview: () => openAppPage(app),
        onUpdate: () => { openAppPage(app); if (f.localId) void update(app, f.localId); },
      }) }),
      onOpen: () => openAppPage(app),
    };
  };

  // why the Library's apps of a blocked maker too: they stay in the Library
  // (and in Your apps), but leave Discover with the rest of their apps.
  const offlineApps = () => withoutBlocked(libraryPeerApps(records, heardCache), blockedDids);

  /** @param {DwebApp[]} list @param {boolean} offline */
  const ordered = (list, offline) => {
    const candidates = pillFilter(list, pill, {
      updatable: app => {
        const f = facts(app);
        return !offline && updateOffer({ installed: !!f.localId, updatable: f.updatable, mine: f.mine, incompatible: f.incompatible }) === 'update';
      },
      pending, contacts: contactNames,
    });
    const balanced = exploreOrder(candidates, { query, seed, names: contactNames });
    const byId = new Map(balanced.map(app => [app.dwapp_id, app]));
    const ids = orderedIds.filter(id => byId.has(id));
    const known = new Set(ids);
    for (const app of balanced) if (app.dwapp_id && !known.has(app.dwapp_id)) ids.push(app.dwapp_id);
    // why online only: the offline grid holds only Library apps. Kept, its
    // order would move them ahead of the rest when the network returns.
    if (!offline) orderedIds = ids;
    return ids.map(id => /** @type {DwebApp} */ (byId.get(id)));
  };

  // Surprise me only picks from what is already on screen. It never fetches
  // or installs: it opens the chosen app's page.
  /** @param {DwebApp[]} list */
  const surpriseCandidates = (list) => list.filter(app => {
    const id = app.dwapp_id;
    return !!id && !facts(app).localId && !busy[id] && !unconfirmed.has(id);
  });
  /** @param {DwebApp[]} shown the apps the grid lists under the pill and search */
  const surprise = (shown) => {
    if (!localReady || localFailed) return;
    const candidates = surpriseCandidates(shown);
    const now = Date.now();
    let chosen = nextSuggestion(candidates, suggested, lastPublisher, now);
    // why clear and pick again: the history only prevents repeats within one
    // pass; once every candidate was shown, the next pass starts fresh.
    if (!chosen && suggested.size) {
      suggested.clear();
      lastPublisher = null;
      chosen = nextSuggestion(candidates, suggested, lastPublisher, now);
    }
    // why a line, not silence: the button stays on, as drawn, so a click
    // that finds nothing must still say why no page opened.
    if (!chosen) {
      surpriseNote = noSuggestionNote({
        recentMisses: candidates.some(app => recentRetrievalMiss(app, now)),
        filtered: pill !== 'all' || !!query.trim(), allInLibrary: shown.length > 0 && shown.every(app => !!facts(app).localId),
      });
      return;
    }
    suggested.add(suggestionKey(chosen));
    lastPublisher = chosen.publisher ?? null;
    openAppPage(chosen);
  };

  /** `link`: drawn as a link next to a button. @param {boolean} [link] */
  const tryStarter = (link = false) => {
    if (!FEATURED) return null;
    const props = { label: `Try ${FEATURED.name}`, onclick: () => openOptions(`transfer?starter=${FEATURED_STARTER}`) };
    return link ? m('button.linklike.disc-link-btn', { type: 'button', onclick: props.onclick }, props.label) : secondaryButton(props);
  };
  // why: the looking and empty roots draw no pills, but the apps that come
  // with peerd need no peer, and only Discover adds Commons.
  const includedLink = () => m('button.linklike.disc-link-btn', {
    type: 'button', 'data-included': '', onclick: () => selectPill('included'),
  }, 'See what comes with peerd');
  const toLibrary = () => attrs.onLibrary?.();
  const libraryButton = () => secondaryButton({ label: 'Go to Library', onclick: toLibrary });
  /** @param {() => void} onclick */
  const showMore = (onclick) => secondaryButton({ label: 'Show more', onclick, attrs: { class: 'disc-more' } });
  /** @param {boolean} inStatus */
  const pasteButton = (inStatus) => inStatus
    ? m('button.secondary', { type: 'button', 'data-paste-link': '', onclick: openShare }, 'Paste link')
    : secondaryButton({ label: 'Paste link', onclick: openShare, attrs: { 'data-paste-link': '' } });
  const openShareRow = () => shareRow({
    value: linkInput,
    inputDisabled: !!linkPending || linkBusy === 'receipt',
    checkDisabled: !attrs.enabled || !!linkBusy || (!linkPending && !linkInput),
    status: linkPending ? (linkBusy === 'install' ? KEEPS_GOING : RECEIPT_HELD) : linkBusy === 'inspect' ? CHECKING_LINK : null,
    note: attrs.enabled ? null : 'Turn on the peer network first.',
    error: linkError,
    onCancel: linkPending || linkBusy === 'receipt' ? null : closeShare,
    oninput: (value) => {
      linkInput = value; linkEpoch++; linkPreview = null; linkAppId = null;
      linkError = ''; linkFailure = ''; linkNotice = ''; linkFresh = false;
    },
    onCheck: () => { void inspectLink(); },
  });
  const heardError = () => heardFailed
    ? m('p.error', { role: 'alert', 'aria-live': 'assertive' }, 'peerd could not check for new apps. Try again in a moment.')
    : null;
  /** @param {string} [key] @param {boolean} [small] */
  const rootAlert = (key, small = false) => alertLine && (!key || alertLine.key === key)
    ? m(small ? 'p.type-small' : 'p', { class: alertLine.unknown ? 'type-body-sm' : 'error', role: alertLine.unknown ? 'status' : 'alert' }, alertLine.text) : null;
  // why not a Your apps line: that row shows its own, next to its Open.
  const strayAlert = () => alertLine?.key.startsWith(YOURS) ? null : rootAlert();
  /** @param {boolean} offline */
  const libraryLine = (offline) => {
    const note = libraryStatus({ ready: localReady, failed: localFailed, offline });
    return note ? m('p.type-small.disc-footnote', { role: 'status' }, note) : null;
  };
  // why the network-on roots only: with the network off Discover sends
  // nothing, so it has no Library read to show.
  const yoursRow = () => {
    const { apps: mine, total } = yourApps(records, YOURS_MAX);
    return mine.length ? yourAppsRow({
      apps: mine.map(app => ({
        id: app.id, name: app.name, letter: letterOf(app.name), tone: toneOf(app.toneKey),
        onOpen: () => { void openApp(app.id, `${YOURS}${app.id}`); }, error: rootAlert(`${YOURS}${app.id}`, true),
      })),
      onMore: total > mine.length ? toLibrary : null,
    }) : null;
  };

  const startView = () => m('.disc-home.disc-view.disc-start-view', { key: 'start' }, [
    m('header.disc-intro', [
      m('h1.type-hero', 'Discover'),
      m('p.type-body', 'Small apps that people share with each other. They run in your browser, and nothing installs until you choose.'),
    ]),
    m('ul.disc-start-list', [
      // why these words: Try opens a Settings page that adds the app, and it
      // opens from the Library. Discover cannot tell when it is there.
      FEATURED ? startRow({
        icon: 'cube', title: 'Try an app that comes with peerd',
        text: `Add ${FEATURED.name} to your Library, then open it from there. It needs no network and no setup.`, action: tryStarter(),
      }) : null,
      startRow({
        icon: 'globe', title: 'See apps other people share',
        text: 'Turn on the peer network to connect straight to other people who use peerd. There is no central store.',
        note: 'It uses some internet and storage, and other people can see your network address. Your files, chats and keys stay private.',
        action: secondaryButton({
          label: 'Turn on', onclick: enableNetwork, disabled: choiceBusy || !!choiceError,
          attrs: { 'data-network-choice': 'enable', 'aria-label': 'Turn on the peer network' },
        }),
        extra: choiceError ? [
          m('p.error', { role: 'alert' }, choiceError),
          secondaryButton({ label: choiceRefreshing ? 'Checking…' : 'Check again', onclick: () => { void refreshChoice(); }, disabled: choiceRefreshing }),
        ] : null,
      }),
      shareOpen ? openShareRow() : startRow({
        icon: 'ext', title: 'Open an app a friend sent you',
        text: 'Paste the link they shared. You can look at the app before you install it. This needs the peer network.',
        action: pasteButton(false),
      }),
    ]),
    noteBox({ icon: 'lock', text: 'Apps run in their own tab and cannot reach the internet by themselves. You can remove an app from your Library at any time.' }),
  ]);

  // why one key for every root while the network is on: a poll can swap the
  // looking, empty, grid and offline roots under the user. Each named part
  // keeps its DOM node across the swap, so focus and typed text in the status
  // row, the share row and the search stay put.
  /** @param {Record<string, unknown>} parts */
  const rootFrame = (parts) => m('.disc-home.disc-view', { key: 'root' }, keyedParts(parts));
  const shareList = () => shareOpen ? m('ul.disc-start-list', openShareRow()) : null;

  // why the status row when connected: a failed heard read keeps this root
  // with peers linked, and "Looking for people…" would then be false. The
  // share row sits under the head, as on the other roots, so it never jumps.
  // why Paste link here only without the status row: that row has its own.
  // why the looking line titles the waiting block: its text goes on from it.
  const lookingView = () => {
    const connected = net?.kind === 'connected';
    return rootFrame({
      title: m('h1.type-page-title', 'Discover'),
      status: connected ? statusFor('connected', []) : null,
      heardError: heardError(),
      share: shareList(),
      yours: yoursRow(),
      waiting: emptyState({
        title: connected ? undefined : LOOKING, waiting: !connected,
        text: 'This can take a minute. While you wait, try an app that comes with peerd.',
        actions: [tryStarter(), shareOpen || connected ? null : pasteButton(false), includedLink()],
      }),
    });
  };

  /** @param {'connected'|'offline'} kind @param {DwebApp[]} shown */
  const statusFor = (kind, shown) => {
    if (kind === 'offline') {
      return statusRow({ text: 'Peer network is offline', count: null, buttons: {
        retry: m('button.secondary', { type: 'button', disabled: retrying, onclick: () => { void retryConnection(); } }, retrying ? 'Connecting…' : 'Try again'),
      } });
    }
    return statusRow({
      text: net?.kind === 'connected' ? peerCountLabel(net.linked) : LOOKING,
      count: apps.length ? appCountLabel(apps.length) : null,
      buttons: {
        paste: shareOpen ? null : pasteButton(true),
        surprise: apps.length ? m('button.secondary', {
          type: 'button', disabled: !localReady || localFailed, onclick: () => surprise(shown),
        }, 'Surprise me') : null,
        refresh: refreshButton({ spinning: refreshing, onclick: () => { void manualRefresh(); } }),
      },
    });
  };

  const emptyView = () => rootFrame({
    title: m('h1.type-page-title', 'Discover'),
    status: statusFor('connected', []),
    alert: strayAlert(),
    share: shareList(),
    yours: yoursRow(),
    none: emptyState({
      title: 'No shared apps yet',
      text: 'Apps show up here when the people you are connected to share them. You can share one of yours from your Library.',
      actions: [libraryButton(), tryStarter(true), includedLink()],
    }),
  });

  const includedTiles = () => {
    const starters = starterKeys.flatMap(key => {
      const starter = packagedStarter(key);
      return starter ? [{ key: `starter:${key}`, tone: key, name: starter.name, description: starter.description,
        action: tileButton({ label: 'Try it', ariaLabel: `Try ${starter.name}`, onclick: () => openOptions(`transfer?starter=${key}`) }) }] : [];
    });
    const commons = {
      key: 'commons', tone: 'commons', name: COMMONS_NAME,
      description: 'Chat with other people who use peerd. Adding it does not join a room. You choose one inside the app.',
      // why keyed: a Commons deleted elsewhere must not turn a focused Open into an add.
      action: keyedParts(commonsId
        ? { open: tileButton({ label: 'Open', open: true, disabled: commonsBusy, onclick: () => { void openCommons(); } }) }
        : { add: tileButton({
          label: commonsBusy || effects.commons === 'adding' ? 'Opening…' : 'Add and open Commons',
          disabled: commonsBusy || !!effects.commons || !localReady, onclick: () => { void addCommons(); },
        }) }),
    };
    return matchQuery([...starters, commons], query).map(item => tile({
      key: item.key, name: item.name, letter: letterOf(item.name), tone: toneOf(item.tone),
      meta: 'Comes with peerd', description: item.description, action: item.action,
      error: rootAlert(item.key, true),
    }));
  };

  /** @param {boolean} offline */
  const gridView = (offline) => {
    const list = offline ? offlineApps() : apps;
    const shownApps = pill === 'included' ? [] : ordered(list, offline);
    const tiles = pill === 'included' ? includedTiles()
      : shownApps.slice(0, limit).map(app => tile(appTileProps(app, offline)));
    const browse = !offline || list.length > 0 || pill !== 'all' || !!query;
    return rootFrame({
      title: m('h1.type-page-title', 'Discover'),
      status: statusFor(offline ? 'offline' : 'connected', shownApps),
      heardError: offline ? null : heardError(),
      library: libraryLine(offline),
      suggestion: surpriseNote ? m('p.type-small.disc-footnote', { role: 'status', 'aria-live': 'polite' }, surpriseNote) : null,
      // why neutral: the add may still finish, as an unknown install may.
      commons: pill === 'included' && effects.commons === 'unknown' && !commonsId
        ? m('p.type-body-sm', { role: 'status' }, COMMONS_UNKNOWN) : null,
      share: shareList(),
      // why not offline with Library apps from peers: the grid then lists them, each with Open.
      yours: offline && list.length ? null : yoursRow(),
      search: browse ? searchInput({ value: query, oninput: setQuery }) : null,
      pills: pills({ value: pill, onSelect: selectPill }),
      // why after a good read only: the line says what the Library holds.
      // Until then the Library line says it is checking or could not read it.
      offlineEmpty: browse || !localReady ? null : emptyState({ text: OFFLINE_EMPTY, actions: [] }),
      tiles: browse && tiles.length ? m('.disc-grid', tiles) : null,
      noMatch: browse && !tiles.length ? emptyState({
        title: 'No matching apps', text: 'Change your search or filters.', boxed: true, status: true,
        actions: [secondaryButton({ label: 'Clear filters', onclick: clearFilters })],
      }) : null,
      more: pill !== 'included' && shownApps.length > limit
        ? showMore(() => { focusTile(shownApps[limit]); limit += EXPLORE_WINDOW; }) : null,
    });
  };

  /** @param {Fact[]} list @param {string|null} [footnote] */
  const techView = (list, footnote = null) => techDetails({
    id: TECH_ID, open: techOpen, onToggle: () => { techOpen = !techOpen; }, facts: list, footnote, note: copyNote(),
  });

  /** `runtime`: the reason a runtime refusal gave, which outranks the card's claim.
   * @param {DwebApp} app @param {string|null} runtime */
  const appFacts = (app, runtime) => {
    const id = app.dwapp_id ?? '';
    const address = discoveryAddress(app);
    const bytes = bytesLabel(app.size);
    /** @type {Fact[]} */ const list = [];
    if (app.publisher) list.push({ label: 'Made by', value: app.publisher, code: true, copy: copyButton(`${id}:did`, app.publisher) });
    if (typeof app.version_id === 'string') list.push({ label: 'Version', value: app.version_id, code: true });
    if (address) list.push({ label: 'Share link', value: address, code: true, copy: copyButton(`${id}:link`, address) });
    if (bytes) list.push({ label: 'Size', value: bytes });
    list.push({ label: 'WebAssembly', value: wasmLabel(app.includes_wasm) });
    list.push({ label: 'Runtime', value: runtime ?? app.runtimeCompatibility?.message ?? 'Runtime requirements not specified.' });
    return list;
  };

  // why the copy guard: "Link copied." names only the link on screen. A copy
  // that started before the link changed copied the old one.
  /** @param {string} key @param {{name:string, letter:string, tone:string, address:string, maker:{name:string|null, key:string}|null}} props */
  const shareView = (key, props) => {
    const field = `${SHARE}${key}`;
    const mine = copyState?.field === field ? copyState : null;
    return shareDialog({
      ...props,
      status: mine?.status === 'copied' && mine.value === props.address ? 'copied' : mine?.status === 'failed' ? 'failed' : null,
      copyDisabled: copyState?.status === 'pending',
      onCopy: () => { void copy(field, props.address); },
      onClose: closeShareDialog,
    });
  };

  /** @param {string} key */
  const appPage = (key) => {
    // why the Library first while offline: the offline root shows only what
    // the Library holds, and a card heard before may name a newer version.
    const sources = net?.kind === 'offline' ? [offlineApps(), apps] : [apps, offlineApps()];
    // why the page it opened with too: a blocked maker's apps leave Discover, an open page with them.
    const app = sources.flat().find(a => a.dwapp_id === key)
      ?? (pageApp?.dwapp_id === key ? withoutBlocked([pageApp], blockedDids)[0] : null);
    if (!app) { route = { page: 'root' }; return null; }
    const f = facts(app);
    const state = pageState({
      incompatible: f.incompatible, conflict: liveConflict(app) !== undefined, busy: f.state, uncertain: f.uncertain,
      installed: !!f.localId, sameVersion: f.sameVersion,
    });
    const name = nameOf(app);
    const effectBusy = ['installing', 'updating'].includes(f.state ?? '') || f.uncertain;
    const localId = f.localId;
    // why its own panel: the steps and the installed line would claim the
    // new version, which the user does not have yet.
    const offer = state === 'installed' && localId
      ? updateOffer({ installed: true, updatable: f.updatable, mine: f.mine, incompatible: f.incompatible }) : null;
    // why: an install needs the peer network, so it waits, and the line says so.
    const offline = net?.kind === 'offline';
    // why the Library decides the word: Try again updates when it holds another version.
    const action = f.localId ? 'update' : 'install';
    const failure = state === 'failed' && isFailure(f.state) ? failureHint(/** @type {string} */ (f.state), action) : null;
    // why no Try again for a blocked maker: only an unblock in Contacts helps,
    // and the hint says so.
    const blockedMaker = state === 'failed' && f.state === BLOCKED;
    /** @type {ButtonProps|null} */ let primary = null;
    if (state === 'review') {
      primary = { label: 'Install and share', disabled: !app.uri || !localReady || offline, onclick: () => { void install(app); } };
    }
    if (state === 'installed') primary = { label: 'Open', disabled: !localId, onclick: () => { void openApp(localId, f.id); } };
    if (state === 'failed' && !blockedMaker) {
      primary = { label: 'Try again', disabled: offline, onclick: () => { void (f.localId ? update(app, f.localId) : install(app)); } };
    }
    if (state === 'unknown') primary = { label: 'Check again', disabled: refreshing, onclick: () => { void manualRefresh(); } };
    // why Open next to them on an update page: the installed version still runs.
    /** @type {ButtonProps|null} */ const open = localId ? { label: 'Open', onclick: () => { void openApp(localId, f.id); } } : null;
    const secondary = (state === 'failed' || state === 'unknown') && primary ? open : null;
    if (blockedMaker && open) primary = open;
    const notice = notices[f.id] ?? (state === 'review' && !localReady ? libraryStatus({ ready: false, failed: localFailed })
      : offline && (state === 'review' || state === 'failed') ? NEEDS_NETWORK : null);
    const error = rootAlert(f.id);
    // why checked only for the version the Library holds: peerd checked
    // every file of it when it installed it. A card heard from peers is only
    // what they said, so it never fills The app says it, whatever it claims.
    // An app the user made here has no facts recorded, so it gets no section.
    // why the service worker's word on the copy: an edit on this device keeps
    // the version, so only the files can say it is still the one peerd checked.
    const checked = f.localId && f.sameVersion ? 'installed' : null;
    const changed = checked && f.localId && !f.mine ? localChangesOf(f.localId, app.version_id) : null;
    const panel = state === 'cant-run' ? cantRunPanel()
      : state === 'conflict' ? conflictPanel({
        disabled: effectBusy || !f.localId,
        onFork: () => { if (f.localId) void update(app, f.localId, 'fork'); },
        onReplace: () => { if (f.localId) void update(app, f.localId, 'replace'); },
        onCancel: () => { conflicts.delete(f.id); goBack(); },
      })
        : offer && localId ? updatePanel({
          update: offer === 'update' ? { label: 'Update', onclick: () => { void update(app, localId); } } : null,
          open: { label: 'Open', onclick: () => { void openApp(localId, f.id); } }, notice, error,
        })
          : installPanel({
            state, name, fresh: fresh.has(f.id), changed: changed === true,
            message: state === 'installing' ? `You can leave this page. The ${f.state === 'updating' ? 'update' : 'install'} keeps going.` : null,
            failure: failure ? { action, hint: failure.hint } : null,
            unknown: state === 'unknown' ? unknownLines(unconfirmed.get(f.id)?.action ?? 'install') : null,
            notice, error, primary, secondary, otherVersion: !f.sameVersion,
            sharing: state === 'review' ? SHARING : null, onLibrary: toLibrary,
          });
    const address = discoveryAddress(app);
    if (shareFor === f.id && !address) shareFor = null;
    const maker = makerOf(app.publisher);
    const tone = toneOf(f.id);
    const says = saysIt({ declared: checked && f.localId ? installedDeclared(app, f.localId) : null, checked, action, changed });
    return m('.disc-home.disc-view.disc-page', { key: `app:${key}` }, [
      backLink({ onclick: goBack }),
      appHead({
        name, letter: letterOf(name), tone, maker,
        onMaker: () => { if (app.publisher) openMaker(app.publisher, name); },
        meta: f.localId ? 'In your Library' : kbLabel(app.size), modified: state === 'conflict' || changed === true,
        description: app.description, onShare: address ? () => openShareDialog(f.id) : null,
      }),
      panel,
      state === 'cant-run' || state === 'conflict' || offer === 'update-cant-run' ? null
        : [safetyLines({ maker, checked, action, mine: f.mine, changed: changed === true }),
          says ? saysItSection(says) : null],
      techView(appFacts(app, failure?.runtime ?? null), typeof app.includes_wasm === 'boolean' ? WASM_HINT : null),
      shareFor === f.id && address ? shareView(f.id, { name, letter: letterOf(name), tone, address, maker }) : null,
    ]);
  };

  const linkPage = () => {
    const target = linkPreview ?? linkPending;
    if (!target) { route = { page: 'root' }; return null; }
    // why the full address: any peer can sign a card that names this uri.
    // Borrow a name only from the card its own publisher signed.
    const card = apps.find(app => discoveryAddress(app) === target.address);
    const name = linkPreview?.name ?? card?.name ?? 'Unnamed app';
    // why: a heard install or update of this version decides this page until
    // it settles: running, or unconfirmed with Check again, as on its app page.
    const held = heardHolds(target.uri);
    const installing = (!!linkPending && linkBusy === 'install') || held?.running === true;
    const localId = linkAppId ?? installedByUri.get(target.uri) ?? heardId(target.uri);
    // A share link names one exact version, so an installed one is this version.
    const state = pageState({
      incompatible: linkPreview?.runtimeCompatibility?.status === 'unsupported', conflict: false,
      busy: installing ? 'installing' : linkFailure || undefined,
      uncertain: !installing && (!!linkPending || !!held), installed: !!localId, sameVersion: true,
    });
    const failure = state === 'failed' && linkFailure ? (linkFailure === RECEIPT_FAILED
      ? { hint: 'Reload the page, then try again.', runtime: null } : failureHint(linkFailure)) : null;
    const blocked = !attrs.enabled || !!linkBusy;
    // why no Try again for a blocked maker: only an unblock in Contacts helps, and the hint says so.
    /** @type {ButtonProps|null} */ const primary = state === 'review'
      ? { label: 'Install and share', disabled: blocked || !linkPreview, onclick: () => { void installLink(); } }
      : state === 'failed' ? (linkFailure === BLOCKED ? null
        : { label: 'Try again', disabled: blocked || !linkPreview, onclick: () => { void installLink(); } })
        : state === 'unknown' ? { label: 'Check again', disabled: !!linkBusy || refreshing, onclick: () => { void (linkPending ? reconcileLink() : manualRefresh()); } }
          : state === 'installed' ? { label: 'Open', disabled: !!linkBusy, onclick: () => { void openLinkApp(localId); } } : null;
    const bytes = bytesLabel(linkPreview?.decodedBytes);
    /** @type {Fact[]} */ const list = [
      { label: 'Made by', value: target.publisher, code: true, copy: copyButton('link:did', target.publisher) },
      { label: 'Version', value: target.hash, code: true },
      { label: 'Share link', value: target.address, code: true, copy: copyButton('link:address', target.address) },
    ];
    if (bytes) list.push({ label: 'Size', value: bytes });
    list.push({ label: 'WebAssembly', value: wasmLabel(linkPreview?.containsWasm) });
    list.push({ label: 'Runtime', value: failure?.runtime ?? linkPreview?.runtimeCompatibility?.message ?? 'Runtime requirements not specified.' });
    const tone = toneOf(card?.dwapp_id ?? target.uri);
    const maker = makerOf(target.publisher);
    // why the Library's copy even with the link's own check: Open runs that
    // copy, and an edit on this device can change it after the install.
    const changed = localId ? localChangesOf(localId, target.hash) : null;
    // why the link's own check first: it read this exact version's files. A
    // page restored after a reload has only the Library's record of them.
    const fromLink = verifiedDeclared(linkPreview?.declared, target.hash);
    const says = changed === true ? null : saysIt(fromLink ? { declared: fromLink, checked: 'link' } : {
      declared: localId ? verifiedDeclared(records.find(record => record.id === localId)?.dweb?.declared, target.hash) : null,
      checked: 'installed', changed,
    });
    return m('.disc-home.disc-view.disc-page', { key: 'link' }, [
      backLink({ onclick: goBack }),
      appHead({
        name, letter: letterOf(name), tone, maker, onMaker: () => openMaker(target.publisher, name),
        meta: localId ? 'In your Library' : kbLabel(linkPreview?.decodedBytes), modified: changed === true,
        description: card?.description, onShare: () => openShareDialog('link'),
      }),
      state === 'cant-run' ? cantRunPanel() : installPanel({
        state: state === 'conflict' ? 'review' : state, name, fresh: linkFresh, changed: changed === true,
        message: state === 'installing' ? `You can leave this page. The ${held?.action ?? 'install'} keeps going.` : null,
        failure: failure ? { action: 'install', hint: failure.hint } : null,
        unknown: state === 'unknown' ? unknownLines(held?.action ?? 'install') : null,
        notice: linkNotice || null,
        error: rootAlert('link'),
        primary, sharing: state === 'review' ? SHARING : null, onLibrary: toLibrary,
      }),
      // why checked: the page opens only after peerd checked every file of the link.
      state === 'cant-run' ? null : [safetyLines({ maker, checked: 'link', changed: changed === true }),
        says ? saysItSection(says) : null],
      techView(list),
      shareFor === 'link' ? shareView('link', { name, letter: letterOf(name), tone, address: target.address, maker }) : null,
    ]);
  };

  /** @param {string} did */
  const makerPage = (did) => {
    const name = contactNames.get(did) ?? null;
    const title = name ?? shortKey(did);
    // why the Library list offline: the offline root lists only Library apps,
    // each with Open, and a card heard before may name a version to fetch.
    const offline = net?.kind === 'offline';
    const made = (offline ? offlineApps() : apps).filter(app => app.publisher === did);
    const maker = { name, key: shortKey(did) };
    const isBlocked = blockedDids.has(did);
    const menu = makerMenu({ did, myDid, saved: !!name, blocked: isBlocked });
    const form = renaming?.did === did ? renaming : null;
    return m('.disc-home.disc-view.disc-page', { key: `maker:${did}` }, [
      backLink({ onclick: goBack, label: makerFrom?.name ?? 'Discover' }),
      makerHead({
        title, letter: letterOf(title), tone: toneOf(did), saved: !!name,
        menu: makerMenuView({
          maker, open: menuOpen, rename: menu.rename, block: menu.block,
          onToggle: () => { menuOpen = !menuOpen; }, onClose: closeMenu,
          onRename: () => startRename(did), onBlock: () => askBlock(did),
        }),
      }),
      form ? renameForm({
        value: form.value, busy: form.busy, failed: form.failed, canSave: !!form.value.trim() && form.value.trim() !== (name ?? ''),
        oninput: (value) => { form.value = value; }, onSave: () => { void saveName(did); }, onCancel: cancelRename,
      }) : null,
      // why only until a read shows the name: then peerd knows it was saved.
      renameUnknown?.did === did && contactNames.get(did) !== renameUnknown.name
        ? m('p.type-body-sm', { role: 'status' }, 'peerd is not sure the name was saved. Check Contacts before you try again.') : null,
      isBlocked ? blockedLine({ maker }) : m('.disc-section.disc-section--tight', [
        m('.type-label-strong', ['Apps from ', name ? m('bdi', name) : m('bdi.type-code.disc-maker-key', title)]),
        // why a line: a share link's maker often has no app that peers share.
        made.length ? m('ul.disc-app-list', made.slice(0, makerLimit).map(app => appRow(appTileProps(app, offline, true))))
          : m('p.type-body-sm.disc-footnote', MAKER_EMPTY),
      ]),
      made.length > makerLimit ? showMore(() => { focusTile(made[makerLimit]); makerLimit += EXPLORE_WINDOW; }) : null,
      techView([{ label: 'Made by', value: did, code: true, copy: copyButton(`maker:${did}:did`, did) }]),
      blockFor === did ? blockDialog({
        maker, busy: blockBusy, issue: blockIssue,
        onConfirm: () => { void blockMaker(did); }, onCancel: cancelBlock, onCheck: () => { void checkBlock(did); },
      }) : null,
    ]);
  };

  const rootPage = () => {
    const view = rootOf(pill === 'included');
    return view === 'start' ? startView() : view === 'looking' ? lookingView() : view === 'empty' ? emptyView()
      : gridView(view === 'offline');
  };

  /** @param {{dom: Element|null}} vnode */
  const afterRender = (vnode) => {
    rootDom = vnode.dom;
    if (attrs.enabled) startPolling(); else stopPolling();
    if (!pendingFocus || !rootDom) return;
    const { selector, scroll, fallback, ifLost } = pendingFocus;
    pendingFocus = null;
    const host = scrollHost();
    if (host && scroll !== null) host.scrollTop = scroll;
    // why ifLost: a settled install moves focus to its status line only when
    // focus fell off the removed button, never from a control the user moved
    // to meanwhile.
    if (ifLost && document.activeElement && document.activeElement !== document.body) return;
    const target = (selector ? rootDom.querySelector(selector) : null) ?? (fallback ? rootDom.querySelector(fallback) : null);
    if (!(target instanceof HTMLElement)) return;
    // why tabindex -1: a heading takes focus only with it, as in home.js.
    if (target.matches('h1')) target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: scroll !== null });
  };

  return {
    oninit() {
      // why: only the fences (in-flight and unknown effects) outlive a mount,
      // and an unknown one keeps its marker, so the page says why install stays off.
      // A settled outcome describes the Library as it was, and the user may
      // have deleted or updated the app there since, so the catalog decides.
      for (const id of Object.keys(busy)) if (!['installing', 'updating'].includes(busy[id]) && !unconfirmed.has(id)) delete busy[id];
      for (const id of Object.keys(installedId)) delete installedId[id];
      for (const id of Object.keys(notices)) delete notices[id];
      conflicts.clear();
      try {
        const saved = sessionStorage.getItem(PENDING_KEY);
        if (saved) {
          linkPending = immutableAppRoot(saved);
          linkInput = linkPending.address;
          shareOpen = true;
          route = { page: 'link' };
          // why: an install sent before a rail switch still runs. Follow it,
          // so the page keeps going and then shows its outcome.
          if (effects.link?.address === saved) { linkBusy = 'install'; void followLink(effects.link); }
        }
      } catch {
        linkError = 'peerd could not check an earlier install. Reload the page before you install.';
        linkBusy = 'receipt';
        shareOpen = true;
      }
    },
    oncreate: afterRender,
    onupdate: afterRender,
    onremove() {
      dead = true;
      linkEpoch++;
      choiceAttempt++;
      stopPolling();
      if (choiceTimer) clearTimeout(choiceTimer);
      if (copyTimer) clearTimeout(copyTimer);
    },
    /** @param {{attrs: Attrs}} vnode */
    view(vnode) {
      attrs = vnode.attrs;
      if (viewEnabled && !attrs.enabled) { linkEpoch++; linkPreview = null; route = { page: 'root' }; }
      // why the heading: Turn on went off while it saved, so focus fell to
      // the body. Land on the new root, as home.js does.
      if (!viewEnabled && attrs.enabled) pendingFocus = { selector: 'h1', scroll: null, ifLost: true };
      viewEnabled = attrs.enabled;
      answerKey(attrs.openKey);
      if (!attrs.enabled) return [startView()];
      const page = route.page === 'app' ? appPage(route.key) : route.page === 'link' ? linkPage()
        : route.page === 'maker' ? makerPage(route.did) : null;
      return [page ?? rootPage()];
    },
  };
};
