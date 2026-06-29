// Playwright-shaped page API — the host-side translation core for the web
// actor's code-REPL arm. These pin the load-bearing semantics that have to hold
// before any worker/SW wiring exists: the page.<method> -> gated-tool-call
// mapping, Playwright locator strictness (exactly-one-match unless an explicit
// nth), arg validation, and result shaping / failure propagation.

import { describe, test, expect } from 'bun:test';
import {
  pageCallToToolCall,
  shapePageResult,
  PAGE_API_METHODS,
  PageApiError,
} from '../../extension/peerd-runtime/subagent/page-api.js';

describe('pageCallToToolCall — page.* maps to the gated tool', () => {
  test('goto -> navigate', () => {
    expect(pageCallToToolCall({ method: 'goto', args: { url: 'https://example.com' } }))
      .toEqual({ name: 'navigate', args: { url: 'https://example.com' } });
  });

  test('fill -> type, always single-match strict', () => {
    expect(pageCallToToolCall({ method: 'fill', args: { selector: '#email', text: 'a@b.com' } }))
      .toEqual({ name: 'type', args: { selector: '#email', text: 'a@b.com', expectedCount: 1 } });
  });

  test('snapshot / content -> the read tools, no args', () => {
    expect(pageCallToToolCall({ method: 'snapshot' })).toEqual({ name: 'snapshot', args: {} });
    expect(pageCallToToolCall({ method: 'content' })).toEqual({ name: 'read_page', args: {} });
  });
});

describe('pageCallToToolCall — locator strictness (the Playwright default)', () => {
  test('click with no nth requires exactly one match (expectedCount: 1)', () => {
    expect(pageCallToToolCall({ method: 'click', args: { selector: 'button.send' } }))
      .toEqual({ name: 'click', args: { selector: 'button.send', expectedCount: 1 } });
  });

  test('an explicit nth opts out of the single-match guard (choose among matches)', () => {
    const out = pageCallToToolCall({ method: 'click', args: { selector: 'li a', nth: 2 } });
    expect(out).toEqual({ name: 'click', args: { selector: 'li a', nth: 2 } });
    // strictness is OFF when nth is given — no expectedCount snuck in
    expect('expectedCount' in out.args).toBe(false);
  });
});

describe('pageCallToToolCall — validation fails closed', () => {
  test('unknown method throws PageApiError', () => {
    expect(() => pageCallToToolCall({ method: 'evaluate', args: {} })).toThrow(PageApiError);
    expect(() => pageCallToToolCall({ method: 'evaluate' })).toThrow(/unknown page method: evaluate/);
  });

  test('missing / wrong-typed required args throw', () => {
    expect(() => pageCallToToolCall({ method: 'goto', args: {} })).toThrow(/url must be a non-empty string/);
    expect(() => pageCallToToolCall({ method: 'click', args: {} })).toThrow(/selector must be a non-empty string/);
    expect(() => pageCallToToolCall({ method: 'fill', args: { selector: '#x' } }))
      .toThrow(/text must be a string/);
  });

  test('PAGE_API_METHODS lists exactly the supported surface', () => {
    expect([...PAGE_API_METHODS].sort()).toEqual(['click', 'content', 'fill', 'goto', 'snapshot']);
  });
});

describe('shapePageResult — tool result -> Playwright-ish return', () => {
  test('goto returns the landed url + origin', () => {
    const r = shapePageResult('goto', {
      ok: true,
      content: JSON.stringify({ url: 'https://example.com/', origin: 'https://example.com' }),
    });
    expect(r).toEqual({ ok: true, url: 'https://example.com/', origin: 'https://example.com' });
  });

  test('click surfaces matchedCount + navigated when present', () => {
    const r = shapePageResult('click', {
      ok: true,
      content: JSON.stringify({ clicked: true, matchedCount: 1, navigated: true }),
    });
    expect(r).toEqual({ ok: true, clicked: true, matchedCount: 1, navigated: true });
  });

  test('fill reports filled', () => {
    const r = shapePageResult('fill', { ok: true, content: JSON.stringify({ typed: 'a@b.com', matchedCount: 1 }) });
    expect(r).toEqual({ ok: true, filled: true, matchedCount: 1 });
  });

  test('a failed gated tool rejects like Playwright does', () => {
    expect(() => shapePageResult('click', { ok: false, error: 'matched_count_mismatch: selector matched 3 element(s), expected 1' }))
      .toThrow(/matched_count_mismatch/);
    // and it is a PageApiError, so worker code can branch on it
    expect(() => shapePageResult('click', { ok: false, error: 'x' })).toThrow(PageApiError);
  });

  test('a malformed (non-JSON) content body does not crash the shaper', () => {
    // snapshot/content pass the parsed body straight through; a raw string stays a string
    expect(shapePageResult('content', { ok: true, content: 'not json' })).toBe('not json');
  });
});
