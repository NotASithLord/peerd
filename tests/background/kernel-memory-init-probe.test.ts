import { describe, expect, test } from 'bun:test';
import { createKernelMemoryInitProbe } from '../../extension/background/kernel-memory-init-probe.js';

describe('kernel memory init probe', () => {
  test('bounds an active-tab query that never settles', async () => {
    const probe = createKernelMemoryInitProbe({
      tabs: { query: () => new Promise(() => {}) },
      scripting: { executeScript: async () => [] },
      resolveTab: async () => null,
      timeoutMs: 5,
    });
    await expect(probe.probeTab()).resolves.toEqual({
      tab: null,
      warning: '/init skipped the browser page because the active-tab probe did not finish.',
    });
  });

  test('bounds document identity and detail probes independently', async () => {
    const tab = { id: 7, url: 'https://example.test/work' };
    const identityHung = createKernelMemoryInitProbe({
      tabs: { query: async () => [tab], get: async () => tab },
      scripting: { executeScript: async () => [] },
      resolveTab: () => new Promise(() => {}),
      timeoutMs: 5,
    });
    await expect(identityHung.probeTab()).resolves.toMatchObject({
      tab: null,
      warning: expect.stringContaining('current document'),
    });

    const detailsHung = createKernelMemoryInitProbe({
      tabs: { query: async () => [tab], get: async () => tab },
      scripting: {
        executeScript: () => new Promise(() => {}),
      },
      resolveTab: async () => ({ ...tab, peerdDocumentId: 'document:1' }),
      timeoutMs: 5,
    });
    await expect(detailsHung.probeTab()).resolves.toEqual({
      tab: { url: tab.url },
      warning: '/init skipped browser page details because the document probe did not finish.',
    });
  });

  test('distinguishes omitted foreground, explicit no-tab, and one exact tab', async () => {
    const queried = { active: 0, exact: [] as number[] };
    const tab = { id: 7, url: 'https://example.test/work' };
    const probe = createKernelMemoryInitProbe({
      tabs: {
        query: async () => { queried.active += 1; return [tab]; },
        get: async (id: number) => { queried.exact.push(id); return id === 7 ? tab : null; },
      },
      scripting: { executeScript: async () => [{ result: { title: 'Work' } }] },
      resolveTab: async (candidate: any) => candidate?.id === 7
        ? { ...tab, peerdDocumentId: 'document:7' } : null,
    });
    await expect(probe.probeTab({ activeTabSpecified: true, activeTabId: null }))
      .resolves.toEqual({ tab: null });
    expect(queried).toEqual({ active: 0, exact: [] });
    await expect(probe.probeTab({ activeTabSpecified: true, activeTabId: 7 }))
      .resolves.toMatchObject({ tab: { url: tab.url, title: 'Work' } });
    expect(queried).toEqual({ active: 0, exact: [7] });
    await expect(probe.probeTab()).resolves.toMatchObject({ tab: { url: tab.url } });
    expect(queried.active).toBe(1);
  });

  test('a missing exact tab and a replaced document refuse without foreground fallback', async () => {
    let queries = 0;
    let resolutions = 0;
    const tab = { id: 7, url: 'https://example.test/work' };
    const missing = createKernelMemoryInitProbe({
      tabs: {
        query: async () => { queries += 1; return [tab]; },
        get: async () => { throw new Error('closed'); },
      },
      scripting: { executeScript: async () => [] },
      resolveTab: async () => null,
    });
    await expect(missing.probeTab({ activeTabSpecified: true, activeTabId: 7 }))
      .resolves.toMatchObject({ tab: null, warning: expect.stringContaining('bound tab') });
    expect(queries).toBe(0);

    const replaced = createKernelMemoryInitProbe({
      tabs: { query: async () => [], get: async () => tab },
      scripting: { executeScript: async () => [{ result: { title: 'Old' } }] },
      resolveTab: async () => {
        resolutions += 1;
        return resolutions === 1
          ? { ...tab, peerdDocumentId: 'document:old' }
          : { ...tab, peerdDocumentId: 'document:new' };
      },
    });
    await expect(replaced.probeTab({ activeTabSpecified: true, activeTabId: 7 }))
      .resolves.toMatchObject({ tab: null, warning: expect.stringContaining('changed') });
  });
});
