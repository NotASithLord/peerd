// @ts-check
import m from '/vendor/mithril/mithril.js';

/** @param {import('../chat-reducer.js').ChatState | undefined} state */
export const needsPeerNetworkChoice = (state) => !!(
  state?.vault?.initialized && !state.vault.locked
  && state.settings?.dwebChoiceMade === false
);

/** Read only: checking connection status never grants participation. */
export const PeerNetworkStatus = () => {
  let removed = false;
  let checking = false;
  let retrying = false;
  let label = 'Connecting to the peer network…';
  /** @type {ReturnType<typeof setTimeout>|null} */ let timer = null;
  /** @param {(message:any)=>Promise<any>} send */
  const refresh = async (send) => {
    if (removed || checking) return;
    if (timer) clearTimeout(timer);
    checking = true;
    try {
      const ready = await send({ type: 'bootstrap/ready' });
      if (!ready?.ok) throw new Error('status unavailable');
      const lease = ready.featureLeases?.leases?.dweb?.status;
      const result = lease === 'active' ? await send({ type: 'dweb/distributed/info' }) : null;
      label = lease === 'starting' ? 'Connecting to the peer network. You can continue.'
        : result?.running && (result.rendezvous === 'up' || result.linkedCount > 0)
        ? 'Connected to the peer network.'
        : 'Peer network is offline. You can continue and reconnect later.';
    } catch { label = 'Connection status unavailable. You can continue and check again later.'; }
    finally {
      checking = false;
      if (!removed) { timer = setTimeout(() => refresh(send), 4_000); m.redraw(); }
    }
  };
  return {
    /** @param {{attrs:{send:(message:any)=>Promise<any>}}} vnode */
    oninit({ attrs }) { void refresh(attrs.send); },
    onremove() { removed = true; if (timer) clearTimeout(timer); },
    /** @param {{attrs:{send:(message:any)=>Promise<any>}}} vnode */
    view({ attrs: { send } }) {
      return m('.peer-network-status', [
        m('p', { role: 'status', 'aria-live': 'polite' }, label),
        m('button.secondary', { type: 'button', disabled: retrying, onclick: async () => {
          if (retrying) return;
          retrying = true;
          try { await send({ type: 'dweb/base/start' }); }
          catch { /* show the read-back result rather than replaying a mutation */ }
          finally { retrying = false; if (!removed) { void refresh(send); m.redraw(); } }
        } }, retrying ? 'Reconnecting…' : 'Retry connection'),
      ]);
    },
  };
};

