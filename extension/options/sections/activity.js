// @ts-check
// Options → Activity — the read-only window onto the audit spine.
//
// Ported from the Context view's Activity tab (EVENT_META + detailLine
// + the severity/free-text filters). The agent introspects the same log
// via inspect_audit_log; this is the human's view. Read-only on purpose
// — the audit log is append-only evidence, not a management surface.

import m from '/vendor/mithril/mithril.js';

/** @typedef {import('./reset-row.js').Send} Send */
/** @typedef {{ id?: string, type: string, when?: number, sessionId?: string, details?: any }} AuditEntry */

// Map audit event types to a short label + a severity class for the dot.
/** @type {Record<string, { label: string, level: string }>} */
const EVENT_META = {
  egress_denied:              { label: 'egress denied',         level: 'warn' },
  denylist_hit:               { label: 'denylist hit',          level: 'warn' },
  denylist_added:             { label: 'denylist pattern added', level: 'ok' },
  denylist_removed:           { label: 'denylist pattern removed', level: 'warn' },
  hook_added:                 { label: 'hook added',            level: 'ok' },
  hook_removed:               { label: 'hook removed',          level: 'warn' },
  hook_enabled:               { label: 'hook enabled',          level: 'ok' },
  hook_disabled:              { label: 'hook disabled',         level: 'warn' },
  hooks_cleared:              { label: 'user hooks cleared',    level: 'warn' },
  tool_blocked:               { label: 'tool blocked',          level: 'warn' },
  tool_rejected:              { label: 'action rejected',       level: 'warn' },
  prompt_injection_suspected: { label: 'injection suspected',   level: 'danger' },
  tool_failed:                { label: 'tool failed',           level: 'danger' },
  tool_confirmed:             { label: 'action confirmed',      level: 'ok' },
  tool_executed:              { label: 'tool ran',              level: 'ok' },
  vault_initialized:          { label: 'vault created',         level: 'ok' },
  vault_unlocked:             { label: 'vault unlocked',        level: 'ok' },
  vault_locked:               { label: 'vault locked',          level: 'info' },
  provider_added:             { label: 'provider key set',      level: 'info' },
  mode_changed:               { label: 'permission changed',    level: 'info' },
  session_started:            { label: 'session started',       level: 'info' },
  session_ended:              { label: 'session ended',         level: 'info' },
  auto_memory_suggested:      { label: 'memory suggested',      level: 'info' },
  auto_memory_skipped:        { label: 'memory extraction skipped', level: 'info' },
  memory_suggestion_approved: { label: 'memory suggestion approved', level: 'ok' },
  memory_suggestion_dismissed:{ label: 'memory suggestion dismissed', level: 'info' },
  trim_summary_enriched:      { label: 'history summary updated', level: 'info' },
  cheap_call_skipped:         { label: 'background call skipped', level: 'info' },
  // dweb (preview-only) — the high-signal, user-facing events. Internal
  // mesh/gossip diagnostics carry the dweb_ prefix too and fall back to a
  // raw-label/info row (the `?? { label: e.type, level: 'info' }` below).
  dweb_identity_issued:       { label: 'dweb identity issued',   level: 'ok' },
  dweb_room_joined:           { label: 'joined a dweb room',     level: 'ok' },
  dweb_room_left:             { label: 'left a dweb room',       level: 'info' },
  dweb_app_installed:         { label: 'installed a dweb app',   level: 'ok' },
  dweb_seed_installed:        { label: 'commons app installed',  level: 'ok' },
  dweb_app_shared:            { label: 'shared an app to a room', level: 'ok' },
  dweb_bridge_join_denied:    { label: 'dweb room join denied',  level: 'warn' },
  dweb_app_install_denied:    { label: 'dweb app install denied', level: 'warn' },
  dweb_peer_muted_by_app:     { label: 'muted a dweb peer',      level: 'info' },
};

/** @param {number} [ms] */
const fmtTime = (ms) => {
  // why the cast (not `ms ?? 0`): a missing timestamp must stay an
  // Invalid Date (matches the prior runtime), never coerce to the epoch.
  try { return new Date(/** @type {number} */ (ms)).toLocaleString(); }
  catch { return String(ms); }
};

/** @param {AuditEntry} entry */
const detailLine = (entry) => {
  const d = entry.details;
  if (!d || typeof d !== 'object') return '';
  // Keep it compact — tool name + the one or two fields that matter.
  const bits = [];
  if (d.tool) bits.push(d.tool);
  // why: hook audit events carry the hook id in details.id — show it the
  // way denylist events show their pattern.
  if (d.id) bits.push(d.id);
  if (d.gate) bits.push(`gate=${d.gate}`);
  if (d.reason) bits.push(d.reason);
  if (d.provider) bits.push(d.provider);
  if (d.primitive) bits.push(d.primitive);
  if (d.answer) bits.push(`answer=${d.answer}`);
  if (d.pattern) bits.push(d.pattern);
  // why: denylist events flag seed provenance — disabling built-in
  // protection should read louder than removing your own pattern.
  if (d.seed === true) bits.push('built-in');
  // mode_changed entries: new records carry confirmActions (booleans —
  // check typeof, not truthiness); pre-collapse audit entries carry a
  // tier string. Render both forever — the audit log is append-only.
  if (d.mode) {
    if (typeof d.confirmActions === 'boolean') {
      bits.push(`${d.mode}/${d.confirmActions ? 'confirm' : 'auto'}`);
    } else {
      bits.push(d.tier ? `${d.mode}/${d.tier}` : d.mode);
    }
  }
  if (typeof d.durationMs === 'number') bits.push(`${d.durationMs}ms`);
  return bits.join(' · ');
};

