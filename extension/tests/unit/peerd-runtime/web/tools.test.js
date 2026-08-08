// @ts-check
// Web tools — capture.
//
// Tests exercise the wrappers with mock ctx objects. We don't drive
// real chrome APIs; we stub ctx.tabs and assert on the result.
//
// web_search / submit_form / call_api / read_article were all REMOVED — the
// web actor covers them now (fetch_url is the web actor's sessionless /
// same-origin-scoped fetch; the actor's drive-a-tab DOM tools read pages,
// search by navigating to an engine, and submit forms via type/click).
// fetch_url's own behavior is in tests/peerd-runtime/tools/fetch-url.test.ts.
//
// NOTE: this is the IN-BROWSER suite (open tests/runner.html). It is NOT
// run by `bun test ./tests` (CI).

import { describe, it, expect } from '../../../framework.js';
import { captureTool } from '/peerd-runtime/tools/web/screenshot.js';
import { browserProbeResult } from '../../../helpers/browser-scripting.js';

const makeActivationEvent = () => {
  const listeners = new Set();
  return {
    addListener: (/** @type {(info: { tabId: number, windowId: number }) => void} */ listener) => { listeners.add(listener); },
    removeListener: (/** @type {(info: { tabId: number, windowId: number }) => void} */ listener) => { listeners.delete(listener); },
    emit: (/** @type {{ tabId: number, windowId: number }} */ info) => {
      for (const listener of listeners) listener(info);
    },
    listenerCount: () => listeners.size,
  };
};

/**
 * Build a mock ctx. Each test passes overrides for the surface it
 * cares about (tabs, etc.).
 * @param {Partial<import('/shared/tool-types.js').ToolContext>} [overrides]
 * @returns {import('/shared/tool-types.js').ToolContext}
 */
