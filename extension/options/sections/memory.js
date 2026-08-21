// @ts-check
// Options → Memory — the agent's durable AGENTS.md memory, in one place.
//
// Ported from the Context view's Memory pane (user/project/subtree doc
// editors, the /init draft button, the pending auto-memory suggestions
// queue), PLUS the auto-memory on/off toggle relocated from the old
// "Agent behavior" section — the switch lives next to the queue it
// feeds. The USER can read and edit docs directly (origin:'user' →
// saved without a confirmation round-trip; the trifecta gate is for
// agent writes), see each scope's line count against the always-loaded
// budget, create a user note, run /init, and delete.
//
// /init starts an agent flow whose progress notes and draft-confirmation
// modal ride the PANEL port — the copy here says so honestly: open the
// peerd panel and watch the chat for the draft.

import m from '/vendor/mithril/mithril.js';
import { countLines, ALWAYS_LOADED_LINE_BUDGET } from '/peerd-runtime/index.js';
import { mutationFailureCopy } from '../mutation-custody.js';

/** @typedef {import('./reset-row.js').Send} Send */
/** @typedef {{ id?: string, kind: string, body?: string, workspace?: string, subpath?: string }} MemoryDoc */

export const MemoryView = {
  /** @param {{ state: any, attrs: { send: Send } }} vnode */
  oninit(vnode) {
    vnode.state.memoryDocs = null;
    vnode.state.suggestions = null;   // pending auto-memory suggestions
    vnode.state.memNote = null;       // { ok, text } banner for memory actions
    vnode.state.memBusy = false;
    vnode.state.memUncertain = false;
    vnode.state.autoMemoryBusy = false;
    vnode.state.autoMemoryUncertain = false;
    MemoryView.refresh(vnode);
  },

  /** @param {{ state: any, attrs: { send: Send } }} vnode */
  async refresh(vnode) {
    let docsOk = false;
    let suggestionsOk = false;
    const docs = vnode.attrs.send({ type: 'memory/export' }).then((/** @type {any} */ r) => {
      if (r?.ok) {
        docsOk = true;
        vnode.state.memoryDocs = orderDocs(r.payload?.docs ?? []);
      } else {
        if (vnode.state.memoryDocs === null) vnode.state.memoryDocs = [];
        vnode.state.memNote = { ok: false, text: 'Memory could not be loaded.' };
      }
      m.redraw();
    }).catch(() => {
      if (vnode.state.memoryDocs === null) vnode.state.memoryDocs = [];
      m.redraw();
    });
    // Pending auto-memory suggestions — the strip at the top of the
    // page (the count also feeds the badge on the Memory nav entry).
    const suggestions = vnode.attrs.send({ type: 'memory/suggestions' }).then((/** @type {any} */ r) => {
      if (r?.ok) {
        suggestionsOk = true;
        vnode.state.suggestions = r.suggestions ?? [];
      } else if (vnode.state.suggestions === null) vnode.state.suggestions = [];
      m.redraw();
    }).catch(() => {
      if (vnode.state.suggestions === null) vnode.state.suggestions = [];
      m.redraw();
    });
    await Promise.all([docs, suggestions]);
    return { docsOk, suggestionsOk };
  },

  /** @param {{ state: any, attrs: { state: any, send: Send, onSuggestionsChanged?: () => void } }} vnode */
  view(vnode) {
    const { state, send, onSuggestionsChanged } = vnode.attrs;
    const ui = vnode.state;
    const reload = () => MemoryView.refresh(vnode);

    // Run a one-shot memory action (init / new note / delete-all /
    // approve / dismiss), with a shared busy flag + result banner, then
    // refresh the doc list. onSuggestionsChanged keeps the options-nav
    // badge honest after approve/dismiss (the shell owns that count).
    /**
     * @param {{ type: string } & Record<string, any>} msg
     * @param {string} okText
     */
    const act = async (msg, okText) => {
      if (ui.memBusy || ui.memUncertain) return;
      ui.memBusy = true; ui.memNote = null; m.redraw();
      try {
        let r;
        try { r = await send(msg); }
        catch { r = { ok: false, outcomeKnown: false }; }
        const unknown = r?.outcomeKnown === false;
        ui.memUncertain = unknown;
        ui.memNote = r?.ok
          ? { ok: true, text: okText }
          : { ok: false, text: mutationFailureCopy(r, {
              action: 'changing memory', fallback: 'The memory change could not be completed.',
            }) };
        if (r?.ok || unknown) {
          const receipt = await reload();
          onSuggestionsChanged?.();
          if (r?.ok) ui.memUncertain = false;
          else if (msg.type !== 'memory/init' && receipt.docsOk && receipt.suggestionsOk) {
            ui.memUncertain = false;
            ui.memNote = { ok: false, text: 'The mutation receipt was lost. Current memory was refreshed; verify it before trying again.' };
          }
        }
      } finally {
        ui.memBusy = false;
        m.redraw();
      }
    };

    const docs = ui.memoryDocs;
    const hasUserDoc = Array.isArray(docs) && docs.some((/** @type {MemoryDoc} */ d) => d.kind === 'user');
    const suggestions = ui.suggestions ?? [];
    // Auto-memory defaults ON — absence of the key must not read as off.
    const autoMemoryOn = state?.settings?.autoMemoryEnabled !== false;

    return m('.memory-pane', [
      m('p.muted', { style: 'font-size:12px; margin:0 0 10px;' }, [
        'Durable ', m('code', 'AGENTS.md'), ' memory, loaded into every prompt. ',
        `User + project scopes are always loaded (≤${ALWAYS_LOADED_LINE_BUDGET} lines each); `,
        'subtree notes load on demand. Your edits here save directly — no confirmation.',
      ]),

      // Pending auto-memory suggestions. Proposed when a chat wraps up;
      // NOTHING is written until you approve a note here.
      suggestions.length > 0 ? m('.memory-suggestions', [
        m('p.muted', { style: 'font-size:12px; margin:0 0 6px;' },
          `Suggested while wrapping up recent chats — approve to add to your user memory, dismiss to drop. Nothing is saved without your OK.`),
        // why the wrapper div: keyed vnodes must not share a fragment
        // with the unkeyed intro paragraph (Mithril all-or-none rule).
        m('div', suggestions.map((/** @type {any} */ s) => m('.memory-suggestion', { key: s.id }, [
          m('.memory-suggestion-text', s.text),
          m('.memory-suggestion-meta', [
            s.sessionTitle ? m('span.muted', `from “${s.sessionTitle}”`) : m('span'),
            m('.spacer'),
            m('button', {
              disabled: ui.memBusy || ui.memUncertain,
              'aria-label': `Approve suggestion: ${s.text}`,
              onclick: () => act({ type: 'memory/suggestions/approve', id: s.id }, 'Added to user memory.'),
            }, 'Approve'),
            m('button.secondary', {
              disabled: ui.memBusy || ui.memUncertain,
              'aria-label': `Dismiss suggestion: ${s.text}`,
              onclick: () => act({ type: 'memory/suggestions/dismiss', id: s.id }, 'Suggestion dismissed.'),
            }, 'Dismiss'),
          ]),
        ]))),
      ]) : null,

      m('.memory-actions', [
        m('button.secondary', {
          disabled: ui.memBusy || ui.memUncertain,
          title: 'Scan the active workspace and draft a project AGENTS.md — the draft arrives in the peerd panel for you to confirm, so open the panel first',
          onclick: () => act({ type: 'memory/init' },
            '/init started — open the peerd panel and watch the chat for the draft to confirm.'),
        }, 'Draft project memory (/init)'),
        hasUserDoc ? null : m('button.secondary', {
          disabled: ui.memBusy || ui.memUncertain,
          onclick: () => act(
            { type: 'memory/write', scope: { kind: 'user' }, body: '# User memory\n\n- ' },
            'Created a user note — edit it below.'),
        }, 'New user note'),
        m('.spacer'),
        (Array.isArray(docs) && docs.length > 0) ? m('button.linkish.danger-text', {
          disabled: ui.memBusy || ui.memUncertain,
          onclick: () => {
            if (ui.memConfirmWipe) {
              act({ type: 'memory/deleteAll' }, 'All memory deleted.');
              ui.memConfirmWipe = false;
            } else { ui.memConfirmWipe = true; m.redraw(); }
          },
        }, ui.memConfirmWipe ? 'Click again to delete ALL' : 'Delete all') : null,
      ]),

      ui.memNote ? m(`p.key-msg${ui.memNote.ok ? '.ok' : '.err'}`, ui.memNote.text) : null,

      docs === null
        ? m('p.muted', 'Loading…')
        : docs.length === 0
          ? m('.memory-empty', m('p.muted',
              'No memory yet. Run /init to draft project notes from the active workspace, '
              + 'add a user note above, or just tell peerd to "remember" something in chat.'))
          : docs.map((/** @type {MemoryDoc} */ d) => m(MemoryDocCard, { key: d.id, doc: d, send, onChanged: reload })),

      // Auto-memory toggle — relocated from "Agent behavior": the
      // switch belongs next to the suggestion queue it feeds.
      m('.settings-divider'),
      m('h3', 'Auto-memory'),
      m('p', autoMemoryOn
        ? 'On. When a chat wraps up (you archive it or switch away after a real conversation), peerd makes one small background model call to propose durable notes about you and your ongoing work. Proposals appear above for your approval — nothing is ever saved without it. Calls respect the session spend limit (Costs page).'
        : 'Off. peerd never proposes memory notes from finished chats. You can still ask it to remember things, or edit memory directly on this page.'),
      m('div', { style: 'display:flex; gap:8px; align-items:center;' }, [
        m('button.secondary', {
          type: 'button',
          disabled: ui.autoMemoryBusy || ui.autoMemoryUncertain,
          onclick: async () => {
            if (ui.autoMemoryBusy || ui.autoMemoryUncertain) return;
            ui.autoMemoryBusy = true;
            try {
              let reply;
              try {
                reply = await send({
                  type: 'settings/update', patch: { autoMemoryEnabled: !autoMemoryOn },
                });
              } catch { reply = { ok: false, outcomeKnown: false }; }
              if (reply?.ok) ui.autoMemoryUncertain = false;
              else {
                ui.autoMemoryUncertain = reply?.outcomeKnown === false;
                ui.memNote = { ok: false, text: mutationFailureCopy(reply, {
                  action: 'changing auto-memory', fallback: 'Auto-memory could not be changed.',
                }) };
              }
            } finally {
              ui.autoMemoryBusy = false;
              m.redraw();
            }
          },
        }, ui.autoMemoryBusy ? '…' : autoMemoryOn ? 'Disable auto-memory' : 'Enable auto-memory'),
      ]),
      m('div', { style: 'margin-top:10px;' }, [
        m('button.secondary', {
          type: 'button',
          style: 'font-size:12px;',
          disabled: ui.autoMemoryBusy || ui.autoMemoryUncertain,
          onclick: async () => {
            if (ui.autoMemoryBusy || ui.autoMemoryUncertain) return;
            ui.autoMemoryBusy = true;
            try {
              let reply;
              try { reply = await send({ type: 'settings/reset', keys: ['autoMemoryEnabled'] }); }
              catch { reply = { ok: false, outcomeKnown: false }; }
              if (reply?.ok) ui.autoMemoryUncertain = false;
              else {
                ui.autoMemoryUncertain = reply?.outcomeKnown === false;
                ui.memNote = { ok: false, text: mutationFailureCopy(reply, {
                  action: 'resetting auto-memory', fallback: 'Auto-memory could not be reset.',
                }) };
              }
            } finally {
              ui.autoMemoryBusy = false;
              m.redraw();
            }
          },
        }, ui.autoMemoryBusy ? 'Saving…' : 'Reset section to defaults'),
      ]),
    ]);
  },
};

