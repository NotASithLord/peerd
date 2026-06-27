// @ts-check
// Web tools — capture.
//
// Tests exercise the wrappers with mock ctx objects. We don't drive
// real chrome APIs; we stub ctx.tabs and assert on the result.
//
// web_search / submit_form / call_api / read_article were all REMOVED — the
// web actor covers them now (fetch_url is the web resident's sessionless /
// same-origin-scoped fetch; the actor's drive-a-tab DOM tools read pages,
// search by navigating to an engine, and submit forms via type/click).
// fetch_url's own behavior is in tests/peerd-runtime/tools/fetch-url.test.ts.
//
// NOTE: this is the IN-BROWSER suite (open tests/runner.html). It is NOT
// run by `bun test ./tests` (CI).

import { describe, it, expect } from '../../../framework.js';
import { captureTool } from '/peerd-runtime/tools/web/screenshot.js';

/**
 * Build a mock ctx. Each test passes overrides for the surface it
 * cares about (tabs, etc.).
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
  settings: {},
  ...overrides,
});

/** @typedef {import('/shared/tool-types.js').ToolResult} ToolResult */
/** Narrow a ToolResult to its ok-content (tests assert ok first). @param {ToolResult} r */
const contentOf = (r) => /** @type {import('/shared/tool-types.js').ToolResultOk} */ (r).content;

// capture returns raw JSON (no <untrusted_web_content> fence): unwrap when
// fenced, pass through otherwise.
/** @param {string} content */
const unwrap = (content) => {
  const m = /^<untrusted_web_content[^>]*>\n([\s\S]*)\n<\/untrusted_web_content>$/.exec(content);
  return m ? m[1] : content;
};

describe('web.tools', () => {
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
