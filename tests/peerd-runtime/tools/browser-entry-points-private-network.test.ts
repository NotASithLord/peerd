import { describe, expect, test } from 'bun:test';
import { openTabTool } from '../../../extension/peerd-runtime/tools/defs/open-tab.js';
import { siteCaptureTool } from '../../../extension/peerd-runtime/tools/defs/site-capture.js';
import { clickTool } from '../../../extension/peerd-runtime/tools/defs/click.js';
import {
  BrowserAutomationPolicyError,
  BrowserNetworkGuardUnavailableError,
} from '../../../extension/peerd-runtime/tools/browser-automation-policy.js';
import {
  browserProbeResult,
  TEST_DOCUMENT_ID,
  TEST_TIME_ORIGIN,
} from '../../helpers/browser-scripting.ts';

describe('browser entry-point private-network policy', () => {
  test('every resolved-tab primitive refuses before page access when the network floor is unavailable', async () => {
    let injected = 0;
    const operation = clickTool.execute({ selector: 'button' }, {
      tabs: { get: async () => ({ id: 7, url: 'https://public.example/' }) },
      activeTab: { id: 7, url: 'https://public.example/', origin: 'https://public.example' },
      ensureBrowserNetworkGuard: async () => ({ ok: false }),
      scripting: { executeScript: async () => { injected += 1; return []; } },
    } as any);
    await expect(operation).rejects.toBeInstanceOf(BrowserNetworkGuardUnavailableError);
    await expect(operation).rejects.toMatchObject({
      code: 'browser_network_guard_unavailable',
      outcomeKind: 'pre-effect-failure',
      structured: { reason: 'network_guard_unavailable', retryable: false },
    });
    expect(injected).toBe(0);
  });

  test('resolved-tab primitives preserve the host-stamped guard failure kind', async () => {
    const operation = clickTool.execute({ selector: 'button' }, {
      tabs: { get: async () => ({ id: 7, url: 'https://public.example/' }) },
      activeTab: { id: 7, url: 'https://public.example/', origin: 'https://public.example' },
      ensureBrowserNetworkGuard: async () => ({
        ok: false,
        structured: { reason: 'network_guard_unsupported' },
      }),
    } as any);
    await expect(operation).rejects.toMatchObject({
      structured: { reason: 'network_guard_unsupported', retryable: false },
    });
  });

  test('open_tab refuses a direct private target before creating a tab', async () => {
    let created = 0;
    const result: any = await openTabTool.execute({ url: 'http://127.0.0.1/admin' }, {
      tabs: { create: async () => { created += 1; return { id: 9 }; } },
    } as any);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('browser_private_network_blocked');
    expect(result.structured).toMatchObject({
      reason: 'private_network', stage: 'pre_navigation', outcome: 'not_run',
    });
    expect(result.outcomeKind).toBe('pre-effect-failure');
    expect(created).toBe(0);
  });

  test('site_capture refuses a private owned tab before starting capture', async () => {
    let started = 0;
    let canceled = 0;
    const ctx: any = {
      actorType: 'web',
      activeTab: { id: 7, url: 'https://stale.example/', origin: 'https://stale.example' },
      tabs: { get: async () => ({ id: 7, url: 'http://127.0.0.1/private' }) },
      siteCapture: {
        start: async () => { started += 1; },
        stop: async () => ({}),
        cancel: async () => { canceled += 1; },
      },
    };
    await expect(siteCaptureTool.execute({ action: 'start' }, ctx))
      .rejects.toBeInstanceOf(BrowserAutomationPolicyError);
    expect(started).toBe(0);
    expect(canceled).toBe(1);
  });

  test('site_capture discards a prior capture when the owned tab is blank', async () => {
    let canceled = 0;
    const operation = siteCaptureTool.execute({ action: 'stop' }, {
      actorType: 'web',
      activeTab: { id: 7, url: 'https://stale.example/', origin: 'https://stale.example' },
      tabs: { get: async () => ({ id: 7, url: 'about:blank' }) },
      siteCapture: {
        start: async () => ({}),
        stop: async () => ({}),
        cancel: async () => { canceled += 1; },
      },
    } as any);

    await expect(operation).rejects.toMatchObject({
      code: 'browser_target_scheme_blocked',
    });
    expect(canceled).toBe(1);
  });

  test('site_capture scopes the live origin and API sibling for attributed digesting', async () => {
    let input: any = null;
    const ctx: any = {
      actorType: 'web',
      activeTab: { id: 7, url: 'https://stale.example/', origin: 'https://stale.example' },
      tabs: { get: async () => ({ id: 7, url: 'https://live.example/path' }) },
      scripting: {
        executeScript: async (request: any) => browserProbeResult(request, {
          url: 'https://live.example/path',
        }),
      },
      siteCapture: {
        start: async (value: any) => { input = value; return { tap: 'test' }; },
        stop: async () => ({}),
      },
    };
    const result: any = await siteCaptureTool.execute({ action: 'start' }, ctx);
    expect(result.ok).toBe(true);
    expect(input).toEqual({
      tabId: 7,
      origins: ['https://live.example', 'https://api.live.example'],
      documentId: TEST_DOCUMENT_ID,
      expectedDocument: {
        origin: 'https://live.example',
        href: 'https://live.example/path',
        documentId: TEST_DOCUMENT_ID,
        timeOrigin: TEST_TIME_ORIGIN,
      },
    });
  });

  test('an empty attributed capture directs split-host sites to the API actor', async () => {
    const ctx: any = {
      actorType: 'web',
      activeTab: { id: 7, url: 'https://app.example/', origin: 'https://app.example' },
      tabs: { get: async () => ({ id: 7, url: 'https://app.example/' }) },
      scripting: {
        executeScript: async (request: any) => browserProbeResult(request, {
          url: 'https://app.example/',
        }),
      },
      siteCapture: {
        start: async () => ({ tap: 'test' }),
        stop: async () => ({ endpoints: [], dropped: 3 }),
      },
    };
    const result: any = await siteCaptureTool.execute({ action: 'stop' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain('another origin');
    expect(result.content).toContain('exact API actor');
    expect(result.content).toContain('never inferred as shared custody');
  });

  test('split-host capture output keeps endpoint evidence attributed per origin', async () => {
    const ctx: any = {
      actorType: 'web',
      activeTab: { id: 7, url: 'https://app.example/', origin: 'https://app.example' },
      tabs: { get: async () => ({ id: 7, url: 'https://app.example/' }) },
      scripting: {
        executeScript: async (request: any) => browserProbeResult(request, { url: 'https://app.example/' }),
      },
      siteCapture: {
        start: async () => ({ tap: 'test' }),
        stop: async () => ({
          deriver: 'capture-tap', dropped: 0,
          originDigests: [
            { origin: 'https://app.example', auth: 'session', endpoints: [{ method: 'GET', path: '/me' }] },
            { origin: 'https://api.app.example', auth: 'bearer', endpoints: [{ method: 'POST', path: '/v1/items' }] },
          ],
        }),
      },
    };
    const result: any = await siteCaptureTool.execute({ action: 'stop' }, ctx);
    expect(result.ok).toBe(true);
    expect(result.content).toContain('origin: https://app.example (owned tab)');
    expect(result.content).toContain('origin: https://api.app.example (related observation; separate custody)');
    expect(result.content).toContain('POST /v1/items');
    expect(result.content).toContain('delegate to that exact API actor');
  });
});
