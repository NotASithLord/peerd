// @ts-check
// Options → Activity: the origin-lock events must be readable.
//
// The #255 arc writes `origin_learned_sensitive` and `actor_origin_stop`, and
// those entries exist to answer the one question the learned set makes a user
// ask - "why did peerd refuse to open that site". Before this, neither type was
// in EVENT_META, so both rendered as a bare slug, and `detailLine` never read
// `details.origin` - so the row did not even say WHICH site.

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { ActivityView } from '/options/sections/activity.js';

/** @param {any[]} entries */
const mount = (entries) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const send = async (/** @type {any} */ msg) => (msg.type === 'audit/list'
    ? { ok: true, entries, total: entries.length }
    : { ok: true });
  m.mount(root, { view: () => m(ActivityView, { send }) });
  return { root, unmount: () => { m.mount(root, null); root.remove(); } };
};

const settle = () => new Promise((r) => setTimeout(r, 0)).then(() => m.redraw.sync?.() ?? m.redraw());

describe('options.activity — origin-lock events', () => {
  it('labels a learned host and names its protection scope', async () => {
    const { root, unmount } = mount([
      { id: '1', when: 1, type: 'origin_learned_sensitive', details: { host: 'bank.test', reason: 'password-field' } },
    ]);
    try {
      await settle();
      const text = root.textContent ?? '';
      expect(text.includes('origin_learned_sensitive')).toBe(false);   // no raw slug
      expect(text.includes('host may share browser session')).toBe(true);
      expect(text.includes('bank.test')).toBe(true);                   // WHICH host
      expect(text.includes('password-field')).toBe(true);              // and why
    } finally { unmount(); }
  });

  it('labels a helper stop and names where it was stopped', async () => {
    const { root, unmount } = mount([
      { id: '2', when: 2, type: 'actor_origin_stop', details: { action: 'handoff', to: 'https://bank.test', handoffTo: 'https://bank.test' } },
    ]);
    try {
      await settle();
      const text = root.textContent ?? '';
      expect(text.includes('web helper stopped')).toBe(true);
      expect(text.includes('https://bank.test')).toBe(true);
      expect(text.includes('handoff')).toBe(true);
    } finally { unmount(); }
  });

  it('labels an un-learn, and reads louder than the learn', async () => {
    // Removing a protection is the noisier event - same posture as the denylist
    // rows, where disabling a built-in pattern is a warn.
    const { root, unmount } = mount([
      { id: '3', when: 3, type: 'origin_unlearned_sensitive', details: { host: 'shop.test' } },
    ]);
    try {
      await settle();
      const text = root.textContent ?? '';
      expect(text.includes('learned host removed')).toBe(true);
      expect(text.includes('shop.test')).toBe(true);
    } finally { unmount(); }
  });

  it('an unknown type still renders rather than blanking the row', async () => {
    const { root, unmount } = mount([{ id: '4', when: 4, type: 'brand_new_event', details: {} }]);
    try {
      await settle();
      expect((root.textContent ?? '').includes('brand_new_event')).toBe(true);
    } finally { unmount(); }
  });
});
