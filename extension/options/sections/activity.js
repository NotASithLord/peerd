// @ts-check
// Options → Activity — the read-only window onto the audit spine.
//
// Ported from the Context view's Activity tab (EVENT_META + detailLine
// + the severity/free-text filters). The agent introspects the same log
// via inspect kind:'audit_log'; this is the human's view. Read-only on purpose
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
  semantic_report:            { label: 'semantic call completed', level: 'info' },
  authority_effect:           { label: 'authority effect',       level: 'info' },
  authority_effect_failed:    { label: 'authority effect failed', level: 'danger' },
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
  // The origin lock (#255). These are the entries that answer "why did peerd
  // refuse to open that site" - the exact question the learned set makes a user
  // ask - and without a label they rendered as a bare `origin_learned_sensitive`
  // slug with no origin attached. `origin_unlearned_sensitive` is written by the
  // Settings un-learn (#262); labelling it here is harmless before that lands,
  // since unknown types already fall back to a raw-label row.
  origin_learned_sensitive:   { label: 'host may share browser session', level: 'info' },
  origin_unlearned_sensitive: { label: 'learned host removed', level: 'warn' },
  actor_origin_stop:          { label: 'web helper stopped',     level: 'warn' },
  browser_child_navigation_blocked:
                              { label: 'protected child navigation blocked', level: 'warn' },
  browser_child_navigation_failed:
                              { label: 'child navigation control failed', level: 'warn' },
  browser_child_navigation_unverified:
                              { label: 'child destination not verified', level: 'warn' },
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

/** The exact host receipt decides authority severity; operation labels are
 * presentation only and never an allowlist. @param {AuditEntry} entry */
export const activityEventMeta = (entry) => {
  if (entry.details?.semantic === true) {
    if (entry.details.outcomeKnown === false || entry.details.outcome === 'unknown') {
      return { label: 'semantic call outcome unverified', level: 'danger' };
    }
    if (entry.details.outcome === 'performed') {
      return { label: 'host effect performed', level: 'ok' };
    }
    if (entry.details.outcome === 'performed-refused') {
      return { label: 'host effect partly performed', level: 'warn' };
    }
    if (entry.details.outcome === 'refused' || entry.details.outcome === 'semantic-failure') {
      return { label: 'semantic call failed', level: 'warn' };
    }
    if (entry.details.outcome === 'no-op') {
      return { label: 'semantic call completed; no host effect', level: 'info' };
    }
    return { label: 'semantic call completed', level: 'info' };
  }
  if (entry.type === 'authority_effect') {
    if (entry.details?.outcome === 'performed') {
      return { label: 'authority effect performed', level: 'ok' };
    }
    if (entry.details?.outcomeKnown === false || entry.details?.outcome === 'unknown') {
      return { label: 'authority effect unverified', level: 'danger' };
    }
    if (entry.details?.refused === true) {
      return { label: 'authority effect refused', level: 'warn' };
    }
    return { label: 'authority checked; no effect', level: 'info' };
  }
  if (entry.type === 'authority_effect_failed') {
    if (entry.details?.outcomeKnown === true) {
      return entry.details?.refused === true || entry.details?.outcome === 'not-performed'
        ? { label: 'authority effect refused', level: 'warn' }
        : { label: 'authority effect failed', level: 'warn' };
    }
    return { label: 'authority effect unverified', level: 'danger' };
  }
  return EVENT_META[entry.type] ?? { label: entry.type, level: 'info' };
};

/** @param {number} [ms] */
const fmtTime = (ms) => {
  // why the cast (not `ms ?? 0`): a missing timestamp must stay an
  // Invalid Date (matches the prior runtime), never coerce to the epoch.
  try { return new Date(/** @type {number} */ (ms)).toLocaleString(); }
  catch { return String(ms); }
};

/** @param {unknown} raw */
const browserPolicyDetail = (raw) => {
  const policy = /** @type {any} */ (raw);
  if (!policy || typeof policy !== 'object') return [];
  const reasonLabels = /** @type {Record<string, string>} */ ({
    private_network: 'private network blocked',
    cloud_metadata: 'cloud metadata blocked',
    sensitive_site: 'sensitive site blocked',
    unverified_target: 'document could not be verified',
    network_guard_unavailable: 'network guard unavailable',
    network_guard_unsupported: 'network guard unsupported',
    network_guard_install_failed: 'network guard failed',
    invalid_url: 'invalid address',
    unsupported_scheme: 'unsupported address type',
    child_guard_failed: 'child network guard failed',
    child_resume_failed: 'child navigation failed',
    child_destination_unverified: 'child destination not verified',
  });
  const outcomeLabels = /** @type {Record<string, string>} */ ({
    not_run: 'not run',
    unverified: 'outcome not verified',
    page_loaded_not_automated: 'page loaded, not automated',
  });
  const reason = typeof policy.reason === 'string' ? reasonLabels[policy.reason] : undefined;
  const outcome = typeof policy.outcome === 'string' ? outcomeLabels[policy.outcome] : undefined;
  const bits = [];
  if (reason) bits.push(reason);
  if (policy.stage === 'pre_navigation') bits.push('stopped before navigation');
  if (policy.stage === 'committed_origin') bits.push('stopped after navigation');
  if (outcome) bits.push(outcome);
  if (policy.child === 'closed') bits.push('child closed');
  if (policy.child === 'left_blank') bits.push('child left blank');
  if (policy.child === 'uncontained') bits.push('child control not confirmed');
  if (policy.guarded === true) bits.push('network guard active');
  if (policy.guarded === false) bits.push('network guard not confirmed');
  if (policy.neutralized === true) bits.push('tab reset');
  if (policy.neutralized === false) bits.push('tab reset not confirmed');
  if (policy.retryable === false) bits.push('do not retry');
  if (policy.retryable === true) bits.push('retry available');
  return bits;
};

/** @param {AuditEntry} entry */
const detailLine = (entry) => {
  const d = entry.details;
  if (!d || typeof d !== 'object') return '';
  // Keep it compact — tool name + the one or two fields that matter.
  const bits = [];
  if (d.tool) bits.push(d.tool);
  if (d.operation) bits.push(d.operation);
  if (d.outcome) bits.push(d.outcome);
  // why: hook audit events carry the hook id in details.id — show it the
  // way denylist events show their pattern.
  if (d.id) bits.push(d.id);
  if (d.gate) bits.push(`gate=${d.gate}`);
  // A learned host is the content of its row. `origin` remains for older audit
  // entries and for exact-origin events such as actor stops.
  if (d.host) bits.push(d.host);
  if (d.origin) bits.push(d.origin);
  if (d.reason) bits.push(d.reason);
  if (d.provider) bits.push(d.provider);
  if (d.primitive) bits.push(d.primitive);
  bits.push(...browserPolicyDetail(d.browserPolicy));
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
  // why: an origin-lock row without its origin is unreadable - "site treated as
  // yours" tells you nothing about WHICH site, and that is the whole content of
  // the event. `to` is already narrowed to an origin phrase by the report layer
  // (origin-lock-report.js originPhrase), so no path leaks in here.
  if (d.handoffTo) bits.push(`→ ${d.handoffTo}`);
  else if (d.to) bits.push(`→ ${d.to}`);
  if (d.action) bits.push(d.action);
  if (typeof d.count === 'number') bits.push(`${d.count} site(s)`);
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
      const meta = activityEventMeta(e);
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
            const meta = activityEventMeta(e);
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
