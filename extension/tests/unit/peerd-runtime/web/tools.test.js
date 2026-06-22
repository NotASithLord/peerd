// @ts-check
// Web tools — call_api, read_article, web_search, submit_form, capture.
//
// Tests exercise the wrappers with mock ctx objects. We don't drive
// real chrome APIs; for tool calls that escalate to a tab we stub
// ctx.tabs / ctx.scripting and assert on the resulting call sequence.
//
// NOTE: this is the IN-BROWSER suite (open tests/runner.html). It is NOT
// run by `bun test ./tests` (CI). The <untrusted_web_content> wrapping
// property is independently covered in CI by
// tests/peerd-runtime/web-tools-wrap.test.ts.

import { describe, it, expect } from '../../../framework.js';
import { callApiTool }     from '/peerd-runtime/tools/web/api.js';
import { readArticleTool } from '/peerd-runtime/tools/web/read.js';
import { webSearchTool }   from '/peerd-runtime/tools/web/search.js';
import { submitFormTool }  from '/peerd-runtime/tools/web/form.js';
import { captureTool }     from '/peerd-runtime/tools/web/screenshot.js';

/**
 * Build a mock ctx. Each test passes overrides for the surface it
 * cares about (webFetch, tabs, scripting, etc.).
 * @param {Partial<import('/shared/tool-types.js').ToolContext>} [overrides]
 * @returns {import('/shared/tool-types.js').ToolContext}
 */
const mockCtx = (overrides = {}) => /** @type {import('/shared/tool-types.js').ToolContext} */ ({
  session: { sessionId: 'test' },
  activeTab: { id: 7, url: 'https://example.com/', origin: 'https://example.com' },
  audit: async () => {},
  confirm: async () => 'yes_once',
  webFetch: async () => { throw new Error('webFetch not mocked'); },
  tabs: {},
  scripting: {},
  // Web tabs are background unconditionally (never-steal-focus policy);
  // settings carries no tab key anymore.
  settings: {},
  ...overrides,
});

/**
 * Build a mock Response-like object with the headers + body shape that
 * primitives.fetchUrl reads.
 */
/**
 * @param {{ status?: number, body?: string, headers?: Record<string, string>, url?: string }} [opts]
 * @returns {Response} the slice of Response that primitives.fetchUrl reads,
 *   cast to the full type (deliberately-minimal stand-in).
 */
const mockResponse = ({ status = 200, body = '', headers = {}, url = 'https://x.com/' } = {}) => /** @type {Response} */ (/** @type {unknown} */ ({
  status,
  text: async () => body,
  headers: {
    /** @param {string} k */
    get: (k) => headers[k.toLowerCase()],
    /** @param {(v: string, k: string) => void} cb */
    forEach: (cb) => Object.entries(headers).forEach(([k, v]) => cb(v, k)),
  },
  url,
}));

/**
 * call_api / read_article / web_search wrap their JSON payload in the
 * <untrusted_web_content> fence (the prompt-injection boundary). Assert
 * the fence is present and return the inner JSON payload so each test can
 * keep asserting on the structured fields.
 */
/** @typedef {import('/shared/tool-types.js').ToolResult} ToolResult */
/** Narrow a ToolResult to its ok-content (tests assert ok first). @param {ToolResult} r */
const contentOf = (r) => /** @type {import('/shared/tool-types.js').ToolResultOk} */ (r).content;
/** Narrow a ToolResult to its error string. @param {ToolResult} r */
const errorOf = (r) => /** @type {import('/shared/tool-types.js').ToolResultErr} */ (r).error;

/** @param {string} content */
const unwrapWebContent = (content) => {
  expect(content.startsWith('<untrusted_web_content ')).toBe(true);
  expect(content.includes('</untrusted_web_content>')).toBe(true);
  const inner = content
    .replace(/^<untrusted_web_content\b[^>]*>\n/, '')
    .replace(/\n<\/untrusted_web_content>$/, '');
  return JSON.parse(inner);
};

// Tolerant variant for tools that DON'T wrap (submit_form / capture return
// raw JSON): unwraps when fenced, passes through otherwise.
/** @param {string} content */
const unwrap = (content) => {
  const m = /^<untrusted_web_content[^>]*>\n([\s\S]*)\n<\/untrusted_web_content>$/.exec(content);
  return m ? m[1] : content;
};

