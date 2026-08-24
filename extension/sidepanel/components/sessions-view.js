// @ts-check
// Sessions view — list of chat sessions; click to switch.
//
// Lives at /chats. The list is fetched on mount via `session/list`.
// Per-row actions (switch, archive) re-fetch after success.
//
// V1 surface:
//   - "+ New chat" at the top (session/reset → route to /chat)
//   - List rows: title, time-ago, message count, model badge
//   - Per-row "×" archive action
//   - Empty + loading + error states

import m from '/vendor/mithril/mithril.js';

/**
 * One session summary row from `session/list`.
 * @typedef {Object} SessionSummary
 * @property {string} sessionId
 * @property {string} [title]
 * @property {number} lastMessageAt
 * @property {number} messageCount
 * @property {boolean} [archived]
 * @property {string} [model]
 * @property {boolean} [hasCustomSystemPrompt]
 * @property {string} [toolManifestLabel]
 */

/**
 * Component-local state for SessionsView.
 * @typedef {Object} SessionsState
 * @property {SessionSummary[]|null} sessions
 * @property {boolean} loading
 * @property {string|null} error
 * @property {boolean} effectBusy
 * @property {boolean} effectUnconfirmed
 */

// Fetch the session list and write the result into the shared `ui`
// object the view reads from. Triggers a redraw at the end so callers
// don't have to remember.
/** @param {SessionsState} ui @param {(message:any)=>Promise<any>} send */
const loadList = async (ui, send) => {
  ui.loading = true;
  ui.error = null;
  m.redraw();
  try {
    const reply = await send({ type: 'session/list' });
    if (reply?.ok) {
      ui.sessions = reply.sessions;
      ui.effectUnconfirmed = false;
    } else {
      ui.error = reply?.error ?? 'Could not load chats.';
    }
  } catch (e) {
    ui.error = /** @type {{ message?: string }} */ (e)?.message ?? 'Could not load chats.';
  } finally {
    ui.loading = false;
    m.redraw();
  }
};

