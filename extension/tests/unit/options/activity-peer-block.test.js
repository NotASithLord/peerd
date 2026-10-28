// @ts-check
// Options → Activity: a block or an unblock made in Discover or Contacts must
// read in words and name the maker, as their short key does there.

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { ActivityView } from '/options/sections/activity.js';

const MAKER = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';

/** @param {{id:string, when:number, type:string, details:Record<string, unknown>}[]} entries */
const mount = (entries) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const send = async (/** @type {{type:string}} */ msg) => (msg.type === 'audit/list'
    ? { ok: true, entries, total: entries.length }
    : { ok: true });
  m.mount(root, { view: () => m(ActivityView, { send }) });
  return { root, unmount: () => { m.mount(root, null); root.remove(); } };
};

const settle = () => new Promise((r) => setTimeout(r, 0)).then(() => m.redraw.sync());

describe('options.activity - maker blocks', () => {
  it('labels a block and an unblock, names the maker by short key, and reads the unblock louder', async () => {
    const { root, unmount } = mount([
      { id: '1', when: 1, type: 'dweb_peer_blocked', details: { did: MAKER } },
      { id: '2', when: 2, type: 'dweb_peer_unblocked', details: { did: MAKER } },
    ]);
    try {
      await settle();
      const text = root.textContent ?? '';
      expect(text.includes('dweb_peer_blocked')).toBe(false);   // no raw slug
      expect(text.includes('dweb_peer_unblocked')).toBe(false);
      expect(text.includes('blocked a maker')).toBe(true);
      expect(text.includes('unblocked a maker')).toBe(true);
      // WHICH maker, by the key Discover and Contacts show.
      expect(text.includes(MAKER.slice(-8))).toBe(true);
      // An unblock removes a protection, so it reads louder than the block, as an un-learn does.
      expect(root.querySelectorAll('.log-dot.log-warn').length).toBe(1);
      expect(root.querySelectorAll('.log-dot.log-info').length).toBe(1);
    } finally { unmount(); }
  });
});
