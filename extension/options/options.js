// @ts-check
// Options page entry point — the full-tab settings surface.
//
// State strategy — deliberately NOT the side panel's long-lived port:
// the singleton sidepanel port is load-bearing in the SW (confirm
// coordinator, voice/vm chunk forwarders, goal events all assume THE
// panel owns it), and nothing on this page needs live pushes — every
// management pane self-fetches. So this page:
//   1. fetches one snapshot via the `state/get` route on load,
//   2. refetches on window focus / tab-visible (covers
//      unlock-in-panel-then-return; sendMessage also revives a dead SW,
//      so no keepalive is needed),
//   3. folds mutation replies into the local snapshot (settings/update
//      and settings/reset return the full settings object;
//      permission/set returns a SUB-shape that folds into
//      state.session.permission, not the root).
// Coherence with an open panel is free in the other direction: those
// same mutation routes call pushState() SW-side, so the panel live-syncs
// with edits made here.

import m from '/vendor/mithril/mithril.js';
import browser from '/vendor/browser-polyfill.js';
import { DWEB_ENABLED } from '/shared/channel-config.js';
import { OptionsApp } from './components/options-app.js';

// null until the first snapshot lands — the shell renders a loading
// gate rather than guessing at vault state (a flash of "set up peerd"
// on every open would be a lie for established installs).
/** @type {any} */
let currentState = null;

const fetchState = async () => {
  try {
    const r = /** @type {any} */ (await browser.runtime.sendMessage({ type: 'state/get' }));
    if (r?.ok && r.state) {
      currentState = r.state;
      m.redraw();
    }
  } catch (e) {
    console.warn('[options] state fetch failed', e);
  }
};

// Fold a mutation's reply into the snapshot so the page reflects the
// write without waiting for the next focus refetch.
/**
 * @param {{ type: string } & Record<string, any>} msg
 * @param {any} reply
 */
const foldReply = (msg, reply) => {
  if (!reply?.ok || !currentState) return;
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
const send = async (msg) => {
  const reply = await browser.runtime.sendMessage(msg);
  foldReply(msg, reply);
  return reply;
};

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
const SECTIONS = ['providers', 'behavior', 'voice', 'skills', 'hooks',
  'memory', 'costs', 'transfer', 'vault', 'denylist', 'activity'];
const Root = {
  view: () => {
    const section = (m.route.get().replace(/^\//, '').split(/[/?]/)[0]) || 'providers';
    return m(OptionsApp, { state: currentState, send, section });
  },
};
/** @type {Record<string, typeof Root>} */
const routes = {};
for (const id of SECTIONS) routes[`/${id}`] = Root;
// Build-time literal: the store artifact has DWEB_ENABLED=false, so this route
// (like the nav entry) is structurally dead code there.
if (DWEB_ENABLED) routes['/dweb'] = Root;

m.route(root, '/providers', routes);
