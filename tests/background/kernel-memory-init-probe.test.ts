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
});
