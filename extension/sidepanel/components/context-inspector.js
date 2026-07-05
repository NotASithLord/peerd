// @ts-check
// Context inspector — "what did the model actually see this turn?"
//
// A modal over the chat rendering the SW's live per-session snapshot
// ring: one entry per model call (orchestrator turns AND delegated
// actor/subagent calls), each showing the shaped request — clipped
// system prompt, message roster, tool names, params. This is the
// debugging view for the two hardest bug classes peerd has: compaction
// surprises ("why did it forget?") and fence regressions ("what
// exactly entered the context?").
//
// Dev-facing by design: the OPEN affordance is devMode-gated in the
// chat view (the normal user never sees actor plumbing), and the modal
// says plainly that the ring is SW-memory only — an empty list after a
// browser restart means "nothing captured yet", not "nothing ran".

import m from '/vendor/mithril/mithril.js';

/** @param {number} when */
const timeOf = (when) => new Date(when).toLocaleTimeString();

/** One snapshot as a collapsible block. */
const Snapshot = {
  /** @param {{ attrs: { snap: Record<string, any> } }} vnode */
  view: ({ attrs: { snap } }) => m('details.ctx-snap', [
    m('summary.ctx-snap-summary', [
      m('span.ctx-snap-label', snap.label),
      m('span.ctx-snap-meta',
        `${snap.provider}/${snap.model} · ${snap.messages.length} msgs`
        + `${snap.droppedMessages ? ` (+${snap.droppedMessages} older dropped)` : ''}`
        + ` · system ${Math.round((snap.systemChars ?? 0) / 1000)}k chars · ${timeOf(snap.when)}`),
    ]),
    m('.ctx-snap-body', [
      snap.tools?.length
        ? m('.ctx-snap-tools', `tools: ${snap.tools.join(', ')}`)
        : null,
      m('details.ctx-snap-system', [
        m('summary', 'system prompt (clipped)'),
        m('pre.ctx-pre', snap.system),
      ]),
      snap.messages.map((/** @type {Record<string, any>} */ msg, /** @type {number} */ i) =>
        m('.ctx-msg', { key: i }, [
          m('span.ctx-msg-role', msg.role),
          msg.content ? m('pre.ctx-pre', msg.content) : null,
          (msg.toolUses ?? []).map((/** @type {Record<string, any>} */ u) =>
            m('.ctx-msg-tool', `→ ${u.name} ${u.input}`)),
          (msg.toolResults ?? []).map((/** @type {Record<string, any>} */ r) =>
            m(`.ctx-msg-result${r.is_error ? '.failed' : ''}`, [
              m('span.ctx-msg-role', r.is_error ? 'result (error)' : 'result'),
              m('pre.ctx-pre', r.content),
            ])),
        ])),
    ]),
  ]),
};

/**
 * @typedef {{ snapshots: Array<Record<string, any>> | null, error?: string | null, onClose: () => void }} ContextInspectorAttrs
 */
export const ContextInspector = {
  /** @param {{ attrs: ContextInspectorAttrs }} vnode */
  view: ({ attrs: { snapshots, error = null, onClose } }) => m('.peerd-modal-backdrop', { onclick: onClose },
    m('.peerd-modal.context-inspector', { onclick: (/** @type {Event} */ e) => e.stopPropagation() }, [
      m('.ctx-header', [
        m('span.ctx-title', 'context inspector'),
        m('span.ctx-subtitle', 'what each model call carried, newest first'),
        m('.spacer'),
        m('button.ctx-close', { onclick: onClose, title: 'close' }, '✕'),
      ]),
      snapshots === null
        ? m('.ctx-empty', 'loading…')
        : error
          ? m('.ctx-empty', `couldn't read the snapshots: ${error}`)
          : snapshots.length === 0
          ? m('.ctx-empty',
              'No live snapshots for this chat. The ring holds the most recent model calls '
              + 'in the service worker\'s memory only — after a browser restart or worker '
              + 'eviction it starts empty. Send a message and reopen.')
          : [...snapshots].reverse().map((snap) => m(Snapshot, { snap, key: snap.seq })),
    ])),
};
