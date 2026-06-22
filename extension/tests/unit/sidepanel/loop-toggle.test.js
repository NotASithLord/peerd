// @ts-check
// LoopToggle — the mode-row entry point for the Ralph persistent loop. Until
// this control, a loop could only be launched via the undiscoverable `/loop`
// command; the toggle ARMS the next send to run as a loop (the InputBar then
// rewrites it onto the same /loop path and disarms). These tests pin the arm
// contract: an off pill, a click that reports the next armed boolean, the
// armed look (accent + aria-pressed), and the no-key disabled state.

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { LoopToggle } from '/sidepanel/components/mode-badge.js';

/**
 * Fake onToggle(): records the next-armed booleans the component reports.
 * @returns {((next: boolean) => void) & { calls: boolean[] }}
 */
const makeToggle = () => {
  /** @type {boolean[]} */
  const calls = [];
  return Object.assign(/** @param {boolean} next */ (next) => { calls.push(next); }, { calls });
};

/**
 * @param {{ armed?: boolean, disabled?: boolean, onToggle: (next: boolean) => void }} attrs
 */
const mount = (attrs) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  m.mount(root, { view: () => m(LoopToggle, attrs) });
  m.redraw.sync();
  return { root, unmount: () => { m.mount(root, null); root.remove(); } };
};

/**
 * @param {ParentNode} root
 * @returns {HTMLButtonElement}
 */
const needToggle = (root) => {
  const el = root.querySelector('.loop-toggle');
  if (!el) throw new Error('missing element: .loop-toggle');
  return /** @type {HTMLButtonElement} */ (el);
};

describe('LoopToggle (mode-row loop arming)', () => {
  it('renders an unarmed pill', () => {
    const { root, unmount } = mount({ onToggle: makeToggle() });
    try {
      const btn = needToggle(root);
      expect(btn.textContent).toBe('Loop');
      expect(btn.getAttribute('aria-pressed')).toBe('false');
      expect(btn.className.includes('is-on')).toBe(false);
      expect(btn.disabled).toBe(false);
    } finally { unmount(); }
  });

  it('clicking the unarmed pill reports onToggle(true)', () => {
    const onToggle = makeToggle();
    const { root, unmount } = mount({ onToggle });
    try {
      needToggle(root).click();
      expect(onToggle.calls).toEqual([true]);
    } finally { unmount(); }
  });

  it('armed pill shows the accent + aria-pressed and disarms on click', () => {
    const onToggle = makeToggle();
    const { root, unmount } = mount({ armed: true, onToggle });
    try {
      const btn = needToggle(root);
      expect(btn.textContent).toBe('Loop: on');
      expect(btn.getAttribute('aria-pressed')).toBe('true');
      expect(btn.className.includes('is-on')).toBe(true);
      btn.click();
      expect(onToggle.calls).toEqual([false]);
    } finally { unmount(); }
  });

  it('is disabled (and inert) with no API key', () => {
    const onToggle = makeToggle();
    const { root, unmount } = mount({ disabled: true, onToggle });
    try {
      const btn = needToggle(root);
      expect(btn.disabled).toBe(true);
      btn.click();  // disabled buttons don't fire
      expect(onToggle.calls.length).toBe(0);
    } finally { unmount(); }
  });
});