export const ActivityView = {
  /** @param {{ state: any, attrs: { send: Send } }} vnode */
  oninit(vnode) {
    vnode.state.entries = null;
    vnode.state.total = 0;
    vnode.state.actLevel = 'all';     // severity filter: all|warn|ok|info
    vnode.state.actQuery = '';        // free-text filter
    vnode.state.error = null;
    ActivityView.refresh(vnode);
  },

  /** @param {{ state: any, attrs: { send: Send } }} vnode */
  refresh(vnode) {
    vnode.attrs.send({ type: 'audit/list' }).then((/** @type {any} */ r) => {
      if (r?.ok) { vnode.state.entries = r.entries; vnode.state.total = r.total; }
      else { vnode.state.error = r?.error ?? 'failed to load log'; }
      m.redraw();
    }).catch((/** @type {unknown} */ e) => {
      vnode.state.error = /** @type {{ message?: string }} */ (e)?.message ?? 'failed to load log';
      m.redraw();
    });
  },

  /** @param {{ state: any, attrs: { send: Send } }} vnode */
  view(vnode) {
    const ui = vnode.state;

    const header = m('div', { style: 'display:flex; align-items:center; gap:8px; margin:0 0 8px;' }, [
      m('p.muted', { style: 'margin:0; font-size:12px;' },
        ui.total ? `${ui.total} recorded event${ui.total === 1 ? '' : 's'}` : ''),
      m('.spacer', { style: 'flex:1;' }),
      m('button.icon', { title: 'Refresh', onclick: () => ActivityView.refresh(vnode) }, '↻'),
    ]);

    if (ui.error) return m('div', [header, m('p.error', ui.error)]);
    if (ui.entries === null) return m('div', [header, m('p.muted', 'Loading…')]);
    if (ui.entries.length === 0) return m('div', [header, m('p.muted', 'No activity recorded yet.')]);

    // Client-side filters over the already-fetched window: a severity
    // selector + a free-text needle across label / detail / type /
    // sessionId. The fetch itself stays unfiltered so flipping filters
    // is instant.
    const q = ui.actQuery.trim().toLowerCase();
    const shown = ui.entries.filter((/** @type {AuditEntry} */ e) => {
      const meta = EVENT_META[e.type] ?? { label: e.type, level: 'info' };
      if (ui.actLevel === 'warn' && meta.level !== 'warn' && meta.level !== 'danger') return false;
      if (ui.actLevel === 'ok' && meta.level !== 'ok') return false;
      if (ui.actLevel === 'info' && meta.level !== 'info') return false;
      if (!q) return true;
      const hay = `${meta.label} ${detailLine(e)} ${e.type} ${e.sessionId ?? ''}`.toLowerCase();
      return hay.includes(q);
    });

    return m('div', [
      header,
      m('.log-filters', [
        m('select.log-filter-level', {
          'aria-label': 'Filter by severity',
          value: ui.actLevel,
          onchange: (/** @type {{ target: HTMLSelectElement }} */ e) => { ui.actLevel = e.target.value; },
        }, [
          m('option', { value: 'all' }, 'All events'),
          m('option', { value: 'warn' }, 'Issues (blocked / denied / failed)'),
          m('option', { value: 'ok' }, 'Actions that ran'),
          m('option', { value: 'info' }, 'System'),
        ]),
        m('input.log-filter-query', {
          type: 'search',
          placeholder: 'Filter… (tool, origin, session)',
          'aria-label': 'Filter activity text',
          value: ui.actQuery,
          oninput: (/** @type {{ target: HTMLInputElement }} */ e) => { ui.actQuery = e.target.value; },
        }),
      ]),
      shown.length === 0
        ? m('p.muted', 'Nothing matches the current filter.')
        : m('.log-list', shown.map((/** @type {AuditEntry} */ e) => {
            const meta = EVENT_META[e.type] ?? { label: e.type, level: 'info' };
            const detail = detailLine(e);
            return m('.log-row', { key: e.id }, [
              m(`span.log-dot.log-${meta.level}`),
              m('.log-main', [
                m('.log-line', [
                  m('span.log-label', meta.label),
                  detail ? m('span.log-detail', detail) : null,
                ]),
                m('.log-time', fmtTime(e.when)),
              ]),
            ]);
          })),
    ]);
  },
};
