// @ts-check

import m from '/vendor/mithril/mithril.js';

/** @typedef {(msg: object) => Promise<any>} Send */

// Persistent capability failure. It is not dismissible because hiding it would
// leave both the user and model with a false picture of what peerd can do.
export const ActorIsolationBanner = {
  /** @param {{ state: { retrying?: boolean, retryFailed?: boolean, retryRequested?: boolean, recoveryAnnounced?: boolean, recoveryDismissed?: boolean }, attrs: { capability?: { status?: string, reason?: string|null, retryable?: boolean }, send: Send } }} vnode */
  view(vnode) {
    const { capability, send } = vnode.attrs;
    if (!capability) return null;
    if (capability.status === 'available') {
      if (!vnode.state.retryRequested || vnode.state.recoveryDismissed) return null;
      const focusRecovery = (/** @type {{ dom: HTMLElement }} */ recoveryVnode) => {
        if (vnode.state.recoveryAnnounced) return;
        vnode.state.recoveryAnnounced = true;
        recoveryVnode.dom.focus();
      };
      return m('.actor-isolation-banner.is-recovered', {
        tabindex: '-1',
        oncreate: focusRecovery,
        onupdate: focusRecovery,
        onblur: () => {
          vnode.state.recoveryDismissed = true;
          m.redraw();
        },
      }, m('.actor-isolation-copy', [
        m('strong', 'Actor work is ready'),
        m('span', 'The isolated worker is available again.'),
      ]));
    }
    const temporary = capability.status === 'temporarily_unavailable';
    const retrying = vnode.state.retrying === true;
    const retryFailed = vnode.state.retryFailed === true;
    const retry = async () => {
      if (vnode.state.retrying === true) return;
      vnode.state.retrying = true;
      vnode.state.retryFailed = false;
      vnode.state.retryRequested = true;
      vnode.state.recoveryAnnounced = false;
      vnode.state.recoveryDismissed = false;
      // why: render the busy and disabled state before a fast worker probe can
      // resolve, so repeated clicks and assistive technology see the transition.
      m.redraw.sync();
      try {
        const response = await send({ type: 'actor-isolation/retry' });
        if (response?.capability && capability) Object.assign(capability, response.capability);
        else vnode.state.retryFailed = true;
      }
      catch { vnode.state.retryFailed = true; }
      finally { vnode.state.retrying = false; m.redraw(); }
    };
    return m('.actor-isolation-banner', {
      role: 'status',
      'aria-live': 'polite',
      'aria-atomic': 'true',
      'aria-busy': String(retrying),
    }, [
      m('.actor-isolation-copy', [
        m('strong', temporary
          ? retryFailed ? 'Actor work is still paused' : 'Actor work is paused'
          : 'Actors are unavailable'),
        m('span', temporary
          ? retryFailed
            ? 'Actor execution could not be restored. Try again in a moment. If it keeps failing, restart the browser, then use Try again.'
            : 'Actor execution is paused because its isolation state could not be confirmed. Use Try again before retrying an actor request.'
          : 'This browser could not create the isolated worker actors require. Actor requests will not run.'),
      ]),
      temporary && capability.retryable
        ? m('button.secondary', {
            type: 'button',
            disabled: retrying,
            onclick: retry,
          }, retrying ? 'Retrying actor worker…' : 'Try again')
        : null,
    ]);
  },
};
