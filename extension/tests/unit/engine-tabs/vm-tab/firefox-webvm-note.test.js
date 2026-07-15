// @ts-check
// The Firefox WebVM-unavailable notice — a pure DOM builder.
//
// why in-browser (not Bun): it builds real DOM. why a test at all: the vm-tab
// boot path this renders on is unreachable in CI (the e2e harness runs Chrome,
// where isolation is on), so this is the ONLY automated guard that the two
// links still point at the real Firefox bug + W3C standards thread — the whole
// point of the notice. If someone edits a URL, this catches it in the terminal.

import { describe, it, expect } from '../../../framework.js';
import {
  buildFirefoxWebVmNote,
  FIREFOX_WEBVM_BUG,
  W3C_WEBEXT_ISSUES,
} from '/engine-tabs/vm-tab/firefox-webvm-note.js';

describe('buildFirefoxWebVmNote', () => {
  it('names WebVM + Firefox and frames it as a platform limit, not a peerd bug', () => {
    const note = buildFirefoxWebVmNote();
    const text = note.textContent ?? '';
    expect(note.className).toBe('boot-firefox-note');
    expect(text).toContain('WebVM');
    expect(text).toContain('Firefox');
    expect(text).toContain('SharedArrayBuffer');
    expect(text).toContain('not a peerd');
  });

  it('links BOTH open threads — the Firefox bug and the W3C standards issue', () => {
    const note = buildFirefoxWebVmNote();
    const hrefs = [...note.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs.length).toBe(2);
    expect(hrefs).toContain(FIREFOX_WEBVM_BUG);
    expect(hrefs).toContain(W3C_WEBEXT_ISSUES);
    // the exact Bugzilla bug + the standards repo, pinned so a typo can't slip
    expect(FIREFOX_WEBVM_BUG).toBe('https://bugzilla.mozilla.org/show_bug.cgi?id=1673477');
    expect(W3C_WEBEXT_ISSUES).toBe('https://github.com/w3c/webextensions/issues');
  });

  it('opens links in a new tab safely (target + noopener rel)', () => {
    const note = buildFirefoxWebVmNote();
    for (const a of note.querySelectorAll('a')) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toContain('noopener');
    }
  });

  it('honors injected URLs (so the wiring is testable without the real page)', () => {
    const note = buildFirefoxWebVmNote({ bugUrl: 'https://x.test/bug', w3cUrl: 'https://x.test/w3c' });
    const hrefs = [...note.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toContain('https://x.test/bug');
    expect(hrefs).toContain('https://x.test/w3c');
  });
});