// Sort docs into a stable, human-sensible order: user first, then project,
// then subtree (deepest-pathed last), then anything else — so the always-
// loaded scopes sit at the top.
/** @type {Record<string, number>} */
const SCOPE_ORDER = { user: 0, project: 1, subtree: 2 };
/** @param {MemoryDoc[]} docs */
const orderDocs = (docs) => [...docs].sort((a, b) => {
  const ra = SCOPE_ORDER[a.kind] ?? 9;
  const rb = SCOPE_ORDER[b.kind] ?? 9;
  if (ra !== rb) return ra - rb;
  return String(a.subpath ?? '').localeCompare(String(b.subpath ?? ''));
});

// User + project docs are loaded into EVERY prompt, so they share the
// line budget. Subtree docs load on demand and don't.
/** @param {MemoryDoc} d */
const isAlwaysLoaded = (d) => d.kind === 'user' || d.kind === 'project';

/** @param {MemoryDoc} d */
const scopeLabel = (d) => {
  if (d.kind === 'user') return 'User · global';
  if (d.kind === 'project') return `Project · ${d.workspace || '—'}`;
  if (d.kind === 'subtree') return `Subtree · ${d.workspace || ''}${d.subpath ? `/${d.subpath}` : ''}`;
  return `${d.kind}${d.subpath ? ` · ${d.subpath}` : ''}`;
};