export const PeerNetworkStep = () => {
  let removed = false;
  let busy = false;
  let saved = false;
  let refreshing = false;
  let stopUnconfirmed = false;
  /** @type {boolean|undefined} */ let observedEnabled;
  /** @type {boolean|null} */ let requested = null;
  let attempt = 0;
  /** @type {string|null} */ let error = null;
  /** @type {ReturnType<typeof setTimeout>|null} */ let timer = null;
  return {
    /** @param {{attrs:{enabled?:boolean}}} vnode */
    oninit({ attrs }) { observedEnabled = attrs.enabled; saved = attrs.enabled === true; },
    /** @param {{attrs:{enabled?:boolean}}} vnode */
    onbeforeupdate({ attrs }) {
      if (attrs.enabled !== observedEnabled) {
        observedEnabled = attrs.enabled;
        if (refreshing) { attempt += 1; refreshing = false; }
        if (!busy && !error) saved = attrs.enabled === true;
      }
    },
    onremove() { removed = true; attempt += 1; if (timer) clearTimeout(timer); },
    /** @param {{attrs:{send:(message:any)=>Promise<any>,enabled?:boolean,onDone?:()=>void,reconcileState?:()=>Promise<any>}}} vnode */
    view({ attrs: { send, onDone, reconcileState } }) {
      /** @param {boolean} enabled */
      const choose = (enabled) => {
        if (busy || refreshing || removed || (error && !(stopUnconfirmed && !enabled))) return;
        const token = ++attempt;
        requested = enabled;
        busy = true; error = null; stopUnconfirmed = false;
        let finished = false;
        const current = () => !removed && token === attempt;
        const confirmed = () => {
          if (!current() || finished) return;
          finished = true; busy = false; saved = enabled;
          if (timer) clearTimeout(timer);
          if (!enabled) onDone?.();
          void reconcileState?.().catch(() => {});
          m.redraw();
        };
        // Startup can outlive the settings RPC. Confirm only the persisted
        // authority view, then let the user continue while transport connects.
        const reconcile = async () => {
          try {
            const reply = await send({ type: 'state/get' });
            if (enabled && reply?.ok && reply.state?.settings?.dwebChoiceMade === true
                && reply.state.settings.dwebEnabled === enabled) confirmed();
          } catch { /* the mutation reply can still confirm persistence */ }
          if (current() && !finished) timer = setTimeout(reconcile, 750);
        };
        void send({ type: 'settings/update', patch: { dwebEnabled: enabled } }).then((reply) => {
          if (!current() || finished) return;
          if (reply?.ok) confirmed();
          else {
            finished = true; busy = false;
            if (timer) clearTimeout(timer);
            error = 'Your network choice could not be confirmed. Refresh status before choosing again.';
            void reconcileState?.().catch(() => {});
            m.redraw();
          }
        }).catch(() => {
          if (current() && !finished) {
            finished = true; busy = false;
            if (timer) clearTimeout(timer);
            error = 'Your network choice could not be confirmed. Refresh status before choosing again.';
            m.redraw();
          }
        });
        timer = setTimeout(reconcile, 250);
      };
      return m('.onboarding-network', [
        m('h3', error ? 'Network status needs attention' : saved ? 'Peer network enabled' : 'Join the peer network?'),
        m('p', 'Discover, download, and share apps directly with other peers, including WebAssembly apps.'),
        m('p.muted', 'Connecting uses bandwidth and storage, and peers can see your network address. '
          + 'Your private apps, files, chats, and credentials are not published by joining.'),
        m('p.muted', 'You can change this in Settings or Discover. Letting peers trigger agent work is a separate choice.'),
        saved ? m(PeerNetworkStatus, { send }) : null,
        m('.onboarding-actions', stopUnconfirmed ? [
          m('button.secondary', { type: 'button', disabled: busy || refreshing, onclick: () => choose(false) }, 'Retry stopping'),
        ] : saved ? [
          onDone ? m('button', { type: 'button', 'data-network-choice': 'continue', onclick: onDone }, 'Continue') : null,
          m('button.secondary', { type: 'button', disabled: busy || !!error, onclick: () => choose(false) }, 'Turn off'),
        ] : [
          m('button', { type: 'button', disabled: busy || !!error,
            'data-network-choice': 'enable', onclick: () => choose(true) }, 'Enable peer network'),
          m('button.linklike.onboarding-skip', { type: 'button', disabled: busy || !!error,
            'data-network-choice': 'skip', onclick: () => choose(false) }, 'Not now'),
        ]),
        busy ? m('p.muted', { role: 'status' }, 'Saving your choice…') : null,
        error ? m('div', [
          m('p.error', { role: 'alert' }, error),
          m('button.secondary', { type: 'button', disabled: refreshing, onclick: async () => {
            if (refreshing) return;
            refreshing = true;
            const token = ++attempt;
            try {
              const reply = await send({ type: 'state/get' });
              if (removed || token !== attempt || !reply?.ok || !reply.state?.settings) return;
              error = null;
              if (reply.state.settings.dwebChoiceMade === true) {
                saved = reply.state.settings.dwebEnabled === true;
                if (!saved && requested === false) {
                  stopUnconfirmed = true;
                  error = 'Your preference is off, but network shutdown is unconfirmed. Retry stopping to confirm it.';
                }
              }
            } catch { /* keep the unconfirmed outcome visible */ }
            finally {
              if (!removed && token === attempt) { refreshing = false; m.redraw(); }
            }
          } }, refreshing ? 'Checking status…' : 'Refresh status'),
        ]) : null,
      ]);
    },
  };
};
