// Render-only fixtures for real components with injected authority snapshots.
// Runtime consent, vault revocation, and stop receipts are separate E2E oracles.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evalIn, waitFor } from './e2e-harness.mjs';

const absentOnBase = (path, marker, rec) => {
  if (process.env.PEERD_VISUAL_BASE_RENDER !== '1') return false;
  const extension = process.argv.find(arg => arg.startsWith('--extension='))?.slice('--extension='.length);
  if (!extension) throw new Error('base visual render requires an explicit extension tree');
  const file = join(extension, path);
  if (existsSync(file) && (!marker || readFileSync(file, 'utf8').includes(marker))) return false;
  rec.observe('merge-base surface', { present: false, reason: 'component posture introduced on this branch' });
  return true;
};

const unmount = (page) => evalIn(page, `(async () => {
  const root = document.querySelector('#e2e-consent-lock');
  if (root) { (await import('/vendor/mithril/mithril.js')).default.mount(root, null); root.remove(); }
  delete window.__consentLockVisualCalls;
})()`, true);

const mount = (page, setup) => evalIn(page, `(async () => {
  const m = (await import('/vendor/mithril/mithril.js')).default;
  const root = document.createElement('div');
  root.id = 'e2e-consent-lock';
  root.style.cssText = 'position:fixed;inset:0;z-index:999;background:var(--bg);padding:14px;overflow:auto;';
  document.body.append(root);
  window.__consentLockVisualCalls = [];
  ${setup}
  m.redraw.sync();
})()`, true);

export const CONSENT_LOCK_VISUAL_STATES = [
  {
    name: 'onboarding-network-connecting', kind: 'visual', phase: 'pre-unlock', responder: null,
    async run(ctx, rec) {
      if (absentOnBase('sidepanel/components/onboarding-network-step.js', null, rec)) return;
      rec.observe('scope', 'actual component; persisted enabled choice and starting lease replies injected; no live network mutation');
      try {
        await mount(ctx.page, `
          const { PeerNetworkStep } = await import('/sidepanel/components/onboarding-network-step.js');
          const send = async message => {
            window.__consentLockVisualCalls.push(message);
            if (message.type !== 'bootstrap/ready') throw new Error('unexpected visual fixture request');
            return { ok: true, featureLeases: { leases: { dweb: { status: 'starting' } } } };
          };
          m.mount(root, { view: () => m('.onboarding-view', m('.card.onboarding-card',
            m(PeerNetworkStep, { enabled: true, send, onDone: () => {} }))) });
        `);
        const settled = await waitFor(() => evalIn(ctx.page, `(() => {
          const root = document.querySelector('#e2e-consent-lock');
          return root.querySelector('[role="status"]')?.textContent === 'Connecting to the peer network. You can continue.'
            && [...root.querySelectorAll('button')].filter(button => !button.disabled)
              .map(button => button.textContent).join('|') === 'Retry connection|Continue|Turn off';
        })()`), { budgetMs: 5000, pollMs: 50 });
        if (!settled) throw new Error('connecting controls did not reach their rendered state');
        rec.check('starting transport leaves Continue and Turn off usable', settled);
        rec.check('render reads status without granting participation', await evalIn(ctx.page,
          `window.__consentLockVisualCalls.length > 0 && window.__consentLockVisualCalls.every(message => message.type === 'bootstrap/ready')`));
        await rec.visual('onboarding-network-connecting');
      } finally { await unmount(ctx.page); }
    },
  },
  ...['pending', 'unconfirmed', 'restart-required'].map(cleanup => ({
    name: `vault-cleanup-${cleanup}`, kind: 'visual', phase: 'pre-unlock', responder: null,
    async run(ctx, rec) {
      if (absentOnBase('sidepanel/components/vault-gate.js', 'state.vault.lockCleanup', rec)) return;
      rec.observe('scope', 'actual VaultGate with injected locked cleanup snapshot; runtime receipt proof is separate');
      try {
        await mount(ctx.page, `
          const { VaultGate } = await import('/sidepanel/components/vault-gate.js');
          const state = { hydrated: true, settings: { vaultAutoLockMs: 0 }, vault: {
            initialized: true, locked: true, prfEnrolled: false, hasRecovery: true,
            unlockedAt: 0, lockReason: 'manual', lockCleanup: ${JSON.stringify(cleanup)},
          } };
          m.mount(root, { view: () => m(VaultGate, { state, send: async message => {
            window.__consentLockVisualCalls.push(message); return { ok: false };
          } }) });
        `);
        const expected = cleanup === 'pending' ? 'Vault locked. Stopping active features…'
          : cleanup === 'restart-required' ? 'Vault locked. Voice shutdown could not be confirmed. Fully quit and restart your browser before unlocking.'
          : 'Vault locked. Feature shutdown could not be confirmed.';
        const settled = await waitFor(() => evalIn(ctx.page, `(() => {
          const root = document.querySelector('#e2e-consent-lock');
          return root.querySelector('[role="status"]')?.textContent === ${JSON.stringify(expected)}
            && !root.querySelector('input[type="password"]')
            && [...root.querySelectorAll('button')].map(button => button.textContent).join('|')
              === ${JSON.stringify(cleanup === 'unconfirmed' ? 'Retry shutdown' : '')};
        })()`), { budgetMs: 5000, pollMs: 50 });
        if (!settled) throw new Error(`vault ${cleanup} posture did not render`);
        rec.check('locked cleanup shows truthful warning and no unlock control', settled);
        rec.check('render sends no authority mutations', await evalIn(ctx.page, 'window.__consentLockVisualCalls.length === 0'));
        await rec.visual(`vault-cleanup-${cleanup}`);
      } finally { await unmount(ctx.page); }
    },
  })),
];
