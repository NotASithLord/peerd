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
} from '../../extension/peerd-runtime/actor/page-api.js';

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

  test('snapshot refs remain refs instead of becoming invalid CSS selectors', () => {
    expect(pageCallToToolCall({ method: 'click', args: { target: '@e3' } }))
      .toEqual({ name: 'click', args: { ref: '@e3' } });
    expect(pageCallToToolCall({ method: 'fill', args: { target: { ref: '@e7' }, text: 'value' } }))
      .toEqual({ name: 'type', args: { ref: '@e7', text: 'value' } });
  });
});

describe('pageCallToToolCall — validation fails closed', () => {
  test('unknown method throws PageApiError', () => {
    expect(() => pageCallToToolCall({ method: 'evaluate', args: {} })).toThrow(PageApiError);
    expect(() => pageCallToToolCall({ method: 'evaluate' })).toThrow(/unknown page method: evaluate/);
  });

  test('missing / wrong-typed required args throw', () => {
    expect(() => pageCallToToolCall({ method: 'goto', args: {} })).toThrow(/url must be a non-empty string/);
    expect(() => pageCallToToolCall({ method: 'click', args: {} })).toThrow(/selector.*@e ref/);
    expect(() => pageCallToToolCall({ method: 'fill', args: { selector: '#x' } }))
      .toThrow(/text must be a string/);
  });

  test('PAGE_API_METHODS lists exactly the supported surface', () => {
    expect([...PAGE_API_METHODS].sort()).toEqual([
      'captureSite', 'click', 'content', 'fetch', 'fill', 'goto', 'keys',
      'login', 'query', 'readCache', 'readDocument', 'readPdf', 'readSiteClient',
      'readState', 'snapshot', 'view', 'watchChanges', 'writeSiteClient',
    ]);
  });
});

describe('pageCallToToolCall — web capability parity', () => {
  test('fetch/doc/cache preserve their gated tool vocabulary', () => {
    expect(pageCallToToolCall({ method: 'fetch', args: { url: 'https://example.com/x', options: { query: 'price' } } }))
      .toEqual({ name: 'fetch_url', args: { url: 'https://example.com/x', query: 'price' } });
    expect(pageCallToToolCall({ method: 'readDocument', args: { url: 'https://example.com/a.docx', options: { maxChars: 9 } } }))
      .toEqual({ name: 'read_doc', args: { url: 'https://example.com/a.docx', maxChars: 9 } });
    expect(pageCallToToolCall({ method: 'readCache', args: { key: 'cache-1', options: { offset: 10 } } }))
      .toEqual({ name: 'read_web_cache', args: { key: 'cache-1', offset: 10 } });
  });

  test('safe site-client metadata and login methods map only to existing gated tools', () => {
    expect(() => pageCallToToolCall({ method: 'runSiteClient', args: { origin: 'https://api.example.com', code: 'return 1' } })).toThrow(/unknown page method/);
    expect(pageCallToToolCall({ method: 'readSiteClient', args: { origin: 'https://api.example.com' } }).name).toBe('site_client_read');
    expect(pageCallToToolCall({ method: 'writeSiteClient', args: { origin: 'https://api.example.com', definition: { body: 'export {}' } } })).toEqual({ name: 'site_client_write', args: { origin: 'https://api.example.com', body: 'export {}' } });
    expect(pageCallToToolCall({ method: 'captureSite', args: { action: 'start' } })).toEqual({ name: 'site_capture', args: { action: 'start' } });
    expect(pageCallToToolCall({ method: 'login', args: { target: '@e2' } })).toEqual({ name: 'login', args: { ref: '@e2' } });
  });

  test('DOM, keyboard, PDF, and vision parity methods map to the direct actor tools', () => {
    expect(pageCallToToolCall({ method: 'readState', args: { target: '@e2' } })).toEqual({ name: 'read_state', args: { ref: '@e2' } });
    expect(pageCallToToolCall({ method: 'watchChanges' }).name).toBe('watch_changes');
    expect(pageCallToToolCall({ method: 'query', args: { selector: '.row', options: { limit: 3 } } })).toEqual({ name: 'query_dom', args: { selector: '.row', limit: 3 } });
    expect(pageCallToToolCall({ method: 'keys', args: { sequence: 'Shift+I' } })).toEqual({ name: 'page_keys', args: { keys: 'Shift+I' } });
    expect(pageCallToToolCall({ method: 'readPdf', args: { options: { engine: 'pdfjs' } } })).toEqual({ name: 'read_pdf', args: { engine: 'pdfjs' } });
    expect(pageCallToToolCall({ method: 'view' })).toEqual({ name: 'view', args: {} });
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