const mockCtx = (overrides = {}) => {
  const activeTab = { id: 7, url: 'https://example.com/', origin: 'https://example.com' };
  const onActivated = makeActivationEvent();
  const tabs = {
    get: async (/** @type {number} */ _tabId) => ({ ...activeTab, active: true, windowId: 1 }),
    query: async () => [{ ...activeTab, active: true, windowId: 1 }],
    onActivated,
    ...(overrides.tabs ?? {}),
  };
  const scripting = {
    executeScript: async (/** @type {any} */ request) => {
      const tab = await tabs.get(request?.target?.tabId);
      return browserProbeResult(request, { url: tab.url });
    },
    ...(overrides.scripting ?? {}),
  };
  return /** @type {import('/shared/tool-types.js').ToolContext} */ ({
    session: { sessionId: 'test' },
    activeTab,
    audit: async () => {},
    confirm: async () => 'yes_once',
    webFetch: async () => { throw new Error('webFetch not mocked'); },
    settings: {},
    acquireBrowserNetworkGuardLease: async (/** @type {number} */ tabId) => ({
      ok: true,
      lease: { tabId, token: `lease-${tabId}` },
    }),
    releaseBrowserNetworkGuardLease: async () => {},
    ...overrides,
    tabs,
    scripting,
  });
};

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
      const guarded = /** @type {number[]} */ ([]);
      const released = /** @type {number[]} */ ([]);
      const ctx = mockCtx(/** @type {any} */ ({
        acquireBrowserNetworkGuardLease: async (/** @type {number} */ tabId) => {
          guarded.push(tabId);
          return { ok: true, lease: { tabId, token: `lease-${tabId}` } };
        },
        releaseBrowserNetworkGuardLease: async (/** @type {{ tabId: number }} */ lease) => { released.push(lease.tabId); },
        tabs: {
          captureVisibleTab: async () => 'data:image/png;base64,iVBORw0KGgo=',
        },
      }));
      const r = await captureTool.execute({}, ctx);
      expect(r.ok).toBe(true);
      const payload = JSON.parse(unwrap(contentOf(r)));
      expect(payload.dataUrl.startsWith('data:image/png')).toBe(true);
      expect(payload.bytes > 0).toBe(true);
      expect(guarded).toEqual([7]);
      expect(released).toEqual([7]);
    });

    it('errors when captureVisibleTab returns junk', async () => {
      const released = /** @type {number[]} */ ([]);
      const ctx = mockCtx(/** @type {any} */ ({
        acquireBrowserNetworkGuardLease: async (/** @type {number} */ tabId) => ({
          ok: true,
          lease: { tabId, token: `lease-${tabId}` },
        }),
        releaseBrowserNetworkGuardLease: async (/** @type {{ tabId: number }} */ lease) => { released.push(lease.tabId); },
        tabs: { captureVisibleTab: async () => 'not a data url' },
      }));
      const r = await captureTool.execute({}, ctx);
      expect(r.ok).toBe(false);
      expect(released).toEqual([7]);
    });

    it('refuses a private active tab before captureVisibleTab', async () => {
      let captured = false;
      const ctx = mockCtx({
        tabs: {
          get: async () => ({ id: 7, url: 'http://127.0.0.1/private', active: true, windowId: 1 }),
          query: async () => [{ id: 7, url: 'http://127.0.0.1/private', active: true, windowId: 1 }],
          captureVisibleTab: async () => { captured = true; return 'data:image/png;base64,aW1n'; },
        },
      });
      const r = await captureTool.execute({}, ctx);
      expect(r.ok).toBe(false);
      expect(/** @type {any} */ (r).error).toBe('browser_private_network_blocked');
      expect(captured).toBe(false);
    });

    it('validates the actual private foreground instead of a stale public pin', async () => {
      let captured = false;
      const ctx = mockCtx({
        tabs: {
          query: async () => [{ id: 8, url: 'http://127.0.0.1/private', active: true, windowId: 1 }],
          get: async (/** @type {number} */ id) => id === 8
            ? { id: 8, url: 'http://127.0.0.1/private', active: true, windowId: 1 }
            : { id: 7, url: 'https://example.com/', active: false, windowId: 1 },
          captureVisibleTab: async () => { captured = true; return 'data:image/png;base64,aW1n'; },
        },
      });
      const r = await captureTool.execute({}, ctx);
      expect(r.ok).toBe(false);
      expect(captured).toBe(false);
    });

    it('discards the screenshot if the foreground changes during capture', async () => {
      let queryCount = 0;
      const ctx = mockCtx({
        tabs: {
          query: async () => {
            queryCount += 1;
            return queryCount === 1
              ? [{ id: 7, url: 'https://example.com/', active: true, windowId: 1 }]
              : [{ id: 8, url: 'https://other.example/', active: true, windowId: 1 }];
          },
          get: async (/** @type {number} */ id) => id === 7
            ? { id: 7, url: 'https://example.com/', active: true, windowId: 1 }
            : { id: 8, url: 'https://other.example/', active: true, windowId: 1 },
          captureVisibleTab: async () => 'data:image/png;base64,aW1n',
        },
      });
      const r = await captureTool.execute({}, ctx);
      expect(r.ok).toBe(false);
      expect(/** @type {any} */ (r).error.startsWith('capture_target_changed:')).toBe(true);
      expect(/** @type {any} */ (r).content).toBe(undefined);
    });

    it('discards an ABA foreground switch even when the same tab is active afterward', async () => {
      const onActivated = makeActivationEvent();
      const ctx = mockCtx({
        tabs: {
          onActivated,
          captureVisibleTab: async () => {
            onActivated.emit({ tabId: 8, windowId: 1 });
            onActivated.emit({ tabId: 7, windowId: 1 });
            return 'data:image/png;base64,aW1n';
          },
        },
      });

      const r = await captureTool.execute({}, ctx);

      expect(r.ok).toBe(false);
      expect(/** @type {any} */ (r).error.startsWith('capture_target_changed:')).toBe(true);
      expect(/** @type {any} */ (r).content).toBe(undefined);
      expect(onActivated.listenerCount()).toBe(0);
    });

    it('does not discard activation in another window', async () => {
      const onActivated = makeActivationEvent();
      const ctx = mockCtx({
        tabs: {
          onActivated,
          captureVisibleTab: async () => {
            onActivated.emit({ tabId: 18, windowId: 2 });
            return 'data:image/png;base64,aW1n';
          },
        },
      });

      const r = await captureTool.execute({}, ctx);

      expect(r.ok).toBe(true);
      expect(onActivated.listenerCount()).toBe(0);
    });

    it('fails closed when tab activation tracking is unavailable', async () => {
      let captured = false;
      const ctx = mockCtx({
        tabs: {
          onActivated: undefined,
          captureVisibleTab: async () => { captured = true; return 'data:image/png;base64,aW1n'; },
        },
      });

      const r = await captureTool.execute({}, ctx);

      expect(r.ok).toBe(false);
      expect(/** @type {any} */ (r).error).toBe('capture_failed: tab activation tracking is unavailable');
      expect(captured).toBe(false);
    });
  });
});
