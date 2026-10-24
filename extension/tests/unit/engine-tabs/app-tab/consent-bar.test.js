// @ts-check
// The App consent bar: an approve click counts only after the arming delay,
// while Deny and Escape answer at once. The element it makes inert gets focus
// back after the answer.
//
// why in-browser (not Bun): it builds real DOM and relies on the browser
// dropping clicks on a disabled button. why a test at all: a hostile App can
// draw a double-click target under the approve button and post its request on
// the first click; the second click used to approve it 50 ms after the bar
// appeared, with no automated guard on the timing.

import { describe, it, expect } from '../../../framework.js';
import { showConsentBar } from '../../../../engine-tabs/app-tab/consent-bar.js';

const sleep = (/** @type {number} */ ms) => new Promise((resolve) => setTimeout(resolve, ms));
const request = { appName: 'Probe', detail: 'open this external link: https://example.test/x', approveLabel: 'Open link' };

const openBar = () => {
  const bar = [...document.querySelectorAll('[role="alertdialog"]')]
    .find((el) => el.textContent?.includes('“Probe” wants to open this external link'));
  if (!(bar instanceof HTMLElement)) throw new Error('the consent bar did not render');
  /** @param {string} label */
  const button = (label) => {
    const found = [...bar.querySelectorAll('button')].find((el) => el.textContent === label);
    if (!found) throw new Error(`no ${label} button`);
    return found;
  };
  return { bar, approve: button('Open link'), deny: button('Deny') };
};

describe('App consent bar', () => {
  it('rejects early and repeated clicks, then accepts a deliberate approval', async () => {
    /** @type {boolean[]} */
    const answers = [];
    const answer = showConsentBar(request, { armDelayMs: 150 });
    answer.then((value) => answers.push(value));
    const { bar, approve } = openBar();
    approve.click();
    approve.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await sleep(20);
    expect(answers).toEqual([]);
    expect(document.body.contains(bar)).toBe(true);
    await sleep(200);
    approve.dispatchEvent(new MouseEvent('click', { detail: 2, bubbles: true }));
    await sleep(20);
    expect(answers).toEqual([]);
    expect(document.body.contains(bar)).toBe(true);
    approve.click();
    expect(await answer).toBe(true);
    expect(document.body.contains(bar)).toBe(false);
  });

  it('denies at once on Escape, even inside the arming delay', async () => {
    const answer = showConsentBar(request, { armDelayMs: 10_000 });
    const { bar } = openBar();
    bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(await answer).toBe(false);
    expect(document.body.contains(bar)).toBe(false);
  });

  it('denies at once on the Deny button, which holds focus by default', async () => {
    const answer = showConsentBar(request, { armDelayMs: 10_000 });
    const { bar, deny } = openBar();
    expect(document.activeElement).toBe(deny);
    deny.click();
    expect(await answer).toBe(false);
    expect(document.body.contains(bar)).toBe(false);
  });

  it('keeps the given element inert while open and lifts it before focus returns there', async () => {
    const app = document.createElement('button');
    document.body.appendChild(app);
    app.focus();
    try {
      const answer = showConsentBar(request, { armDelayMs: 10, inert: app });
      const { bar, deny } = openBar();
      expect(app.inert).toBe(true);
      deny.click();
      expect(await answer).toBe(false);
      expect(document.body.contains(bar)).toBe(false);
      expect(app.inert).toBe(false);
      expect(document.activeElement).toBe(app);
    } finally {
      app.remove();
    }
  });
});
