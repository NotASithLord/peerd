// @ts-check
// Options → Costs — every dollars-and-tokens control in ONE place.
//
// A merge of three surfaces that were scattered across the panel:
// the cumulative usage line (the old Context header), the session
// spend limit (old Agent behavior), and the pricing-override table
// (old Advanced). Live per-turn metering stays in the panel's CostChip
// — this page is the global, between-chats view.

import m from '/vendor/mithril/mithril.js';
import { DEFAULT_PRICING } from '/peerd-provider/index.js';
import { resetRow } from './reset-row.js';

/** @typedef {import('./reset-row.js').Send} Send */

/** @param {number} n */
const fmtUsd = (n) => {
  const v = Number(n) || 0;
  if (v === 0) return '$0.00';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
};

/** @param {number} n */
const fmtTok = (n) => {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}k`;
  return `${(v / 1_000_000).toFixed(1)}M`;
};

export const CostsSection = {
  /** @param {{ state: any, attrs: { send: Send } }} vnode */
  oninit(vnode) {
    vnode.state.usage = null;
    vnode.attrs.send({ type: 'cost/total' }).then((/** @type {any} */ r) => {
      if (r?.ok) vnode.state.usage = { usd: r.usd, tokens: r.tokens, chats: r.chats };
      m.redraw();
    }).catch(() => {});
  },

  /** @param {{ attrs: { state: any, send: Send }, state: any }} vnode */
  view: ({ attrs: { state, send }, state: ui }) => {
    // Cost telemetry (feature 06). spendLimitUsd 0 = no hard limit.
    const spendLimitUsd = Number(state.settings?.spendLimitUsd) || 0;

    return m('div', [
      m('h3', 'Total usage'),
      m('p', 'Cumulative BYOK usage across every chat, computed locally '
        + 'from the built-in pricing table — usage never leaves your browser.'),
      ui.usage
        ? m('.logs-usage', [
            m('span.logs-usage-label', 'Total usage'),
            m('span.logs-usage-value',
              `${fmtUsd(ui.usage.usd)} · ${fmtTok(ui.usage.tokens)} tok${ui.usage.chats ? ` · ${ui.usage.chats} chat${ui.usage.chats === 1 ? '' : 's'}` : ''}`),
          ])
        : m('p.muted', 'Loading…'),

      m('.settings-divider'),
      m('h3', 'Spend limit'),
      m('p', 'Optional hard cap on per-session spend. When a conversation’s '
        + 'accumulated cost crosses this amount, peerd halts the agent mid-turn. '
        + 'Set to 0 (or blank) for no limit.'),
      m('div', { style: 'display:flex; gap:8px; align-items:center;' }, [
        m('span', { style: 'opacity:0.7;' }, '$'),
        m('input', {
          type: 'number', min: '0', step: '0.50', inputmode: 'decimal',
          style: 'width:120px;',
          'aria-label': 'Session spend limit in US dollars',
          value: spendLimitUsd > 0 ? String(spendLimitUsd) : '',
          placeholder: 'no limit',
          onchange: async (/** @type {{ target: HTMLInputElement }} */ e) => {
            const v = Number(e.target.value);
            await send({ type: 'settings/update', patch: { spendLimitUsd: Number.isFinite(v) && v > 0 ? v : 0 } });
            m.redraw();
          },
        }),
        spendLimitUsd > 0
          ? m('span.muted', { style: 'font-size:12px;' }, `Halts at $${spendLimitUsd} per session`)
          : m('span.muted', { style: 'font-size:12px;' }, 'No limit set'),
      ]),

      m('.settings-divider'),
      m(PricingOverrides, { state, send }),

      resetRow(send, ['spendLimitUsd', 'pricingOverrides']),
    ]);
  },
};

// ---- pricing overrides (cost telemetry, feature 06) ----------------------
//
// The built-in pricing table (peerd-provider/pricing.js) is a snapshot and
// drifts as vendors change prices. This editor lets the user paste a
// corrected rate card per model id WITHOUT waiting on an extension update.
// Overrides merge over the defaults; clearing a field reverts that model
// to the built-in rate. All LOCAL — these rates only feed the client-side
// dollar math; nothing is uploaded.
//
// Kept collapsed by default (most users never touch it). Rates are USD per
// 1,000,000 tokens to match how Anthropic + OpenRouter publish them.
/** @typedef {import('/peerd-provider/pricing.js').ModelRates} ModelRates */

/** @type {[keyof ModelRates, string][]} */
const RATE_FIELDS = [
  ['input', 'Input'],
  ['output', 'Output'],
  ['cacheRead', 'Cache read'],
  ['cacheWrite', 'Cache write'],
];

const PricingOverrides = {
  /** @param {{ state: any }} vnode */
  oninit(vnode) { vnode.state.open = false; },
  /** @param {{ attrs: { state: any, send: Send }, state: any }} vnode */
  view: ({ attrs: { state, send }, state: ui }) => {
    /** @type {Record<string, Partial<ModelRates>>} */
    const overrides = state.settings?.pricingOverrides ?? {};
    const overrideCount = Object.keys(overrides).length;
    // Show built-in models plus any override-only model ids the user added.
    const modelIds = [...new Set([
      ...Object.keys(DEFAULT_PRICING),
      ...Object.keys(overrides),
    ])];

    /**
     * @param {string} model
     * @param {keyof ModelRates} field
     * @param {string} raw
     */
    const setRate = async (model, field, raw) => {
      const next = { ...overrides };
      const card = { ...(next[model] ?? {}) };
      const v = Number(raw);
      if (raw === '' || !Number.isFinite(v) || v < 0) {
        // Empty/invalid → drop the override for this field (revert to default).
        delete card[field];
      } else {
        card[field] = v;
      }
      if (Object.keys(card).length > 0) next[model] = card;
      else delete next[model];
      await send({ type: 'settings/update', patch: { pricingOverrides: next } });
      m.redraw();
    };

    return m('div', [
      m('h3', { style: 'display:flex; align-items:center; gap:8px;' }, [
        'Model pricing',
        overrideCount > 0
          ? m('span.muted', { style: 'font-size:12px; font-weight:400;' }, `(${overrideCount} overridden)`)
          : null,
      ]),
      m('p', 'Rates used for the cost meter, in USD per 1M tokens. Override any '
        + 'value to correct stale pricing; leave blank to use the built-in '
        + 'default. Local only.'),
      m('button.secondary', {
        type: 'button',
        'aria-expanded': String(ui.open),
        onclick: () => { ui.open = !ui.open; m.redraw(); },
      }, ui.open ? 'Hide pricing table' : 'Edit pricing table'),
      ui.open
        ? m('.pricing-table', { style: 'margin-top:10px; display:flex; flex-direction:column; gap:10px;' },
            modelIds.map((model) => {
              const def = DEFAULT_PRICING[model] ?? {};
              const ovr = overrides[model] ?? {};
              return m('.pricing-row', { key: model, style: 'border:1px solid var(--border, #333); border-radius:6px; padding:8px;' }, [
                m('div', { style: 'font-family:monospace; font-size:12px; margin-bottom:6px;' }, model),
                m('div', { style: 'display:grid; grid-template-columns:repeat(2,1fr); gap:6px;' },
                  RATE_FIELDS.map(([field, label]) =>
                    m('label', { style: 'display:flex; flex-direction:column; font-size:11px; gap:2px;' }, [
                      m('span.muted', label),
                      m('input', {
                        type: 'number', min: '0', step: '0.01', inputmode: 'decimal',
                        style: 'width:100%;',
                        'aria-label': `${model} ${label} rate, USD per million tokens`,
                        value: ovr[field] !== undefined ? String(ovr[field]) : '',
                        placeholder: def[field] !== undefined ? String(def[field]) : '0',
                        onchange: (/** @type {{ target: HTMLInputElement }} */ e) => setRate(model, field, e.target.value),
                      }),
                    ])
                  )),
              ]);
            }))
        : null,
    ]);
  },
};
