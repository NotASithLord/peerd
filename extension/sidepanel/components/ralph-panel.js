// @ts-check
// Ralph loop status panel — the chat view's window onto the persistent
// fresh-context loop (peerd-runtime/ralph). The driver has pushed
// ralph/* events over the side-panel port since the loop shipped
// (sidepanel.js folds them into state.ralph) — this panel is the first
// thing to RENDER that state. No loop logic lives here: it projects
// LoopState + the plan summary, and its one mutation is the existing
// ralph/halt route.
//
// Visibility rules:
//   - Live (port-fed) LoopState wins. A panel opened mid-run has no
//     live state yet, so a one-shot ralph/status fetch seeds it — but
//     ONLY for active runs: a terminal LoopState lingering in storage
//     from last week shouldn't greet every new chat.
//   - Terminal states reached DURING this panel's lifetime stay visible
//     with a dismiss, so "it stopped / errored" is never silent.
//
// Stop maps to ralph/halt. There is deliberately no Pause/Resume: the
// driver's only resume path is SW-boot rehydration and halt is
// terminal — buttons for semantics the driver doesn't have would lie.
//
// Calm + monochrome per the brand rule; the spinning orb
// (.peerd-spinner) is the panel's only color while a run is live.

import m from '/vendor/mithril/mithril.js';
import {
  isRalphActive, ralphStatusLabel, formatElapsed, formatTaskProgress,
  lastRalphNote,
} from './ralph-format.js';

/**
 * Live LoopState pushed over the ralph channel.
 * @typedef {Object} LoopState
 * @property {string} status
 * @property {string} [runId]
 * @property {number} [iteration]
 * @property {number} [startedAt]
 * @property {string} [lastError]
 */

/**
 * Component-local state for RalphPanel.
 * @typedef {Object} RalphPanelState
 * @property {LoopState|null} seedState
 * @property {any} seedSummary
 * @property {string} goal
 * @property {string|null|undefined} dismissedRunId
 * @property {boolean} stopping
 * @property {string} seenKey
 * @property {boolean} tickActive
 * @property {ReturnType<typeof setInterval>} [timer]
 */

/** @typedef {(msg: object) => Promise<any>} Send */
/** @typedef {{ state: RalphPanelState, attrs: { ralph?: { state?: LoopState|null, summary?: any, log?: any[] }, send: Send } }} RalphPanelVnode */

export const RalphPanel = {
  /** @param {RalphPanelVnode} vnode */
  oninit(vnode) {
    vnode.state.seedState = null;    // LoopState from the ralph/status fetch
    vnode.state.seedSummary = null;
    vnode.state.goal = '';           // plan goal — only on the status route
    vnode.state.dismissedRunId = null;
    vnode.state.stopping = false;
    vnode.state.seenKey = '';        // runId:status — goal refetch trigger
    vnode.state.tickActive = false;  // drives the elapsed-readout interval
    RalphPanel.fetchStatus(vnode);
  },

  /** @param {RalphPanelVnode} vnode */
  fetchStatus(vnode) {
    vnode.attrs.send({ type: 'ralph/status' }).then((r) => {
      if (!r?.ok) return;
      vnode.state.seedState = r.state ?? null;
      vnode.state.seedSummary = r.summary ?? null;
      vnode.state.goal = r.plan?.goal ?? '';
      m.redraw();
    }).catch(() => {});
  },

  /** @param {RalphPanelVnode} vnode */
  oncreate(vnode) {
    // why: the elapsed readout should tick while a run is live; one calm
    // 1s redraw beats threading a dedicated timer event through the SW.
    // Gated on tickActive (set during view) so an idle chat doesn't
    // redraw forever. Cleared on unmount.
    vnode.state.timer = setInterval(() => {
      if (vnode.state.tickActive) m.redraw();
    }, 1000);
  },

  /** @param {RalphPanelVnode} vnode */
  onremove(vnode) { clearInterval(vnode.state.timer); },

  /** @param {RalphPanelVnode} vnode */
  view(vnode) {
    const { attrs, state: ui } = vnode;
    const live = attrs.ralph ?? {};
    // Live port state wins; the seed fetch only surfaces ACTIVE runs
    // (see header).
    const st = live.state
      ?? ((ui.seedState && isRalphActive(ui.seedState.status)) ? ui.seedState : null);
    const visible = !!st && st.status !== 'idle' && st.runId !== ui.dismissedRunId;
    const active = visible && isRalphActive(st.status);
    ui.tickActive = active;
    if (!visible) return null;

    // why: refetch the goal when the run or its phase changes — the
    // planning pass may rewrite the plan file, and the port events carry
    // LoopState + counts but not the goal text.
    const key = `${st.runId}:${st.status}`;
    if (key !== ui.seenKey) { ui.seenKey = key; RalphPanel.fetchStatus(vnode); }

    const isError = st.status === 'error';
    const summary = live.summary ?? ui.seedSummary;
    const progress = formatTaskProgress(summary);
    const note = isError ? (st.lastError ?? lastRalphNote(live.log)) : lastRalphNote(live.log);

    const stop = () => {
      if (ui.stopping) return;
      ui.stopping = true;
      attrs.send({ type: 'ralph/halt' }).then(() => {
        ui.stopping = false;
        // The halted push arrives over the port; the fetch covers the
        // (test/edge) case where no port event lands.
        RalphPanel.fetchStatus(vnode);
      }).catch(() => { ui.stopping = false; m.redraw(); });
    };

    return m('.ralph-panel', { role: 'status', 'aria-live': 'polite' }, [
      m('.ralph-head', [
        active
          ? m('span.peerd-spinner.peerd-spinner--sm', { 'aria-hidden': 'true' })
          : m(`span.ralph-dot${isError ? '.is-error' : ''}`, { 'aria-hidden': 'true' }),
        m('span.ralph-title', 'Ralph loop'),
        m(`span.ralph-status${isError ? '.is-error' : ''}`, ralphStatusLabel(st.status)),
        m('.spacer'),
        active
          ? m('button.secondary.ralph-stop', {
              disabled: ui.stopping,
              onclick: stop,
            }, ui.stopping ? 'Stopping…' : 'Stop')
          : m('button.linkish.ralph-dismiss', {
              'aria-label': 'Dismiss',
              title: 'Dismiss',
              onclick: () => { ui.dismissedRunId = st.runId; },
            }, '×'),
      ]),
      ui.goal ? m('.ralph-goal', { title: ui.goal }, ui.goal) : null,
      m('.ralph-meta', [
        m('span', `iteration ${st.iteration ?? 0}`),
        progress ? m('span', progress) : null,
        st.startedAt ? m('span', formatElapsed(st.startedAt)) : null,
      ]),
      note ? m(`.ralph-note${isError ? '.is-error' : ''}`, note) : null,
    ]);
  },
};
