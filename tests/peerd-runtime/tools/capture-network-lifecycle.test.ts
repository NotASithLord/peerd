import { describe, expect, test } from 'bun:test';
import { captureForegroundPixelsAuthority } from '../../../extension/background/page-authority/capture.js';
import { HOST_EFFECT_OUTCOME } from '../../../extension/background/host-effect-verdict.js';
import { captureTool as controllerCaptureTool } from '../../../extension/peerd-runtime/tools/web/screenshot.js';
import {
  CONTROLLER_PAGE_IMAGE_MAX_BASE64_CHARS,
  createControllerKernelQuota,
} from '../../../extension/shared/controller-kernel-quota.js';
import { browserProbeResult } from '../../helpers/browser-scripting.ts';

describe('capture network-host lifecycle', () => {
  test('preserves an unknown guard-host outcome without attempting capture', async () => {
    let captured = false;
    const onActivated = {
      addListener: () => {},
      removeListener: () => {},
    };
    const ctx: any = {
      tabs: {
        query: async () => [{
          id: 7, url: 'https://example.com/', active: true, windowId: 1,
        }],
        onActivated,
        captureVisibleTab: async () => {
          captured = true;
          return 'data:image/png;base64,aW1n';
        },
      },
      acquireBrowserNetworkGuardLease: async () => ({
        ok: false,
        error: 'browser network host timed out',
        code: 'kernel-browser-network-lease-load-timeout',
        outcomeKnown: false,
        retryable: false,
        phase: 'run',
      }),
    };
    const result: any = await controllerCaptureTool.execute({}, {
      pageAuthority: {
        captureForegroundPixels: () => captureForegroundPixelsAuthority({}, ctx),
      },
    } as any);
    expect(result).toMatchObject({
      ok: false,
      code: 'kernel-browser-network-lease-load-timeout',
      outcomeKnown: false,
      retryable: false,
      phase: 'run',
    });
    expect(HOST_EFFECT_OUTCOME.okResult.fulfilled(result)).toBe('unknown');
    expect(captured).toBe(false);
  });

  test('admits the exact encoded transport boundary and refuses one byte over it', async () => {
    let data = 'A'.repeat(CONTROLLER_PAGE_IMAGE_MAX_BASE64_CHARS);
    const onActivated = {
      addListener: () => {},
      removeListener: () => {},
    };
    const tab = { id: 7, url: 'https://example.com/', active: true, windowId: 1 };
    const ctx: any = {
      activeTab: { id: 7, url: tab.url, origin: 'https://example.com' },
      denylist: [],
      tabs: {
        get: async () => tab,
        query: async () => [tab],
        onActivated,
        captureVisibleTab: async () => `data:image/png;base64,${data}`,
      },
      scripting: {
        executeScript: async (request: any) => browserProbeResult(request, { url: tab.url }),
      },
      acquireBrowserNetworkGuardLease: async () => ({
        ok: true, lease: { tabId: 7, token: 'lease-7' },
      }),
      releaseBrowserNetworkGuardLease: async () => {},
    };
    const boundary: any = await captureForegroundPixelsAuthority({}, ctx);
    expect(boundary.ok).toBe(true);
    expect(boundary.receipt.dataUrl.endsWith(data)).toBe(true);
    const kernelResult = {
      ok: true,
      outcomeKnown: true,
      value: { authorityValue: boundary, authorityReceipt: {
        effectId: 'capture:1', operation: 'turn.page.capture-foreground',
        outcome: 'observed', outcomeKnown: true, performed: false, retryable: false,
      } },
    };
    expect(createControllerKernelQuota('turn.run', { maxSteps: 1 }).observe(
      'turn.page.capture-foreground', {}, kernelResult,
    )).toEqual({ ok: true, outcomeKnown: true });

    data += 'A';
    const oversized: any = await captureForegroundPixelsAuthority({}, ctx);
    expect(oversized).toEqual({ ok: false, error: 'capture_screenshot_too_large' });
    const presented: any = await controllerCaptureTool.execute({}, {
      pageAuthority: { captureForegroundPixels: () => captureForegroundPixelsAuthority({}, ctx) },
    } as any);
    expect(presented).toMatchObject({ ok: false, error: 'capture_screenshot_too_large' });
    expect(presented.content).toContain('Reduce the window size');
  });
});