// One editable AGENTS.md doc. Keyed by doc.id so the instance (and its
// in-progress draft) survives list refreshes; after a save the parent
// re-fetches and doc.body matches the draft, so it reads as not-dirty.
const MemoryDocCard = {
  /** @param {{ state: any, attrs: { doc: MemoryDoc } }} vnode */
  oninit(vnode) {
    vnode.state.draft = vnode.attrs.doc.body ?? '';
    vnode.state.busy = false;
    vnode.state.uncertain = false;
    vnode.state.msg = null;
    vnode.state.confirmDelete = false;
  },
  /** @param {{ attrs: { doc: MemoryDoc, send: Send, onChanged?: () => any }, state: any }} vnode */
  view: ({ attrs: { doc, send, onChanged }, state: ui }) => {
    const dirty = ui.draft !== (doc.body ?? '');
    const lines = countLines(ui.draft);
    const budgeted = isAlwaysLoaded(doc);
    const over = budgeted && lines > ALWAYS_LOADED_LINE_BUDGET;
    const scope = { kind: doc.kind, workspace: doc.workspace, subpath: doc.subpath };

    const save = async () => {
      if (ui.busy || ui.uncertain || !dirty) return;
      ui.busy = true; ui.msg = null; m.redraw();
      try {
        let r;
        try { r = await send({ type: 'memory/write', scope, body: ui.draft }); }
        catch { r = { ok: false, outcomeKnown: false }; }
        const unknown = r?.outcomeKnown === false;
        ui.uncertain = unknown;
        ui.msg = r?.ok
          ? { ok: true, text: 'Saved.' }
          : { ok: false, text: mutationFailureCopy(r, {
              action: 'saving memory', fallback: 'Memory could not be saved.',
            }) };
        if (r?.ok || unknown) {
          const receipt = await onChanged?.();
          if (r?.ok) ui.uncertain = false;
          else if (receipt?.docsOk) {
            ui.uncertain = false;
            ui.msg = { ok: false, text: 'The save receipt was lost. Current memory was refreshed; verify it before trying again.' };
          }
        }
      } finally {
        ui.busy = false;
        m.redraw();
      }
    };

    const del = async () => {
      if (ui.busy || ui.uncertain) return;
      ui.busy = true; ui.msg = null; m.redraw();
      try {
        let r;
        try { r = await send({ type: 'memory/delete', scope }); }
        catch { r = { ok: false, outcomeKnown: false }; }
        const unknown = r?.outcomeKnown === false;
        ui.uncertain = unknown;
        if (r?.ok || unknown) {
          const receipt = await onChanged?.();
          if (r?.ok) ui.uncertain = false;
          else if (receipt?.docsOk) {
            ui.uncertain = false;
            ui.msg = { ok: false, text: 'The delete receipt was lost. Current memory was refreshed; verify it before trying again.' };
          }
        }
        if (!r?.ok && ui.uncertain) ui.msg = { ok: false, text: mutationFailureCopy(r, {
          action: 'deleting memory', fallback: 'Memory could not be deleted.',
        }) };
        else if (!r?.ok && !unknown) ui.msg = { ok: false, text: mutationFailureCopy(r, {
          action: 'deleting memory', fallback: 'Memory could not be deleted.',
        }) };
      } finally {
        ui.busy = false;
        m.redraw();
      }
    };

    return m('.memory-card', [
      m('.memory-card-head', [
        m('span.memory-scope', scopeLabel(doc)),
        m('.spacer'),
        m(`span.memory-lines${over ? '.is-over' : ''}`,
          budgeted ? `${lines} / ${ALWAYS_LOADED_LINE_BUDGET} lines` : `${lines} lines · on-demand`),
      ]),
      m('textarea.memory-editor', {
        value: ui.draft,
        spellcheck: false,
        // why: grow with content but cap so a long doc doesn't take over
        // the whole pane — the textarea scrolls past the cap.
        rows: Math.min(24, Math.max(5, lines + 1)),
        disabled: ui.busy || ui.uncertain,
        oninput: (/** @type {{ target: HTMLTextAreaElement }} */ e) => { ui.draft = e.target.value; },
      }),
      over ? m('p.memory-warn',
        `Over the ${ALWAYS_LOADED_LINE_BUDGET}-line always-loaded budget — trim it, or the loader truncates this scope.`) : null,
      m('.memory-card-actions', [
        m('button', { disabled: ui.busy || ui.uncertain || !dirty, onclick: save }, ui.busy ? '…' : 'Save'),
        dirty ? m('button.secondary', {
          disabled: ui.busy || ui.uncertain,
          onclick: () => { ui.draft = doc.body ?? ''; ui.msg = null; },
        }, 'Revert') : null,
        m('.spacer'),
        ui.confirmDelete
          ? m('span.memory-confirm', [
              m('span.muted', { style: 'font-size:12px;' }, 'Delete this scope?'),
              m('button.linkish.danger-text', { disabled: ui.busy || ui.uncertain, onclick: del }, 'Yes'),
              m('button.linkish', { disabled: ui.busy || ui.uncertain, onclick: () => { ui.confirmDelete = false; } }, 'No'),
            ])
          : m('button.linkish.danger-text', { disabled: ui.busy || ui.uncertain, onclick: () => { ui.confirmDelete = true; } }, 'Delete'),
      ]),
      ui.msg ? m(`p.key-msg${ui.msg.ok ? '.ok' : '.err'}`, ui.msg.text) : null,
    ]);
  },
};
