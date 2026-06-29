// view tool captures the GATED tab, never the window's foreground tab — the fix
// for the denylist/wrong-tab hole. It resolves the target through
// resolveTargetTab (denylist re-check), screenshots that tab by id via CDP when
// available (works backgrounded), falls back to captureVisibleTab only when the
// gated tab is already foreground, and fails closed otherwise.

import { describe, test, expect } from 'bun:test';
import { viewTool } from '../../extension/peerd-runtime/tools/web/view.js';

const PIN = { id: 7, url: 'https://figma.com/file/x', active: false, windowId: 1 };

const baseCtx = (over: any = {}) => ({
  activeTab: { id: 7, url: PIN.url, origin: 'https://figma.com' },
  denylist: [] as string[],
  tabs: {
    get: async (id: number) => (id === 7 ? { ...PIN, ...(over.tab || {}) } : null),
    captureVisibleTab: async () => 'data:image/jpeg;base64,Zm9v',
  },
  ...over,
});

describe('view tool — captures the gated tab, not the foreground tab', () => {
  test('CDP path: screenshots the pinned (backgrounded) tab by id', async () => {
    const ctx = baseCtx({ debuggerPool: { captureScreenshot: async () => ({ data: 'aW1n', mediaType: 'image/jpeg' }) } });
    const r: any = await viewTool.execute({}, ctx as any);
    expect(r.ok).toBe(true);
    expect(r.images).toEqual([{ mediaType: 'image/jpeg', data: 'aW1n' }]);
    expect(r.content).toContain('figma.com');
    // bytes-free metadata — the base64 lives only in images
    expect(r.content).not.toContain('aW1n');
  });

  test('no CDP + backgrounded tab → fails closed (never captures a different foreground tab)', async () => {
    const r: any = await viewTool.execute({}, baseCtx() as any); // PIN.active=false, no pool
    expect(r.ok).toBe(false);
    expect(r.error).toContain('view_needs_cdp_for_background_tab');
  });

  test('no CDP + foreground tab → uses captureVisibleTab on the gated tab', async () => {
    const r: any = await viewTool.execute({}, baseCtx({ tab: { active: true } }) as any);
    expect(r.ok).toBe(true);
    expect(r.images[0].data).toBe('Zm9v');
  });

  test('denylisted target → no capture', async () => {
    const r: any = await viewTool.execute({}, baseCtx({ denylist: ['figma.com'] }) as any);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('view_no_target_tab');
  });
});
