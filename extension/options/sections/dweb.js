// @ts-check
// Options → Decentralized web (preview packages only).
//
// Ported from the panel's dweb section. DWEB_ENABLED is a build-time
// literal: the store package's copy of channel-config.js has it false, the
// options shell never registers this route or nav entry, the dwebEnabled
// key doesn't exist in CHANNEL_DEFAULTS, and the module behind loadDweb()
// isn't even in that artifact — this file is structurally dead code
// there. loadDweb() from /shared/dweb-loader.js is the ONE sanctioned
// path to the module (packaging/check-dweb-boundary.ts enforces it).

import m from '/vendor/mithril/mithril.js';
import { loadDweb } from '/shared/dweb-loader.js';
import { DWEB_ENABLED } from '/shared/channel-config.js';
import { openHome } from '/shared/open-home.js';
import { resetRow } from './reset-row.js';

/** @typedef {import('./reset-row.js').Send} Send */

export const DwebSection = {
  /** @param {{ state: any }} vnode */
  oninit(vnode) {
    vnode.state.dwebStatus = null;             // { available, phase, did }
    vnode.state.dwebBusy = false;
    if (DWEB_ENABLED) {
      loadDweb()
        .then((client) => client.getStatus())
        .then((s) => { vnode.state.dwebStatus = s; m.redraw(); })
        .catch(() => {});
    }
  },

  /** @param {{ attrs: { state: any, send: Send }, state: any }} vnode */
  view: ({ attrs: { state, send }, state: ui }) => {
    // Preview-only key; undefined (and unrenderable) on store packages.
    const dwebEnabled = !!state.settings?.dwebEnabled;

    return m('div', [
      m('.dweb-banner', [
        m('strong', 'Dweb preview. '),
        'This is research-grade. The protocol may change; data formats '
        + 'may evolve. Dweb traffic is opt-in per-tab.',
      ]),
      m('p', 'You’re running peerd with the dweb preview enabled. '
        + 'The core extension is the same peerd that ships on the stores — '
        + 'only this dweb overlay is preview.'),
      m('h3', 'Participate in the dweb'),
      m('p', dwebEnabled
        ? 'ON — this peerd can join dweb rooms with other peerd instances '
          + '(N-peer rooms over WebRTC) and run dwapps that chat and share '
          + 'data peer-to-peer. Connections are end-to-end between peers; '
          + 'the rendezvous node only relays opaque handshakes, and a room '
          + 'keeps working if it goes away. Turn this off to stop all dweb '
          + 'activity.'
        : 'OFF. Enabling lets this peerd join dweb rooms with other peerd '
          + 'instances over WebRTC and run peer-to-peer dwapps. (On the '
          + 'preview package dweb is on by default; you turned it off.) '
          + 'Nothing connects anywhere until you explicitly join a room.'),
      m('div', { style: 'display:flex; gap:8px; align-items:center;' }, [
        m('button.secondary', {
          type: 'button',
          disabled: ui.dwebBusy,
          onclick: async () => {
            if (ui.dwebBusy) return;
            ui.dwebBusy = true;
            await send({ type: 'settings/update', patch: { dwebEnabled: !dwebEnabled } });
            ui.dwebBusy = false;
            m.redraw();
          },
        }, ui.dwebBusy ? '…' : dwebEnabled ? 'Disable dweb' : 'Enable dweb'),
      ]),
      ui.dwebStatus ? m('p.hint', [
        `Protocol phase ${ui.dwebStatus.phase ?? '—'}. `,
        ui.dwebStatus.did
          ? ['Identity: ', m('code', ui.dwebStatus.did), ' (ephemeral this view; the persistent one is vault-stored).']
          : 'Identity is vault-stored and created on first room join.',
      ]) : null,

      // The dweb AGENT — the mesh-operator actor. Nested under the network
      // toggle (no network, no agent) and OPT-IN: an agent peers can wake is a
      // posture the user chooses. Rendering follows the dependent-toggle idiom
      // (behavior.js failover picker).
      dwebEnabled ? m('div', { style: 'margin-top:14px; border-top:1px solid var(--hairline, #2a2a2a); padding-top:14px;' }, [
        m('h3', 'dweb agent'),
        m('p', 'A dedicated, isolated agent that operates the mesh for you: it '
          + 'holds the dweb tools (discover, share, install, block), keeps a '
          + 'ledger of peers and publishers, and monitors messages sent to '
          + 'your agent — surfacing only what matters. It runs keyless in its '
          + 'own worker, can never be made to act by an inbound message, and '
          + 'installs or shares only with your confirmation.'),
        m('button.secondary', {
          type: 'button',
          onclick: async () => {
            await send({ type: 'settings/update', patch: { dwebAgentEnabled: !state.settings?.dwebAgentEnabled } });
            m.redraw();
          },
        }, state.settings?.dwebAgentEnabled ? 'Disable the dweb agent' : 'Enable the dweb agent'),
        state.settings?.dwebAgentEnabled
          ? m('p.hint', 'On — your agent is addressable as "dweb" in chat (message_actor) and joins the agent inbox on unlock.')
          : m('p.hint', 'Off — the mesh tools are unavailable until enabled (they live on this agent, not the chat agent).'),
      ]) : null,

      // commons — the Phase 1 north-star dwapp — now lives in the Library as
      // a pre-loaded, dweb-tagged app (not a button here). Point there.
      dwebEnabled ? m('div', { style: 'margin-top:14px; border-top:1px solid var(--hairline, #2a2a2a); padding-top:14px;' }, [
        m('h3', 'commons — the dweb demo'),
        m('p', 'A shared room with a chat for everyone plus private, '
          + 'peer-to-peer one-to-one chats. It ships pre-loaded in your '
          + 'Library, tagged “dweb” — open it there. To try it, open it in '
          + 'two profiles (or two machines) and join the same room code.'),
        m('button.secondary', { type: 'button', onclick: () => openHome('library') }, 'Open Library'),
      ]) : null,

      resetRow(send, ['dwebEnabled', 'dwebAgentEnabled']),
    ]);
  },
};
