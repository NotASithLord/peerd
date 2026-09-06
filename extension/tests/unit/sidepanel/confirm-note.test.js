// @ts-check
// security-arc issue 242, the SEEN half: the confirmation card's optional note.
//
// Exact page authority can force a confirm the user never asked for on a UGC
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

  it('the note alone does not change the buttons', () => {
    const { root, unmount } = mount({ ...base, note: NOTE });
    try {
      const labels = [...root.querySelectorAll('.peerd-modal-actions button')].map((b) => b.textContent);
      // §4d: the session button says what it grants - the noun from the action
      // class (page_write has no dedicated noun → 'actions') and the true scope
      // (no origins on this prompt → the grant really is origin-blind).
      // textContent concatenates the verb and the scope line without a space.
      expect(labels).toEqual(['Reject', 'Allow all actionsthis chat, any site', 'Allow once']);
    } finally { unmount(); }
  });

  it('shows the exact target and action bound to an unknown-outcome approval', () => {
    const target = 'https://payments.example';
    const { root, unmount } = mount({
      ...base,
      note: 'A matching earlier action has an unknown outcome. Verify the target before approving this repeat.',
      lifecycleTarget: target,
      oneShot: true,
      tool: 'submit_payment',
      summary: 'submit_payment({ orderId: "order-7" })',
    });
    try {
      const claim = /** @type {HTMLElement} */ (
        root.querySelector('[aria-label="Unknown-outcome repeat approval"]')
      );
      const values = [...claim.querySelectorAll('code')].map((node) => node.textContent);
      expect(values).toEqual([target, 'submit_payment']);
      expect(claim.textContent.includes('Exact target')).toBe(true);
      expect(claim.textContent.includes('Action')).toBe(true);
      const buttons = [...root.querySelectorAll('.peerd-modal-actions button')];
      expect(buttons.map((button) => button.textContent)).toEqual(['Reject', 'Allow once']);
      expect(buttons[1].classList.contains('lifecycle-confirm-allow')).toBe(true);
    } finally { unmount(); }
  });

  it('an EPHEMERAL prompt drops "Allow for session" — a button that grants nothing', () => {
    // DESIGN-17 downgrades an actor's yes_session to yes_once server-side, so on
    // an actor confirm that button never created a standing grant. Before #242 a
    // default-config user never saw an actor confirm at all; now they see one
    // twice per comment, and a control that reads as "stop asking me" and
    // silently does nothing is worse than no control — they stop looking for a
    // real way out.
    const { root, unmount } = mount({ ...base, note: NOTE, ephemeral: true });
    try {
      const labels = [...root.querySelectorAll('.peerd-modal-actions button')].map((b) => b.textContent);
      expect(labels).toEqual(['Reject', 'Allow once']);
    } finally { unmount(); }
  });
});