describe('web.tools', () => {
  describe('call_api', () => {
    it('returns the response body and parses JSON when content-type matches', async () => {
      const ctx = mockCtx({
        webFetch: async () => mockResponse({
          status: 200,
          body: '{"hello":"world"}',
          headers: { 'content-type': 'application/json' },
        }),
      });
      const r = await callApiTool.execute({ url: 'https://api.example.com/x' }, ctx);
      expect(r.ok).toBe(true);
      const payload = unwrapWebContent(contentOf(r));
      expect(payload.status).toBe(200);
      expect(payload.json.hello).toBe('world');
    });

    it('errors on missing url', async () => {
      const r = await callApiTool.execute({}, mockCtx());
      expect(r.ok).toBe(false);
      expect(errorOf(r)).toBe('url_required');
    });

    it('rejects non-http schemes', async () => {
      const r = await callApiTool.execute({ url: 'file:///etc/passwd' }, mockCtx());
      expect(r.ok).toBe(false);
      expect(errorOf(r).startsWith('unsupported_scheme')).toBe(true);
    });

    it('truncates very large bodies', async () => {
      const big = 'x'.repeat(20_000);
      const ctx = mockCtx({
        webFetch: async () => mockResponse({ body: big, headers: { 'content-type': 'text/plain' } }),
      });
      const r = await callApiTool.execute({ url: 'https://api.example.com' }, ctx);
      const payload = unwrapWebContent(contentOf(r));
      expect(payload.truncated).toBe(true);
      expect(payload.body.length).toBe(16_000);
    });
  });

  describe('read_article', () => {
    it('returns the safeFetch result when the response is a real article', async () => {
      const body = `${'<html><body><article>'.repeat(1)}A real post${'words '.repeat(80)}</article></body></html>`;
      const ctx = mockCtx({
        webFetch: async () => mockResponse({ status: 200, body }),
      });
      const r = await readArticleTool.execute({ url: 'https://blog.example.com/post' }, ctx);
      expect(r.ok).toBe(true);
      const payload = unwrapWebContent(contentOf(r));
      expect(payload.via).toBe('safeFetch');
      expect(payload.text.includes('A real post')).toBe(true);
    });

    it('escalates to a tab on SPA shell and cleans it up', async () => {
      const shell = '<html><body><div id="root"></div><script>x</script></body></html>';
      /** @type {boolean | null | undefined} */
      let createdActive = null;
      let tabRemoved = false;
      const ctx = mockCtx({
        webFetch: async () => mockResponse({ status: 200, body: shell }),
        tabs: {
          /** @param {{ url?: string, active?: boolean }} props */
          create: async ({ url, active }) => { createdActive = active; return { id: 99, url }; },
          get: async () => ({ id: 99, url: 'https://spa.example.com/page' }),
          remove: async () => { tabRemoved = true; },
          onUpdated: {
            /** @param {(tabId: number, info: { status?: string }) => void} fn */
            addListener: (fn) => { setTimeout(() => fn(99, { status: 'complete' }), 0); },
            removeListener: () => {},
          },
        },
        scripting: {
          executeScript: async () => [{ result: { url: 'https://spa.example.com/page', title: 'SPA', text: 'real rendered content' } }],
        },
      });
      const r = await readArticleTool.execute({ url: 'https://spa.example.com/page' }, ctx);
      expect(r.ok).toBe(true);
      const payload = unwrapWebContent(contentOf(r));
      expect(payload.via).toBe('background_tab');
      expect(createdActive).toBe(false);             // never-steal-focus policy
      expect(payload.escalation_reason).toBe('spa_shell');
      expect(payload.text).toBe('real rendered content');
      expect(tabRemoved).toBe(true);
    });

    it('opens its escalation tab in the BACKGROUND, unconditionally', async () => {
      const shell = '<html><body><div id="root"></div><script>x</script></body></html>';
      /** @type {boolean | null | undefined} */
      let createdActive = null;
      const ctx = mockCtx({
        webFetch: async () => mockResponse({ status: 200, body: shell }),
        tabs: {
          /** @param {{ url?: string, active?: boolean }} props */
          create: async ({ url, active }) => { createdActive = active; return { id: 77, url }; },
          get: async () => ({ id: 77, url: 'https://spa.example.com/page' }),
          remove: async () => {},
          onUpdated: {
            /** @param {(tabId: number, info: { status?: string }) => void} fn */
            addListener: (fn) => { setTimeout(() => fn(77, { status: 'complete' }), 0); },
            removeListener: () => {},
          },
        },
        scripting: {
          executeScript: async () => [{ result: { url: 'https://spa.example.com/page', title: 'SPA', text: 'bg content' } }],
        },
      });
      const r = await readArticleTool.execute({ url: 'https://spa.example.com/page' }, ctx);
      expect(r.ok).toBe(true);
      const payload = unwrapWebContent(contentOf(r));
      expect(payload.via).toBe('background_tab');
      expect(createdActive).toBe(false);             // background as requested
    });

    it('escalates when expects substrings are missing', async () => {
      const body = `<html><body><p>completely different content</p>${'word '.repeat(80)}</body></html>`;
      let tabCreated = false;
      const ctx = mockCtx({
        webFetch: async () => mockResponse({ status: 200, body }),
        tabs: {
          create: async () => { tabCreated = true; return { id: 88 }; },
          get: async () => ({ id: 88, url: 'https://x.com/' }),
          remove: async () => {},
          onUpdated: {
            /** @param {(tabId: number, info: { status?: string }) => void} fn */
            addListener: (fn) => { setTimeout(() => fn(88, { status: 'complete' }), 0); },
            removeListener: () => {},
          },
        },
        scripting: {
          executeScript: async () => [{ result: { url: 'https://x.com/', title: '', text: 'from tab' } }],
        },
      });
      const r = await readArticleTool.execute(
        { url: 'https://x.com/', expects: ['my sentinel string'] }, ctx,
      );
      expect(r.ok).toBe(true);
      const payload = unwrapWebContent(contentOf(r));
      expect(payload.via).toBe('background_tab');
      expect(tabCreated).toBe(true);
    });

    it('rejects invalid URLs', async () => {
      const r = await readArticleTool.execute({ url: 'not a url' }, mockCtx());
      expect(r.ok).toBe(false);
    });
  });

  describe('web_search', () => {
    it('builds the search URL and reads the results tab', async () => {
      /** @type {string | null | undefined} */
      let createdUrl = null;
      /** @type {boolean | null | undefined} */
      let active = null;
      const ctx = mockCtx({
        tabs: {
          /** @param {{ url?: string, active?: boolean }} props */
          create: async ({ url, active: a }) => { createdUrl = url; active = a; return { id: 55, url }; },
          get: async () => ({ id: 55, url: createdUrl }),
          remove: async () => {},
          onUpdated: {
            /** @param {(tabId: number, info: { status?: string }) => void} fn */
            addListener: (fn) => { setTimeout(() => fn(55, { status: 'complete' }), 0); },
            removeListener: () => {},
          },
        },
        scripting: {
          executeScript: async () => [{ result: { url: createdUrl, title: 'Results', text: 'search results body' } }],
        },
      });
      const r = await webSearchTool.execute({ query: 'peerd local agents' }, ctx);
      expect(r.ok).toBe(true);
      const payload = unwrapWebContent(contentOf(r));
      // why cast: TS flow-narrows createdUrl to its sync init (null); the URL
      // is set inside the async create() callback, invisible to CFA.
      expect(/** @type {string | undefined} */ (/** @type {unknown} */ (createdUrl))?.includes('google.com/search?q=')).toBe(true);
      expect(/** @type {string | undefined} */ (/** @type {unknown} */ (createdUrl))?.includes('peerd')).toBe(true);
      expect(active).toBe(false);                    // never-steal-focus policy
      expect(payload.text).toBe('search results body');
    });

    it('opens the search tab in the BACKGROUND, unconditionally', async () => {
      /** @type {boolean | null | undefined} */
      let active = null;
      const ctx = mockCtx({
        tabs: {
          /** @param {{ url?: string, active?: boolean }} props */
          create: async ({ url, active: a }) => { active = a; return { id: 56, url }; },
          get: async () => ({ id: 56, url: 'https://google.com/search?q=x' }),
          remove: async () => {},
          onUpdated: {
            /** @param {(tabId: number, info: { status?: string }) => void} fn */
            addListener: (fn) => { setTimeout(() => fn(56, { status: 'complete' }), 0); },
            removeListener: () => {},
          },
        },
        scripting: { executeScript: async () => [{ result: { url: '', title: '', text: 'r' } }] },
      });
      await webSearchTool.execute({ query: 'x' }, ctx);
      expect(active).toBe(false);
    });

    it('errors on empty query', async () => {
      const r = await webSearchTool.execute({ query: '   ' }, mockCtx());
      expect(r.ok).toBe(false);
      expect(errorOf(r)).toBe('query_required');
    });
  });

  describe('submit_form', () => {
    it('errors on empty fields', async () => {
      const r = await submitFormTool.execute({ fields: {} }, mockCtx());
      expect(r.ok).toBe(false);
      expect(errorOf(r)).toBe('fields_empty');
    });

    it('fills fields in the active tab when no url/tabId given', async () => {
      /** @type {any[] | null} */
      let injected = null;
      const ctx = mockCtx({
        tabs: {
          query: async () => [{ id: 7, url: 'https://example.com/' }],
          /** @param {number} id */
          get: async (id) => ({ id, url: 'https://example.com/' }),
        },
        scripting: {
          /** @param {{ args?: any[] }} injection */
          executeScript: async ({ args }) => {
            injected = args ?? null;
            return [{ result: { fields: { '#name': { ok: true } }, submitted: false } }];
          },
        },
      });
      const r = await submitFormTool.execute({
        fields: { '#name': 'Ariel' },
      }, ctx);
      expect(r.ok).toBe(true);
      expect(/** @type {any[]} */ (/** @type {unknown} */ (injected))[0]).toEqual({ '#name': 'Ariel' });
      const payload = JSON.parse(unwrap(contentOf(r)));
      expect(payload.submitted).toBe(false);
    });
  });

  describe('capture', () => {
    it('returns the data URL from captureVisibleTab', async () => {
      const ctx = mockCtx({
        tabs: {
          captureVisibleTab: async () => 'data:image/png;base64,iVBORw0KGgo=',
        },
      });
      const r = await captureTool.execute({}, ctx);
      expect(r.ok).toBe(true);
      const payload = JSON.parse(unwrap(contentOf(r)));
      expect(payload.dataUrl.startsWith('data:image/png')).toBe(true);
      expect(payload.bytes > 0).toBe(true);
    });

    it('errors when captureVisibleTab returns junk', async () => {
      const ctx = mockCtx({
        tabs: { captureVisibleTab: async () => 'not a data url' },
      });
      const r = await captureTool.execute({}, ctx);
      expect(r.ok).toBe(false);
    });
  });
});
