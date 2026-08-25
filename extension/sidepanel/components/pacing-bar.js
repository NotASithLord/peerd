// @ts-check
// Pacing bar - the chat view's window onto a per-origin wait (#234).
//
// why a bar and not a silent sleep: peerd deliberately does nothing for up to
// tens of seconds while a site's stated pause runs out. Without a visible
// reason, that is indistinguishable from a hang, and the reasonable response to
// a hang is to send again - which aborts the turn and starts the whole thing
// over. Saying what is happening, and which site asked for it, is the whole
// point of the component.
//
// why it carries its own Stop: the composer's Stop is at the other end of the
// panel and says nothing about what it would be stopping. A person who has just
// read "waiting 20s for this site" wants the way out in the same sentence. It
// posts the same agent/stop, so the two never disagree.
//
// The countdown ticks LOCALLY off a server-stamped deadline. The service worker
// sends one message per wait; a per-second broadcast would wake the worker and
// fan out to every port to say something the panel can compute itself.
//
// Calm and monochrome per the brand rule; the spinning orb is the only color.

import m from '/vendor/mithril/mithril.js';

/** @typedef {(msg: object) => Promise<any>} Send */
/** @typedef {{ origin: string, untilMs: number, reason?: string } | null | undefined} PacingState */

/**
 * Seconds left, floored at zero. A wait whose deadline has passed still shows
 * the bar until the worker's next message clears it, because the action does
 * not resume at exactly the deadline - it resumes when the sleep wakes up.
 * @param {number} untilMs @param {number} now
 */
const secondsLeft = (untilMs, now) => Math.max(0, Math.ceil((untilMs - now) / 1000));

/**
 * The site's own name, never a path. `origin` reaches here already canonical
 * from the service worker, so this only trims the scheme for readability.
 * @param {string} origin
 */
const hostOf = (origin) => {
  try { return new URL(origin).host; }
  catch { return origin; }
};

export const PacingBar = {
  /** @param {{ state: { timer: any, until: number }, attrs: { pacing?: PacingState } }} vnode */
  oncreate(vnode) { PacingBar.arm(vnode); },
  /** @param {{ state: { timer: any, until: number }, attrs: { pacing?: PacingState } }} vnode */
  onupdate(vnode) { PacingBar.arm(vnode); },
  /** @param {{ state: { timer: any } }} vnode */
  onremove(vnode) { if (vnode.state.timer) clearTimeout(vnode.state.timer); },

  /**
   * One pending redraw at a time, re-armed on each tick and re-anchored whenever
   * the wait's identity changes. why a timeout rather than an interval: an
   * interval outlives the wait it belongs to, and a panel left open on a settled
   * chat would keep redrawing forever.
   * @param {{ state: { timer: any, until: number }, attrs: { pacing?: PacingState } }} vnode
   */
  arm(vnode) {
    const until = vnode.attrs.pacing?.untilMs ?? 0;
    if (vnode.state.until === until && vnode.state.timer) return;
    if (vnode.state.timer) { clearTimeout(vnode.state.timer); vnode.state.timer = null; }
    vnode.state.until = until;
    if (!until || until <= Date.now()) return;
    const tick = () => {
      vnode.state.timer = null;
      m.redraw();
      PacingBar.arm(vnode);
    };
    vnode.state.timer = setTimeout(tick, 1000);
  },

  /** @param {{ attrs: { pacing?: PacingState, send: Send } }} vnode */
  view: ({ attrs: { pacing, send } }) => {
    if (!pacing || !pacing.origin) return null;
    const left = secondsLeft(pacing.untilMs, Date.now());
    const why = pacing.reason === 'server-deadline'
      ? 'the site asked peerd to wait'
      : 'peerd is keeping under this site’s limit';
    return m('.goal-bar.pacing-bar', { role: 'status', 'aria-live': 'polite' }, [
      m('span.peerd-spinner.peerd-spinner--sm', { 'aria-hidden': 'true' }),
      m('span.goal-bar-label', 'Waiting'),
      m('span.goal-bar-meta', left > 0 ? `${left}s` : 'resuming'),
      m('span.goal-bar-text', { title: `${hostOf(pacing.origin)}: ${why}` },
        `${hostOf(pacing.origin)} · ${why}`),
      m('.spacer'),
      m('button.secondary.goal-bar-stop', {
        onclick: () => send({ type: 'agent/stop' }),
        title: 'Stop without waiting',
      }, 'Stop'),
    ]);
  },
};
