// @ts-check
// Settings CSS: a visible keyboard focus ring, and text in the -ink tokens.
//
// The toggle, select and "why" button drew focus as a box-shadow in --border
// (about 1.2:1 against the page: invisible, and none at all in forced-colors
// mode), and result lines used the fill tokens --ok and --danger (2.3:1 and
// 3.8:1 on the light theme). The two stylesheets are loaded into the runner
// for the duration of a test and removed again.

import { describe, it, expect } from '../../framework.js';

/** @param {string} href */
const loadSheet = (href) => new Promise((resolve, reject) => {
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.onload = () => resolve(link);
  link.onerror = () => reject(new Error(`stylesheet failed to load: ${href}`));
  document.head.appendChild(link);
});

/** @param {(sheets: CSSStyleSheet[]) => void | Promise<void>} fn */
const withSheets = async (fn) => {
  const links = await Promise.all([loadSheet('/sidepanel/styles.css'), loadSheet('/options/options.css')]);
  try { await fn(links.map((link) => /** @type {CSSStyleSheet} */ (link.sheet))); }
  finally { links.forEach((link) => link.remove()); }
};

/** @param {CSSStyleSheet} sheet @param {string} selector */
const ruleFor = (sheet, selector) => {
  const rule = [...sheet.cssRules]
    .find((r) => r instanceof CSSStyleRule && r.selectorText === selector);
  if (!(rule instanceof CSSStyleRule)) throw new Error(`missing rule: ${selector}`);
  return rule;
};

describe('options.settings-focus-contrast', () => {
  it('toggle, select and the why-button draw focus as a 2px solid outline', async () => {
    await withSheets(([, options]) => {
      for (const selector of ['.set-toggle:focus-visible', '.set-select:focus-visible', '.set-why:focus-visible']) {
        const rule = ruleFor(options, selector);
        expect(rule.style.outline).toContain('2px solid');
        expect(rule.style.outlineOffset).toBe('2px');
      }
    });
  });

  it('result lines, voice status and the key badge take their colour from the -ink tokens', async () => {
    await withSheets(() => {
      const probe = document.createElement('div');
      probe.className = 'options-page';
      probe.innerHTML = [
        '<p class="key-msg ok">ok</p>',
        '<p class="key-msg err">err</p>',
        '<span class="key-badge key-set">set</span>',
        '<div class="voice-section"><div class="voice-status is-ok">ok</div><div class="voice-status is-err">err</div></div>',
        '<span id="ok-ink" style="color: var(--ok-ink)">i</span>',
        '<span id="danger-ink" style="color: var(--danger-ink)">i</span>',
      ].join('');
      document.body.appendChild(probe);
      try {
        /** @param {string} sel */
        const color = (sel) => {
          const el = probe.querySelector(sel);
          if (!el) throw new Error(`missing probe: ${sel}`);
          return getComputedStyle(el).color;
        };
        const okInk = color('#ok-ink');
        const dangerInk = color('#danger-ink');
        expect(color('.key-msg.ok')).toBe(okInk);
        expect(color('.key-msg.err')).toBe(dangerInk);
        expect(color('.key-badge.key-set')).toBe(okInk);
        expect(color('.voice-status.is-ok')).toBe(okInk);
        expect(color('.voice-status.is-err')).toBe(dangerInk);
      } finally { probe.remove(); }
    });
  });
});
