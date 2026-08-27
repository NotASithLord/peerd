// @ts-check
// Options → Contributor Metrics. Human-only local consent and exact-byte
// preview; issue #345 intentionally has no upload action or collector origin.

import m from '/vendor/mithril/mithril.js';
import {
  CONTRIBUTOR_DISCLOSURE_VERSION, CONTRIBUTOR_SCHEMA_VERSION,
} from '/peerd-runtime/controller-contributor.js';
import { mutationFailureCopy, unknownMutationCopy } from '../mutation-custody.js';

/** @typedef {import('./reset-row.js').Send} Send */

export const ContributorMetricsSection = {
  /** @param {{ state: any, attrs: { send: Send } }} vnode */
  oninit(vnode) {
    vnode.state.status = null;
    vnode.state.busy = false;
    vnode.state.uncertain = false;
    vnode.state.pendingAction = null;
    vnode.state.error = null;
    vnode.state.copied = false;
    ContributorMetricsSection.refresh(vnode);
  },

  /** @param {{ state: any, attrs: { send: Send } }} vnode */
  async refresh(vnode) {
    try {
      const reply = await vnode.attrs.send({ type: 'contributor/status' });
      vnode.state.status = reply?.ok ? reply.status : null;
      if (!vnode.state.uncertain) {
        vnode.state.error = reply?.ok ? null : 'Contributor status is unavailable.';
      }
      m.redraw();
      return reply?.ok === true;
    } catch {
      vnode.state.error = 'Contributor status is unavailable.';
      m.redraw();
      return false;
    }
  },

  /** @param {{ state: any, attrs: { send: Send } }} vnode @param {'enable'|'disable'} action */
  async act(vnode, action) {
    if (vnode.state.busy
        || vnode.state.uncertain && vnode.state.pendingAction !== action) return;
    vnode.state.busy = true;
    vnode.state.error = null;
    try {
      let reply;
      try { reply = await vnode.attrs.send({ type: `contributor/${action}` }); }
      catch { reply = { ok: false, outcomeKnown: false }; }
      if (reply?.ok) {
        vnode.state.status = reply.status;
        vnode.state.uncertain = false;
        vnode.state.pendingAction = null;
        vnode.state.error = null;
      }
      else if (reply?.outcomeKnown === false) {
        const copy = unknownMutationCopy(`${action === 'enable' ? 'enabling' : 'disabling'} Contributor Metrics`);
        vnode.state.uncertain = true;
        vnode.state.pendingAction = action;
        vnode.state.error = copy;
        await ContributorMetricsSection.refresh(vnode);
        vnode.state.error = copy;
      } else {
        vnode.state.error = mutationFailureCopy(reply, {
          action: `${action === 'enable' ? 'enabling' : 'disabling'} Contributor Metrics`,
          fallback: 'Contributor Metrics could not be changed.',
        });
      }
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
    const action = ui.uncertain ? ui.pendingAction
      : enabled || status?.diagnostic ? 'disable' : 'enable';
    return m('.contributor-metrics', [
      m('.provider-card.contributor-disclosure', [
        m('h3', 'Optional, content-free contribution'),
        m('p', 'peerd works fully without Contributor Metrics. Nothing is collected until you press Enable below.'),
        m('h4', 'Included'),
        m('ul', [
          m('li', 'Requested and resolved code or tool mode, plus reviewed fallback and failure categories.'),
          m('li', 'Browser, extension version, channel, provider, and known model family.'),
          m('li', 'Bounded turn, action, duration, token, and optional worked or didn’t-work counts.'),
        ]),
        m('h4', 'Never included'),
        m('ul', [
          m('li', 'URLs, origins, hosts, page content, prompts, responses, selectors, search terms, form values, or filenames.'),
          m('li', 'Raw errors, credentials, free text, timestamps, stable user or device IDs, or session, message, tool, and install IDs.'),
        ]),
        m('p', 'Bounded local state uses consent-rotated opaque tokens for restart-safe deduplication and binary-vote grouping. The tokens contain no content or raw identifier, never appear in the payload preview, and are revoked immediately when you disable and clear metrics; interrupted physical cleanup resumes locally.'),
        m('p', 'This local groundwork is limited to preview and dev. This build has no upload client, endpoint, alarm, or network path.'),
        m('p', 'Disabling immediately makes all local metrics, tokens, and feedback unavailable and resumes deletion if browser storage was interrupted. A future accepted aggregate row would contain no identity, so it could not be linked back to you or individually deleted. Any uploader requires a separate transport, retention, and policy review and the current disclosure version.'),
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
        m('.contributor-actions', action === 'disable'
          ? m('button.secondary', {
              type: 'button', disabled: ui.busy,
              onclick: () => ContributorMetricsSection.act(vnode, 'disable'),
            }, ui.busy ? 'Clearing…' : ui.uncertain ? 'Retry disable and clear'
              : 'Disable and clear')
          : m('button', {
              type: 'button', disabled: ui.busy,
              onclick: () => ContributorMetricsSection.act(vnode, 'enable'),
            }, ui.busy ? 'Enabling…' : ui.uncertain ? 'Retry enable'
              : 'Enable Contributor Metrics')),
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
