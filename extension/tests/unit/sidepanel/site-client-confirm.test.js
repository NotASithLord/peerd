// @ts-check
// A persistent site client is runnable code. Its forced confirmation must show
// the bytes and dossier the user is deciding to store.

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { ConfirmModal } from '/sidepanel/components/app.js';

/** @param {any} prompt @param {any} [uiActions] */
const mount = (prompt, uiActions) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  m.mount(root, { view: () => m(ConfirmModal, { prompt, uiActions }) });
  return { root, unmount: () => { m.mount(root, null); root.remove(); } };
};

const proposal = {
  op: 'create',
  body: 'return { currentOrder: async () => ({ ok: true }) };',
  bodyBytesBefore: 0,
  bodyBytesAfter: 48,
  dossier: {
    origin: 'https://shop.example',
    summary: 'Read the current order status.',
    endpoints: [{ method: 'GET', path: '/api/orders/:id' }],
    auth: 'session',
    deriver: 'capture-cdp',
  },
};

describe('sidepanel site-client confirmation', () => {
  it('shows the dossier and exact runnable code before approval', () => {
    const { root, unmount } = mount({
      id: 'site-confirm', kind: 'site_client_write', tool: 'site_client_write',
      proposal, origins: ['https://shop.example'],
    });
    try {
      expect(root.querySelector('h3')?.textContent).toBe('Confirm site client');
      expect(root.querySelector('[aria-label="Proposed site-client code"]')?.textContent).toBe(proposal.body);
      expect(root.querySelector('[aria-label="Proposed site-client endpoints"]')?.textContent).toBe('GET /api/orders/:id');
      expect(root.textContent.includes(proposal.dossier.summary)).toBe(true);
      expect(root.textContent.includes('a signed-in browser session was observed')).toBe(true);
      expect(root.textContent.includes('learned from observed site requests')).toBe(true);
      expect(root.textContent.includes('capture-cdp')).toBe(false);
      expect([...root.querySelectorAll('.peerd-modal-actions button')].map((button) => button.textContent))
        .toEqual(['Reject', 'Save client']);
    } finally { unmount(); }
  });

  it('makes deletion explicit without showing stale code', () => {
    const { root, unmount } = mount({
      id: 'site-delete', kind: 'site_client_write', tool: 'site_client_write',
      proposal: { ...proposal, op: 'delete', body: '', bodyBytesAfter: 0 },
      origins: ['https://shop.example'],
    });
    try {
      expect(root.querySelector('[aria-label="Site-client deletion"]')?.textContent.includes('deletes')).toBe(true);
      expect(root.querySelector('[aria-label="Proposed site-client code"]')).toBe(null);
      expect([...root.querySelectorAll('.peerd-modal-actions button')].map((button) => button.textContent))
        .toEqual(['Reject', 'Delete client']);
    } finally { unmount(); }
  });

  it('shows both code bodies and the endpoint delta for an update', () => {
    const { root, unmount } = mount({
      id: 'site-update', kind: 'site_client_write', tool: 'site_client_write',
      proposal: {
        ...proposal,
        op: 'update',
        prevBody: 'return { currentOrder: async () => null };',
        endpointDelta: { added: 1, removed: 2 },
      },
      origins: ['https://shop.example'],
    });
    try {
      expect(root.querySelector('[aria-label="Existing site-client code"]')?.textContent)
        .toBe('return { currentOrder: async () => null };');
      expect(root.querySelector('[aria-label="Proposed site-client code"]')?.textContent).toBe(proposal.body);
      expect(root.textContent.includes('Endpoints change by +1/-2.')).toBe(true);
    } finally { unmount(); }
  });

  it('keeps decisions reachable for the largest valid dossier', () => {
    const endpoints = Array.from({ length: 60 }, (_, index) => ({
      method: 'GET', path: `/api/orders/${String(index).padStart(2, '0')}/${'segment'.repeat(20)}`,
    }));
    const { root, unmount } = mount({
      id: 'site-large', kind: 'site_client_write', tool: 'site_client_write',
      proposal: {
        ...proposal,
        dossier: { ...proposal.dossier, summary: 'purpose '.repeat(500), endpoints },
      },
      origins: ['https://shop.example'],
    });
    try {
      const modal = /** @type {HTMLElement} */ (root.querySelector('.confirm-modal'));
      const actions = /** @type {HTMLElement} */ (root.querySelector('.peerd-modal-actions'));
      expect(modal.textContent.includes(endpoints[59]?.path ?? '')).toBe(true);
      expect([...actions.querySelectorAll('button')].map((button) => button.textContent))
        .toEqual(['Reject', 'Save client']);
    } finally { unmount(); }
  });

  it('owns focus, traps Tab, rejects on Escape, and restores prior focus', () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    /** @type {any[][]} */
    const answers = [];
    /** @param {...any} args */
    const confirmAnswer = (...args) => answers.push(args);
    const { root, unmount } = mount({
      id: 'site-a11y', kind: 'site_client_write', tool: 'site_client_write',
      proposal, origins: ['https://shop.example'],
    }, { confirmAnswer });
    try {
      const dialog = /** @type {HTMLElement} */ (root.querySelector('[role="dialog"]'));
      const buttons = /** @type {HTMLElement[]} */ ([...dialog.querySelectorAll('button')]);
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(dialog.getAttribute('aria-labelledby')).toBe('peerd-confirm-title');
      expect(document.activeElement).toBe(buttons[0]);
      buttons.at(-1)?.focus();
      buttons.at(-1)?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
      expect(document.activeElement).toBe(buttons[0]);
      dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(answers).toEqual([['site-a11y', 'no']]);
      // A live transcript redraw must not replace the saved opener with an
      // uninitialized lifecycle closure.
      m.redraw.sync();
    } finally {
      unmount();
      expect(document.activeElement).toBe(opener);
      opener.remove();
    }
  });
});
