// view tool captures the GATED tab, never the window's foreground tab — the fix
// for the denylist/wrong-tab hole. It resolves the target through
// resolveTargetTab (denylist re-check), screenshots that tab by id via CDP when
// available (works backgrounded), uses Firefox captureTab(tabId) otherwise, and
// never falls back to captureVisibleTab.

import { describe, test, expect } from 'bun:test';
import { captureOwnedTabPixelsAuthority } from '../../extension/background/page-authority/view.js';
import { viewTool as controllerViewTool } from '../../extension/peerd-runtime/tools/web/view.js';
import { CONTROLLER_PAGE_IMAGE_MAX_BASE64_CHARS } from '../../extension/shared/controller-kernel-quota.js';

const viewTool = { execute: (args: any, ctx: any) => controllerViewTool.execute(args, {
  ...ctx,
  pageAuthority: { captureOwnedTabPixels: () => captureOwnedTabPixelsAuthority(args, ctx) },
}) };
import {
  browserProbeResult,
  TEST_DOCUMENT_ID,
  TEST_TIME_ORIGIN,
} from '../helpers/browser-scripting.ts';

const PIN = { id: 7, url: 'https://figma.com/file/x', active: false, windowId: 1 };

const baseCtx = (over: any = {}) => ({
  activeTab: { id: 7, url: PIN.url, origin: 'https://figma.com' },
  denylist: [] as string[],
  tabs: {
    get: async (id: number) => (id === 7 ? { ...PIN, ...(over.tab || {}) } : null),
    query: async () => [{ ...PIN, ...(over.tab || {}) }],
    captureVisibleTab: async () => { throw new Error('view must never capture the foreground tab'); },
  },
  scripting: {
    executeScript: async (request: any) => browserProbeResult(request, {
      url: over.tab?.url ?? PIN.url,
    }),
  },
  ...over,
});

describe('view tool — captures the gated tab, not the foreground tab', () => {
  test('CDP path: screenshots the pinned (backgrounded) tab by id', async () => {
    let captureArgs: any = null;
    const ctx = baseCtx({
      debuggerPool: {
        captureScreenshot: async (...args: any[]) => {
          captureArgs = args;
          return { data: 'aW1n', mediaType: 'image/jpeg' };
        },
      },
    });
    const r: any = await viewTool.execute({}, ctx as any);
    expect(r.ok).toBe(true);
    expect(r.images).toEqual([{ mediaType: 'image/jpeg', data: 'aW1n' }]);
    expect(r.content).toContain('figma.com');
    expect(r.content).not.toContain('/file/x');
    expect(JSON.parse(r.content).tabUrl).toBeUndefined();
    // bytes-free metadata — the base64 lives only in images
    expect(r.content).not.toContain('aW1n');
    expect(captureArgs).toEqual([7, {
      format: 'jpeg',
      quality: 70,
      expectedDocument: {
        origin: 'https://figma.com',
        href: PIN.url,
        documentId: TEST_DOCUMENT_ID,
        timeOrigin: TEST_TIME_ORIGIN,
      },
    }]);
  });

  test('store Chrome without an exact-tab API fails closed even when the tab is foreground', async () => {
    const r: any = await viewTool.execute({}, baseCtx({ tab: { active: true } }) as any);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('view_exact_tab_capture_unavailable');
    expect(r.error).toContain('snapshot, read_page, or query_dom');
  });

  test('Firefox captures the exact backgrounded tab with tabs.captureTab(tabId)', async () => {
    let captured: any = null;
    const ctx = baseCtx();
    ctx.tabs.captureTab = async (...args: any[]) => {
      captured = args;
      return 'data:image/jpeg;base64,Zm9v';
    };
    const r: any = await viewTool.execute({}, ctx as any);
    expect(r.ok).toBe(true);
    expect(r.images[0].data).toBe('Zm9v');
    expect(captured).toEqual([7, { format: 'jpeg', quality: 70 }]);
  });

  test('admits the exact encoded transport boundary and refuses one byte over it', async () => {
    let data = 'A'.repeat(CONTROLLER_PAGE_IMAGE_MAX_BASE64_CHARS);
    const ctx = baseCtx({
      debuggerPool: {
        captureScreenshot: async () => ({ data, mediaType: 'image/jpeg' }),
      },
    });
    const boundary: any = await captureOwnedTabPixelsAuthority({}, ctx);
    expect(boundary.ok).toBe(true);
    expect(boundary.receipt.data.length).toBe(CONTROLLER_PAGE_IMAGE_MAX_BASE64_CHARS);

    data += 'A';
    const oversized: any = await captureOwnedTabPixelsAuthority({}, ctx);
    expect(oversized).toEqual({ ok: false, error: 'view_screenshot_too_large' });
    const presented: any = await viewTool.execute({}, ctx);
    expect(presented).toMatchObject({ ok: false, error: 'view_screenshot_too_large' });
    expect(presented.content).toContain('Zoom out');
  });

  test('Firefox discards pixels when the exact document changes during capture', async () => {
    let documentId = 'doc-before';
    const ctx = baseCtx();
    ctx.scripting.executeScript = async (request: any) => browserProbeResult(request, {
      url: PIN.url,
      documentId,
    });
    ctx.tabs.captureTab = async () => {
      documentId = 'doc-after';
      return 'data:image/jpeg;base64,b2xkLWRvY3VtZW50';
    };

    const r: any = await viewTool.execute({}, ctx as any);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('browser_target_unverified');
    expect(r.images).toBeUndefined();
  });

  test('denylisted target → no capture', async () => {
    const r: any = await viewTool.execute({}, baseCtx({ denylist: ['figma.com'] }) as any);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('view_no_target_tab');
  });

  test('private target returns the structured policy refusal without capture', async () => {
    let captured = false;
    const r: any = await viewTool.execute({}, baseCtx({
      tab: { url: 'http://127.0.0.1/private', active: true },
      debuggerPool: { captureScreenshot: async () => { captured = true; return {}; } },
    }) as any);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('browser_private_network_blocked');
    expect(r.structured).toMatchObject({ reason: 'private_network', stage: 'committed_origin' });
    expect(r.outcomeKind).toBe('pre-effect-failure');
    expect(captured).toBe(false);
  });
});
