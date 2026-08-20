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
import { settingsRow, toggleSwitch, rowController } from '../components/settings-row.js';

/** @typedef {import('./reset-row.js').Send} Send */

export const DwebSection = {
  /** @param {{ attrs?: { loadStatus?: () => Promise<any> }, state: any }} vnode */
  oninit(vnode) {
    vnode.state.dwebStatus = null;             // { available, phase, did }
    vnode.state.dwebBusy = false;
    vnode.state.dwebError = null;
    vnode.state.dwebStopIncomplete = false;
    if (DWEB_ENABLED) {
      const loadStatus = vnode.attrs?.loadStatus
        ?? (() => loadDweb().then((client) => client.getStatus()));
      loadStatus()
        .then((s) => { vnode.state.dwebStatus = s; m.redraw(); })
        .catch(() => {});
    }
  },

  /** @param {{ attrs: { state: any, send: Send }, state: any }} vnode */
  view: ({ attrs: { state, send }, state: ui }) => {
    // Preview-only key; undefined (and unrenderable) on store packages.
    const dwebEnabled = !!state.settings?.dwebEnabled;
    const agentOn = !!state.settings?.dwebAgentEnabled;
    const { whyOpen, toggleWhy, toggleRow } = rowController(ui);

    // The network switch is NOT a plain toggleRow: it has a third state. When
    // the setting persisted Off but the live network refused to stop, the
    // stored value and the running network disagree, and the row has to say
    // so rather than showing a clean OFF. The switch then RETRIES the stop
    // instead of flipping - which is why the click target computes its own
    // target rather than negating `dwebEnabled`.
    const networkBusy = !!ui.dwebBusy;
    const stopFailed = !!ui.dwebStopIncomplete;
    const applyNetwork = async () => {
      if (ui.dwebBusy) return;
      const targetEnabled = stopFailed ? false : !dwebEnabled;
      ui.dwebBusy = true;
      ui.dwebError = null;
      try {
        const reply = await send({ type: 'settings/update', patch: { dwebEnabled: targetEnabled } });
        if (reply?.ok) {
          ui.dwebStopIncomplete = false;
        } else if (!targetEnabled && reply?.settings?.dwebEnabled === false) {
          ui.dwebStopIncomplete = true;
          ui.dwebError = 'dweb is set to Off, but the live network could not be stopped. Restart peerd or try again.';
        } else {
          ui.dwebError = `Could not update dweb: ${reply?.error ?? 'unknown error'}. Try again.`;
        }
      } catch {
        ui.dwebError = ui.dwebStopIncomplete
          ? 'dweb is set to Off, but the live network could not be stopped. Restart peerd or try again.'
          : 'Could not confirm the dweb change. Try again.';
      } finally {
        ui.dwebBusy = false;
        m.redraw();
      }
    };
    // Status belongs INSIDE the network row, not between the two rows: it is
    // only meaningful while the network is on, and a loose paragraph between
    // rows breaks the scan the row pattern exists to give.
    const networkStatus = ui.dwebStatus ? m('p.hint', [
      `Protocol phase ${ui.dwebStatus.phase ?? 'unknown'}. `,
      ui.dwebStatus.did
        ? ['Peer identity: ', m('code', ui.dwebStatus.did), '. ',
          m('a', { href: '#!/transfer' }, 'Back up or restore this identity.')]
        : 'Identity is vault-stored and created on first room join.',
    ]) : null;
    const networkRow = settingsRow({
      id: 'dweb-network',
      label: 'Participate in the dweb',
      pill: networkBusy ? '\u2026' : dwebEnabled ? 'ON' : 'OFF',
      badge: stopFailed ? 'STILL RUNNING' : null,
      summary: networkBusy
        ? 'Saving\u2026'
        : stopFailed
          ? 'Set to Off, but the live network is still running. Retry to stop it.'
          : dwebEnabled
            ? 'This peerd can join dweb rooms with other instances and run peer-to-peer dwapps.'
            : 'Nothing connects anywhere. Enabling lets this peerd join dweb rooms over WebRTC.',
      why: dwebEnabled
        ? 'ON - this peerd can join dweb rooms with other peerd instances '
          + '(N-peer rooms over WebRTC) and run dwapps that chat and share '
          + 'data peer-to-peer. Connections are end-to-end between peers; '
          + 'the rendezvous node only relays opaque handshakes, and a room '
          + 'keeps working if it goes away. Turn this off to stop all dweb '
          + 'activity.'
        : 'OFF. Enabling lets this peerd join dweb rooms with other peerd '
          + 'instances over WebRTC and run peer-to-peer dwapps. (On the '
          + 'preview package dweb is on by default; you turned it off.) '
          + 'Nothing connects anywhere until you explicitly join a room.',
      open: whyOpen('dweb-network'),
      onToggleWhy: toggleWhy('dweb-network'),
      control: toggleSwitch({
        on: dwebEnabled,
        busy: networkBusy,
        label: stopFailed
          ? 'Participate in the dweb - retry stopping'
          : `Participate in the dweb - ${dwebEnabled ? 'on' : 'off'}`,
        onclick: applyNetwork,
      }),
      children: networkStatus,
    });

    return m('div', [
      m('.dweb-banner', [
        m('strong', 'Dweb preview. '),
        'This is research-grade. The protocol may change; data formats '
        + 'may evolve. Dweb traffic is opt-in per-tab.',
      ]),
      m('p', 'You’re running peerd with the dweb preview enabled. '
        + 'The core extension is the same peerd that ships on the stores - '
        + 'only this dweb overlay is preview.'),
      networkRow,
      ui.dwebError ? m('p.error', { role: 'alert' }, ui.dwebError) : null,
      // The dweb AGENT - the mesh-operator actor. Nested under the network
      // toggle (no network, no agent) and OPT-IN: an agent peers can wake is a
      // posture the user chooses.
      dwebEnabled ? toggleRow({
        id: 'dweb-agent',
        label: 'dweb agent',
        on: agentOn,
        busyKey: 'dwebAgentBusy',
        summary: agentOn
          ? 'Addressable as "dweb" in chat (message_actor); joins the agent inbox on unlock.'
          : 'The mesh tools are unavailable - they live on this agent, not the chat agent.',
        why: 'A dedicated, isolated agent that operates the mesh for you: it '
          + 'holds the dweb tools (discover, share, install, block), keeps a '
          + 'ledger of peers and publishers, and monitors messages sent to '
          + 'your agent - surfacing only what matters. It runs keyless in its '
          + 'own worker, can never be made to act by an inbound message, and '
          + 'installs or shares only with your confirmation.',
        apply: () => send({
          type: 'settings/update',
          patch: { dwebAgentEnabled: !agentOn },
        }),
      }) : null,

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
