// @ts-check
// Options page entry point — the full-tab settings surface.
//
// Options needs no streaming events. It reads one authoritative snapshot on
// load/resume and folds mutation receipts locally; unknown effects reconcile
// with one read and are never replayed.

import m from '/vendor/mithril/mithril.js';
import browser from '/shared/browser-api.js';
import { recoverColdPortState } from '/shared/cold-port-recovery.js';
import { normalizeColdStateSnapshot } from '/shared/kernel-state-shell.js';
import { makeReconciledUiSender, makeUiRuntimeClient } from '/shared/ui-runtime-client.js';
import { CHANNEL, DWEB_ENABLED } from '/shared/channel-config.js';
import { OptionsApp } from './components/options-app.js';
import { callPrivateTransfer } from './private-transfer-session.js';

// null until the first snapshot lands — the shell renders a loading
// gate rather than guessing at vault state (a flash of "set up peerd"
// on every open would be a lie for established installs).
/** @type {any} */
let currentState = null;
let stateLoadFailed = false;
/** @type {Promise<boolean>|null} */
let stateFetchPromise = null;
const uiRuntime = makeUiRuntimeClient({ browser });

const fetchState = () => {
  if (stateFetchPromise) return stateFetchPromise;
  stateLoadFailed = false;
  m.redraw();
  stateFetchPromise = (async () => {
    try {
      /** @type {any} */ let state = null;
      const recovered = await recoverColdPortState({
        browser,
        isCurrent: () => true,
        isHydrated: () => false,
        adoptState: (raw) => {
          state = normalizeColdStateSnapshot(raw);
          return !!state;
        },
        requestTimeoutMs: 4_000,
        overallTimeoutMs: 20_000,
        maxAttempts: 4,
      });
      if (!recovered || !state) throw new Error('options-state-unavailable');
      currentState = state;
      stateLoadFailed = false;
      m.redraw();
      return true;
    } catch (error) {
      console.warn('[options] state fetch failed', error);
      if (!currentState) {
        stateLoadFailed = true;
        m.redraw();
      }
      return false;
    } finally {
      stateFetchPromise = null;
      m.redraw();
    }
  })();
  return stateFetchPromise;
};

// Fold a mutation's reply into the snapshot so the page reflects the
// write without waiting for the next focus refetch.
/**
 * @param {{ type: string } & Record<string, any>} msg
 * @param {any} reply
 */
const foldReply = (msg, reply) => {
  if (!currentState) return;
  // A settings write can commit before its live side effect fails. The reply
  // carries the durable value even when ok:false, so keep the page honest about
  // what will apply on the next boot while the owning section reports the live
  // failure and offers a retry.
  if (!reply?.ok) {
    if ((msg.type === 'settings/update' || msg.type === 'settings/reset') && reply?.settings) {
      currentState = { ...currentState, settings: reply.settings };
    }
    return;
  }
  switch (msg.type) {
    case 'settings/update':
    case 'settings/reset': {
      if (reply.settings) {
        currentState = { ...currentState, settings: reply.settings };
      }
      // why the refetch: state.providers ({current, hasKey, model}) is
      // DERIVED SW-side from providerName/providerModel — folding the
      // settings object alone leaves the provider select and the
      // Ollama-recommendation gate stale until the next focus refetch.
      const touched = msg.type === 'settings/update'
        ? Object.keys(msg.patch ?? {})
        : (msg.keys ?? []);
      if (touched.includes('providerName') || touched.includes('providerModel')) {
        fetchState();
      }
      break;
    }
    case 'permission/set':
      // why the nesting: permission/set replies with the permission
      // sub-shape only; it belongs under session, never at the root.
      if (reply.permission) {
        currentState = {
          ...currentState,
          session: { ...(currentState.session ?? {}), permission: reply.permission },
        };
      }
      break;
    case 'vault/enrollPrf':
    case 'vault/disablePrf':
    case 'vault/setRecoveryPassphrase':
      // why refetch instead of fold: prfEnrolled/hasRecovery are vault
      // snapshot facts the replies don't carry — one cheap round-trip
      // beats re-deriving the SW's shape here.
      fetchState();
      break;
    default:
      break;
  }
  m.redraw();
};

/**
 * One-shot sendMessage for typed request/response, with reply folding.
 * @param {{ type: string } & Record<string, any>} msg
 * @returns {Promise<any>}
 */
const send = makeReconciledUiSender({
  send: (msg) => msg.type.startsWith('transfer/') ? callPrivateTransfer(msg) : uiRuntime.send(msg),
  fold: foldReply,
  reconcile: fetchState,
  afterReply: (msg, reply) => msg.type === 'transfer/import' && (reply?.ok || reply?.partial),
});

fetchState();
window.addEventListener('focus', fetchState);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') fetchState();
});

const root = document.getElementById('app');
if (!root) throw new Error('options: #app missing from HTML');

// why ONE shared component for every section (not page(id) per route): the
// nav rail — wordmark, preview badge, section list — doesn't change between
// sections, so mapping each route to its own resolver object made Mithril
// REMOUNT OptionsApp on every section click (replaying the wordmark intro and
// resetting the hand-off phase). Pointing all routes at the SAME `Root` makes
// Mithril DIFF the shell in place; the active section is read from the route.
// NB: every nav id MUST appear here — Mithril's router bounces an unregistered
// route to the default (/providers), which reads as a dead nav item. (That is
// exactly why git-credentials + api-integrations were un-clickable.)
const SECTIONS = ['providers', 'behavior', 'voice', 'skills', 'hooks',
  'memory', 'costs', 'transfer', 'vault', 'api-integrations', 'denylist',
  'learned-sites', 'activity'];
const Root = {
  view: () => {
    const section = (m.route.get().replace(/^\//, '').split(/[/?]/)[0]) || 'providers';
    return m(OptionsApp, {
      state: currentState,
      send,
      section,
      stateLoadFailed,
      retryState: fetchState,
    });
  },
};
/** @type {Record<string, typeof Root>} */
const routes = {};
for (const id of SECTIONS) routes[`/${id}`] = Root;
// Contributor Metrics is deliberately preview/dev-only until the separate
// store go/no-go. Omitting the route makes a guessed store hash fall back to
// Providers instead of mounting a hidden consent surface.
if (CHANNEL === 'preview' || CHANNEL === 'dev') routes['/contributor-metrics'] = Root;
// Build-time literal: the store artifact has DWEB_ENABLED=false, so this route
// (like the nav entry) is structurally dead code there.
if (DWEB_ENABLED) routes['/dweb'] = Root;

m.route(root, '/providers', routes);
