// @ts-check
// The in-page activity pill, against a REAL DOM.
//
// The wording is covered by the pure test (tests/peerd-runtime/actor/
// activity-label.test.ts). What needs a browser is the property the whole design
// is built around: the pill must be INVISIBLE TO PEERD ITSELF. The agent reads
// the page it is driving, so an indicator it can see is one it will describe
// back to the user, and one it can click.
//
// That invisibility rests on three independent measures (aria-hidden, a CLOSED
// shadow root, and closed-shadow content being outside textContent). Each is
// asserted separately, because they can be broken one at a time and the failure
// is silent — the pill keeps looking right while quietly entering the agent's
// context.

import { describe, it, expect } from '../../framework.js';
import { domWalkInjected } from '/peerd-runtime/index.js';
import {
  activityOverlayInjected,
  clearActivityOverlayInjected,
  ACTIVITY_OVERLAY_ID,
} from '/peerd-runtime/dom/activity-overlay-injected.js';

/**
 * Run `fn` with a page fixture mounted, always tearing the pill down after.
 * @param {(host: HTMLDivElement) => void | Promise<void>} fn
 */
const withPage = async (fn) => {
  const host = document.createElement('div');
  host.id = 'activity-fixture';
  host.innerHTML = '<h1>Checkout</h1><p>Card number</p><button id="pay">Pay now</button>';
  document.body.appendChild(host);
  try { await fn(host); }
  finally { clearActivityOverlayInjected(); host.remove(); }
};

const overlay = () => document.getElementById(ACTIVITY_OVERLAY_ID);

describe('activity overlay — lifecycle', () => {
  it('mounts a pill and reports success', async () => {
    await withPage(() => {
      expect(overlay()).toBe(null);
      expect(activityOverlayInjected('Typing', 'https://acme.test')).toBe(true);
      expect(!!overlay()).toBe(true);
    });
  });

  it('is idempotent — a second call updates in place, it does not stack', async () => {
    await withPage(() => {
      activityOverlayInjected('Typing', 'https://acme.test');
      const first = overlay();
      activityOverlayInjected('Clicking', 'https://acme.test');
      expect(document.querySelectorAll(`#${ACTIVITY_OVERLAY_ID}`).length).toBe(1);
      // why identity and not just the count: re-creating the host would restart
      // the spinner animation on every tool call, which reads as a stutter.
      expect(overlay() === first).toBe(true);
    });
  });

  it('clear removes it, and is safe when nothing is mounted', async () => {
    await withPage(() => {
      activityOverlayInjected('Typing', 'https://acme.test');
      expect(clearActivityOverlayInjected()).toBe(true);
      expect(overlay()).toBe(null);
      expect(clearActivityOverlayInjected()).toBe(true);   // no-op, still true
    });
  });

  it('never throws, whatever it is handed', async () => {
    await withPage(() => {
      // An indicator must not be able to break the page it annotates.
      expect(activityOverlayInjected(/** @type {any} */ (null), /** @type {any} */ (undefined))).toBe(true);
      expect(activityOverlayInjected(/** @type {any} */ ({}), /** @type {any} */ (123))).toBe(true);
    });
  });
});

describe('activity overlay — invisible to peerd itself', () => {
  it('measure 1: the host is aria-hidden', async () => {
    await withPage(() => {
      activityOverlayInjected('Typing', 'https://acme.test');
      expect(/** @type {Element} */ (overlay()).getAttribute('aria-hidden')).toBe('true');
    });
  });

  it('measure 2: the shadow root is CLOSED (unreachable from outside)', async () => {
    await withPage(() => {
      activityOverlayInjected('Typing', 'https://acme.test');
      // An open root would hand the walk a way in via el.shadowRoot.
      expect(/** @type {Element} */ (overlay()).shadowRoot).toBe(null);
    });
  });

  it('measure 3: its text is NOT in the page textContent (read_page cannot see it)', async () => {
    await withPage(() => {
      activityOverlayInjected('Typing the card number', 'https://acme.test');
      const text = document.body.textContent || '';
      expect(text.includes('Typing the card number')).toBe(false);
      expect(text.includes('Stop')).toBe(false);
      // The real page content is of course still there.
      expect(text.includes('Card number')).toBe(true);
    });
  });

  it('the DOM walk does not emit a node for it', async () => {
    await withPage(() => {
      const before = domWalkInjected();
      activityOverlayInjected('Typing the card number', 'https://acme.test');
      const after = domWalkInjected();

      const serialized = JSON.stringify(after.nodes);
      expect(serialized.includes('Typing the card number')).toBe(false);
      expect(serialized.includes('peerd-activity-overlay')).toBe(false);
      // Load-bearing: the pill has a BUTTON in it. If the walk could see through
      // the shadow boundary, the agent would find a clickable "Stop" that is not
      // part of the page — and could click its own off switch.
      /** @param {ReturnType<typeof domWalkInjected>} out */
      const buttons = (out) => /** @type {any[]} */ (out.nodes)
        .filter((n) => n.role?.value === 'button')
        .map((n) => n.name?.value);
      expect(buttons(after).includes('Stop')).toBe(false);
      expect(JSON.stringify(buttons(after))).toBe(JSON.stringify(buttons(before)));
    });
  });

  it('the walk is otherwise UNCHANGED by the pill being up', async () => {
    // The strongest form of the claim: same page, same walk, pill or no pill.
    await withPage(() => {
      const before = domWalkInjected();
      activityOverlayInjected('Clicking', 'https://acme.test');
      const after = domWalkInjected();
      /** @param {ReturnType<typeof domWalkInjected>} out */
      const names = (out) => /** @type {any[]} */ (out.nodes).map((n) => n.name?.value ?? null);
      expect(JSON.stringify(names(after))).toBe(JSON.stringify(names(before)));
    });
  });
});
