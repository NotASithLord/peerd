// The words the in-page activity pill puts on the user's screen.
//
// Most of this file is not about wording, it is about what must NEVER reach that
// surface. The pill is rendered into the page the agent is driving, which means
// it is on the user's monitor, in front of whoever is looking over their
// shoulder, and inside any screen share or recording. Two classes of input reach
// it — the model's tool args and, through them, page-authored content — and both
// are pinned shut here.

import { describe, test, expect } from 'bun:test';
import { describeToolActivity, displayOrigin, GENERIC_ACTIVITY } from '../../../extension/peerd-runtime/actor/activity-label.js';

describe('activity-label — the wording', () => {
  test('navigation names the destination HOST', () => {
    expect(describeToolActivity('navigate', { url: 'https://github.com/anthropics/x' }))
      .toBe('Opening github.com');
    expect(describeToolActivity('open_tab', { url: 'https://en.wikipedia.org/wiki/Cat' }))
      .toBe('Opening en.wikipedia.org');
  });

  test('an unparseable or missing url degrades to a generic phrase', () => {
    expect(describeToolActivity('navigate', { url: 'not a url' })).toBe('Opening a page');
    expect(describeToolActivity('navigate', {})).toBe('Opening a page');
    expect(describeToolActivity('navigate', null)).toBe('Opening a page');
  });

  test('each page action gets a plain-language phrase', () => {
    expect(describeToolActivity('type', { selector: '#a', text: 'x' })).toBe('Typing');
    expect(describeToolActivity('click', { selector: '#b' })).toBe('Clicking');
    expect(describeToolActivity('read_page', {})).toBe('Reading the page');
    expect(describeToolActivity('snapshot', {})).toBe('Looking at the page');
  });

  test('a tab tool with no specific phrase still says something', () => {
    // why: a tab tool added later must not silently go dark — an indicator that
    // vanishes mid-task reads as "finished" and invites the user to intervene.
    expect(describeToolActivity('some_future_tab_tool', {}, { isTabTool: true })).toBe(GENERIC_ACTIVITY);
  });

  test('a non-tab tool shows nothing at all', () => {
    expect(describeToolActivity('memory_write', { text: 'x' })).toBe(null);
    expect(describeToolActivity('actor_create', {})).toBe(null);
    expect(describeToolActivity('some_future_tab_tool', {})).toBe(null);
  });
});

describe('activity-label — what must never reach the screen', () => {
  test('NEVER echoes typed text — that is where passwords and card numbers live', () => {
    const secrets = [
      'hunter2',
      '4111111111111111',
      'sk-ant-api03-abcdef',
      '123456',
    ];
    for (const secret of secrets) {
      for (const field of ['text', 'value']) {
        const phrase = describeToolActivity('type', { selector: '#pw', [field]: secret });
        expect(phrase).toBe('Typing');
        expect(phrase).not.toContain(secret);
      }
    }
  });

  test('NEVER echoes page-derived selectors or labels', () => {
    // A selector is chosen from content the page authored. Echoing it would let a
    // hostile page write the sentence the user reads while deciding whether to
    // intervene — the same reason the origin-lock report names an origin only.
    const hostile = 'button[aria-label="peerd is idle, safe to type your password"]';
    for (const tool of ['click', 'type']) {
      const phrase = describeToolActivity(tool, { selector: hostile, ref: hostile });
      expect(phrase).not.toContain('password');
      expect(phrase).not.toContain('peerd is idle');
      expect(phrase).not.toContain(hostile);
    }
  });

  test('NEVER echoes a full URL — only the host', () => {
    const url = 'https://evil.test/' + 'a'.repeat(300) + '?token=secret-value#frag';
    const phrase = describeToolActivity('navigate', { url });
    expect(phrase).toBe('Opening evil.test');
    expect(phrase).not.toContain('secret-value');
    expect(phrase).not.toContain('aaaa');
    expect(phrase).not.toContain('frag');
  });

  test('a hostile hostname cannot inject newlines or markup into the phrase', () => {
    // The pill sets textContent, never innerHTML, so markup is inert — but the
    // phrase should not carry it in the first place. URL parsing is what enforces
    // this: a host with a space or a newline is not a parseable URL.
    for (const raw of ['https://a b.test/', 'https://a\nb.test/', 'https://<script>.test/']) {
      const phrase = describeToolActivity('navigate', { url: raw });
      expect(phrase).not.toContain('\n');
      expect(phrase).not.toContain('<script>');
    }
  });

  test('every phrase comes from the fixed vocabulary (no arbitrary passthrough)', () => {
    // Sweep a range of hostile arg shapes across every tool and assert the output
    // is always either null or one of the known phrases (or an "Opening <host>").
    const KNOWN = new Set([
      'Clicking', 'Typing', 'Reading the page', 'Reading a PDF',
      'Looking at the page', 'Watching for changes',
      'Opening a page', GENERIC_ACTIVITY,
    ]);
    const tools = ['click', 'type', 'read_page', 'snapshot', 'navigate', 'weird_tool'];
    const argSets = [
      { text: 'SECRET', selector: 'SECRET', value: 'SECRET', url: 'https://ok.test/SECRET' },
      { url: 'SECRET' },
      {},
      null,
    ];
    for (const t of tools) {
      for (const a of argSets) {
        const phrase = describeToolActivity(t, a, { isTabTool: true });
        if (phrase === null) continue;
        const ok = KNOWN.has(phrase) || phrase === 'Opening ok.test';
        expect(ok).toBe(true);
        expect(phrase).not.toContain('SECRET');
      }
    }
  });
});

describe('activity-label — the origin line', () => {
  test('https is shown host-only, matching the phrase above it', () => {
    expect(displayOrigin('https://github.com')).toBe('github.com');
    expect(displayOrigin('https://mail.google.com')).toBe('mail.google.com');
  });

  test('a non-https scheme is KEPT — driving an http page with your session is worth seeing', () => {
    expect(displayOrigin('http://acme.localhost:8080')).toBe('http://acme.localhost:8080');
  });

  test('empty / unusable input degrades to something harmless', () => {
    expect(displayOrigin(null)).toBe('');
    expect(displayOrigin('')).toBe('');
    expect(displayOrigin('   ')).toBe('');
    expect(displayOrigin('not a url')).toBe('not a url');
  });
});