export const SessionsView = {
  /** @param {{ state: SessionsState, attrs: {send:(message:any)=>Promise<any>} }} vnode */
  oninit(vnode) {
    vnode.state.sessions = null;
    vnode.state.loading = true;
    vnode.state.error = null;
    vnode.state.effectBusy = false;
    vnode.state.effectUnconfirmed = false;
    loadList(vnode.state, vnode.attrs.send);
  },

  /**
   * @param {{
   *   attrs: { state: { session?: { sessionId?: string } | null }, send:(message:any)=>Promise<any>, onNavigateToChat?: () => void },
   *   state: SessionsState,
   * }} vnode
   */
  view: ({ attrs: { state, send, onNavigateToChat }, state: ui }) => {
    const activeSessionId = state.session?.sessionId ?? null;
    const visible = (ui.sessions ?? []).filter((s) => !s.archived);

    // After switching/creating a chat, go to the chat view. The side panel is
    // routed (m.route → /chat); the home SPA isn't, so it passes a callback that
    // flips its activeView. why a param, not a host probe: keeps this component
    // pure + host-agnostic — it's mounted in BOTH surfaces now.
    const goToChat = onNavigateToChat || (() => m.route.set('/chat'));

    const effect = async (
      /** @type {{type:string}&Record<string,any>} */ message,
      /** @type {string} */ action,
      /** @type {()=>void} */ onSuccess,
    ) => {
      if (ui.effectBusy || ui.effectUnconfirmed) return;
      ui.effectBusy = true;
      ui.error = null;
      m.redraw();
      try {
        const reply = await send(message);
        if (reply?.ok) onSuccess();
        else {
          ui.effectUnconfirmed = reply?.outcomeKnown === false;
          ui.error = ui.effectUnconfirmed
            ? `Peerd could not confirm whether ${action} finished. Refresh chats to reconcile before trying again.`
            : `Peerd could not ${action}. Try again.`;
        }
      } catch {
        ui.effectUnconfirmed = true;
        ui.error = `Peerd could not confirm whether ${action} finished. Refresh chats to reconcile before trying again.`;
      } finally {
        ui.effectBusy = false;
        m.redraw();
      }
    };
    const newChat = async () => {
      await effect({ type: 'session/reset' }, 'start a new chat', goToChat);
    };

    return m('.sessions-view', [
      m('.sessions-toolbar', [
        m('h2', 'Chats'),
        m('.spacer'),
        m('button', { disabled: ui.effectBusy || ui.effectUnconfirmed, onclick: newChat }, '+ New chat'),
      ]),

      ui.loading
        ? m('.placeholder', 'Loading…')
        : ui.error
        ? m('.placeholder', [
            m('p.error', ui.error),
            m('button', { disabled: ui.loading, onclick: () => loadList(ui, send) },
              ui.loading ? 'Refreshing…' : 'Refresh chats'),
          ])
        : visible.length === 0
        ? m('.placeholder', m('div', [
            m('p', 'No chats yet.'),
            m('p.muted', 'Start your first conversation.'),
            m('button', { disabled: ui.effectBusy || ui.effectUnconfirmed, onclick: newChat }, 'New chat'),
          ]))
        : m('ul.sessions-list', visible.map((s) =>
            m(SessionRow, {
              key: s.sessionId,
              session: s,
              active: s.sessionId === activeSessionId,
              disabled: ui.effectBusy || ui.effectUnconfirmed,
              onSwitch: async () => {
                await effect({ type: 'session/switch', sessionId: s.sessionId },
                  'switch chats', goToChat);
              },
              onArchive: async () => {
                await effect({ type: 'session/archive', sessionId: s.sessionId },
                  'archive this chat', () => { void loadList(ui, send); });
              },
            })
          )),
    ]);
  },
};

const SessionRow = {
  /**
   * @param {{ attrs: {
   *   session: SessionSummary,
 *   active: boolean,
 *   disabled: boolean,
   *   onSwitch: () => void,
   *   onArchive: () => void,
   * } }} vnode
   */
  view: ({ attrs: { session, active, disabled, onSwitch, onArchive } }) => {
    const title = session.title ?? 'Untitled chat';
    return m(`li.session-row${active ? '.active' : ''}`, [
      m('button.session-main', { disabled, onclick: onSwitch }, [
        m('.session-title', title),
        m('.session-meta', [
          m('span', formatRelative(session.lastMessageAt)),
          m('span', '·'),
          m('span', `${session.messageCount} msg${session.messageCount === 1 ? '' : 's'}`),
          session.model ? [m('span', '·'), m('code', session.model)] : null,
          // /system presence badge — monochrome chip; the instructions
          // themselves are viewable in-chat via the /system command.
          session.hasCustomSystemPrompt ? [
            m('span', '·'),
            m('span.session-sys-badge', {
              title: 'This chat has custom session instructions (/system)',
            }, '/system'),
          ] : null,
          // /tools manifest badge — same monochrome chip; the label says
          // WHICH manifest ('research', 'custom (3 tools)').
          session.toolManifestLabel ? [
            m('span', '·'),
            m('span.session-sys-badge', {
              title: `This chat exposes a narrowed toolset (/tools ${session.toolManifestLabel})`,
            }, `/tools ${session.toolManifestLabel}`),
          ] : null,
        ]),
      ]),
      m('button.session-archive', {
        title: 'Archive', disabled,
        onclick: (/** @type {Event} */ e) => { e.stopPropagation(); onArchive(); },
      }, '×'),
    ]);
  },
};

/** @param {number} when ms since epoch */
const formatRelative = (when) => {
  const diffMs = Date.now() - when;
  const secs = Math.round(diffMs / 1000);
  if (secs < 60) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(when).toLocaleDateString();
};
