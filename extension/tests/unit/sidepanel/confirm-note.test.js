// @ts-check
// security-arc issue 242, the SEEN half: the confirmation card's optional note.
//
// The dispatcher can now force a confirm the user never asked for — on a UGC
// zone, with confirmations turned OFF. A prompt that appears unexplained, in a
// posture where the user believes they disabled prompting, reads as a bug and
// gets dismissed. The note is the whole answer to "why am I being asked": one
// plain sentence, ABOVE the call summary, because it is the part that has to be
// weighed rather than the detail.
//
// The two claims worth a test are symmetric: the note renders where it belongs
// when present, and the ordinary card is byte-for-byte what it always was when
// it is absent. The second matters as much as the first — this is the most
// frequently seen modal in the product.

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { ConfirmModal } from '/sidepanel/components/app.js';

/** @param {any} prompt */
const mount = (prompt) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  m.mount(root, { view: () => m(ConfirmModal, { prompt }) });
  return { root, unmount: () => { m.mount(root, null); root.remove(); } };
};

const base = {
  id: 'c1', tool: 'click', summary: 'click(selector="#comment-submit")',
  sideEffect: 'write', actionClass: 'page_write',
};

const NOTE = 'This page can be written by other people, and this action uses your signed-in access.';

describe('sidepanel.confirm note (issue 242)', () => {
  it('renders the note above the call summary when one is supplied', () => {
    const { root, unmount } = mount({ ...base, note: NOTE });
    try {
      const modal = /** @type {HTMLElement} */ (root.querySelector('.confirm-modal'));
      expect(modal.textContent.includes(NOTE)).toBe(true);
      // Order is the point: a reason printed under the summary is a reason
      // read after the decision.
      const noteEl = [...modal.querySelectorAll('p.muted')].find((p) => p.textContent === NOTE);
      const summary = /** @type {HTMLElement} */ (modal.querySelector('pre.confirm-summary'));
      expect(!!noteEl).toBe(true);
      expect(
        !!(/** @type {HTMLElement} */ (noteEl).compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING),
      ).toBe(true);
      // The summary still carries the actual call — the note explains, it does
      // not replace.
      expect(summary.textContent.includes('#comment-submit')).toBe(true);
    } finally { unmount(); }
  });

  it('an ordinary confirm renders exactly one explanatory line — no empty slot', () => {
    const { root, unmount } = mount({ ...base });
    try {
      const modal = /** @type {HTMLElement} */ (root.querySelector('.confirm-modal'));
      const lines = [...modal.querySelectorAll('p.muted')].map((p) => p.textContent);
      expect(lines.length).toBe(1);
      expect(lines[0].startsWith('The agent wants to run')).toBe(true);
    } finally { unmount(); }
  });

  it('the answer buttons are unchanged by the note — the decision stays the same three', () => {
    // A forced confirm must not quietly remove "Allow for session"; the session
    // downgrade for actors happens in the grant cache, not by hiding the button.
    const { root, unmount } = mount({ ...base, note: NOTE });
    try {
      const labels = [...root.querySelectorAll('.peerd-modal-actions button')].map((b) => b.textContent);
      expect(labels).toEqual(['Reject', 'Allow for session', 'Allow once']);
    } finally { unmount(); }
  });
});
