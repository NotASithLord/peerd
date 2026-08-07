// @ts-check
// Options → Contributor Metrics. Human-only local consent and exact-byte
// preview; issue #345 intentionally has no upload action or collector origin.

import m from '/vendor/mithril/mithril.js';
import {
  CONTRIBUTOR_DISCLOSURE_VERSION, CONTRIBUTOR_SCHEMA_VERSION,
} from '/peerd-runtime/index.js';

/** @typedef {import('./reset-row.js').Send} Send */

export const ContributorMetricsSection = {
  /** @param {{ state: any, attrs: { send: Send } }} vnode */
  oninit(vnode) {
    vnode.state.status = null;
    vnode.state.busy = false;
    vnode.state.error = null;
    vnode.state.copied = false;
    ContributorMetricsSection.refresh(vnode);
  },

  /** @param {{ state: any, attrs: { send: Send } }} vnode */
  async refresh(vnode) {
    try {
      const reply = await vnode.attrs.send({ type: 'contributor/status' });
      vnode.state.status = reply?.ok ? reply.status : null;
      vnode.state.error = reply?.ok ? null : (reply?.error ?? 'status-unavailable');
    } catch (error) {
      vnode.state.error = /** @type {{ message?: string }} */ (error)?.message ?? 'status-unavailable';
    }
    m.redraw();
  },

  /** @param {{ state: any, attrs: { send: Send } }} vnode @param {'enable'|'disable'} action */
  async act(vnode, action) {
    vnode.state.busy = true;
    vnode.state.error = null;
    try {
      const reply = await vnode.attrs.send({ type: `contributor/${action}` });
      if (!reply?.ok) vnode.state.error = reply?.error ?? `${action}-failed`;
      else vnode.state.status = reply.status;
    } catch (error) {
      vnode.state.error = /** @type {{ message?: string }} */ (error)?.message ?? `${action}-failed`;
    } finally {
      vnode.state.busy = false;
      m.redraw();
    }
  },

  /** @param {{ state: any }} vnode */
  async copy(vnode) {
    const bytes = vnode.state.status?.bytes;
    if (typeof bytes !== 'string') return;
    try {
      await navigator.clipboard.writeText(bytes);
      vnode.state.copied = true;
      setTimeout(() => { vnode.state.copied = false; m.redraw(); }, 1200);
    } catch {
      vnode.state.error = 'Clipboard access failed. Select and copy the payload directly.';
    }
    m.redraw();
  },

  /** @param {{ state: any, attrs: { send: Send } }} vnode */
  view(vnode) {
    const ui = vnode.state;
    const status = ui.status;
    if (!status && !ui.error) return m('p.muted', 'Loading contributor status…');
    const enabled = status?.enabled === true;
    return m('.contributor-metrics', [
      m('.provider-card.contributor-disclosure', [
        m('h3', 'Optional, content-free contribution'),
        m('p', 'peerd works fully without Contributor Metrics. Nothing is collected until you press Enable below.'),
        m('p', [
          'If enabled, peerd locally aggregates web-actor technical outcomes: requested and resolved code/tool mode, ',
          'reviewed fallback and failure categories, coarse browser/version/channel, provider and known model family, bounded ',
          'turn/action/duration/token counters, and optional worked/didn’t-work votes.',
        ]),
        m('p', [m('strong', 'Never included in the exact contribution payload: '),
          'URLs, origins, hosts, page content, prompts, responses, selectors, search terms, form values, filenames, ',
          'raw errors, session/message/tool/install identifiers, timestamps, credentials, free-text feedback, or a stable user/device id.']),
        m('p', 'The local-only record also keeps a bounded set of consent-rotated opaque tokens for restart-safe deduplication and for associating a binary vote with its aggregate cohort. They contain no URL, origin, content, or raw session/message/tool identifier, never appear in the payload preview, and are deleted on Disable and clear.'),
        m('p', 'This local groundwork is for a preview/dev-only first rollout. This build has no upload client, endpoint, alarm, or network path.'),
        m('p', 'Disabling clears all local metrics, opaque tokens, and feedback. If a future upload is accepted, its aggregate server row has no identity that can link it back to you, so that row cannot be individually found or deleted. Any uploader still requires a separate transport, retention, and policy review plus this same current disclosure version; this build cannot send these bytes.'),
      ]),

      m('.provider-card', [
        m('.provider-card-main', [
          m('.provider-card-text', [
            m('.provider-card-name', status?.diagnostic
              ? 'Local state needs attention'
              : enabled ? 'Enabled locally' : 'Disabled'),
            m('.hint', [
              `Disclosure version ${status?.disclosureVersion ?? CONTRIBUTOR_DISCLOSURE_VERSION}; `,
              `payload schema version ${CONTRIBUTOR_SCHEMA_VERSION}.`,
            ]),
          ]),
        ]),
        m('.contributor-actions', enabled || status?.diagnostic
          ? m('button.secondary', {
              type: 'button', disabled: ui.busy,
              onclick: () => ContributorMetricsSection.act(vnode, 'disable'),
            }, ui.busy ? 'Clearing…' : 'Disable and clear')
          : m('button', {
              type: 'button', disabled: ui.busy,
              onclick: () => ContributorMetricsSection.act(vnode, 'enable'),
            }, ui.busy ? 'Enabling…' : 'Enable Contributor Metrics')),
      ]),

      ui.error ? m('p.error', ui.error) : null,
      status?.diagnostic
        ? m('.provider-card', [
            m('h3', 'Read-only local state'),
            m('p.error', 'This build found a newer or invalid Contributor Metrics record. It has not rewritten or deleted it. Update peerd or disable and clear it deliberately.'),
            m('code', status.diagnostic),
          ])
        : null,

      enabled ? m('.provider-card.contributor-preview', [
        m('.contributor-preview-head', [
          m('div', [
            m('h3', 'Exact pending payload'),
            m('p.hint', `${status.rowCount ?? 0} aggregate cohort row${status.rowCount === 1 ? '' : 's'}. These are the exact canonical bytes a later uploader would seal; this build cannot send them.`),
          ]),
          m('button.secondary', {
            type: 'button', disabled: typeof status.bytes !== 'string',
            onclick: () => ContributorMetricsSection.copy(vnode),
          }, ui.copied ? 'Copied' : 'Copy'),
        ]),
        m('textarea.contributor-payload', {
          readonly: true,
          spellcheck: false,
          'aria-label': 'Exact pending Contributor Metrics payload',
          value: status.bytes ?? '',
          onclick: (/** @type {MouseEvent & { currentTarget: HTMLTextAreaElement }} */ event) => event.currentTarget.select(),
        }),
      ]) : null,
    ]);
  },
};
