import { describe, expect, test } from 'bun:test';
import {
  resetToVerifiedBlank,
  updateAndObserveCommittedNavigation,
} from '../../../extension/peerd-runtime/tools/defs/committed-navigation.js';

describe('committed navigation observation', () => {
  test('ignores a stale complete event until the requested transition completes', async () => {
    let listener: any = null;
    let resolved = false;
    const tabs: any = {
      onUpdated: {
        addListener: (next: any) => { listener = next; },
        removeListener: () => { listener = null; },
      },
      update: async (tabId: number, props: { url: string }) => {
        listener?.(tabId, { status: 'complete' });
        return { id: tabId, pendingUrl: props.url, url: 'https://old.example/' };
      },
    };

    const observed = updateAndObserveCommittedNavigation(
      tabs,
      7,
      'https://new.example/path',
      { timeoutMs: 100 },
    ).then((result) => {
      resolved = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    listener?.(7, { status: 'loading', url: 'https://new.example/path' });
    expect(resolved).toBe(false);
    listener?.(7, { status: 'complete' });
    expect(await observed).toEqual({ status: 'complete' });
  });

  test('ignores a stale complete event even after tabs.update resolves', async () => {
    let listener: any = null;
    let resolved = false;
    const tabs: any = {
      onUpdated: {
        addListener: (next: any) => { listener = next; },
        removeListener: () => { listener = null; },
      },
      update: async (tabId: number, props: { url: string }) => ({
        id: tabId,
        pendingUrl: props.url,
        url: 'https://old.example/',
      }),
    };
    const observed = updateAndObserveCommittedNavigation(
      tabs,
      7,
      'https://new.example/path',
      { timeoutMs: 100 },
    ).then((result) => {
      resolved = true;
      return result;
    });
    await Promise.resolve();
    await Promise.resolve();
    listener?.(7, { status: 'complete' });
    await Promise.resolve();
    expect(resolved).toBe(false);
    listener?.(7, { status: 'loading', url: 'https://new.example/path' });
    listener?.(7, { status: 'complete' });
    expect(await observed).toEqual({ status: 'complete' });
  });

  test('reports timeout when only an unrelated completion is observed', async () => {
    let listener: any = null;
    const tabs: any = {
      onUpdated: {
        addListener: (next: any) => { listener = next; },
        removeListener: () => { listener = null; },
      },
      update: async (tabId: number) => {
        listener?.(tabId, { status: 'complete' });
        return { id: tabId, url: 'https://old.example/' };
      },
    };
    const result = await updateAndObserveCommittedNavigation(
      tabs,
      7,
      'https://new.example/',
      { timeoutMs: 5 },
    );
    expect(result).toEqual({ status: 'timeout' });
  });

  test('blank reset fails verification while another target remains pending', async () => {
    let listener: any = null;
    const tabs: any = {
      onUpdated: {
        addListener: (next: any) => { listener = next; },
        removeListener: () => { listener = null; },
      },
      update: async (tabId: number, props: { url: string }) => {
        queueMicrotask(() => {
          listener?.(tabId, { status: 'loading', url: props.url });
          listener?.(tabId, { status: 'complete' });
        });
        return { id: tabId, url: 'about:blank' };
      },
      get: async () => ({
        id: 7,
        url: 'about:blank',
        pendingUrl: 'http://127.0.0.1/private',
      }),
    };
    expect(await resetToVerifiedBlank(tabs, 7, { timeoutMs: 20 })).toBe(false);
  });
});
