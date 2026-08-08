import { describe, expect, test } from 'bun:test';
import {
  makeInitOrchestrator,
  probeInitTabInjected,
} from '../../../extension/peerd-runtime/memory/init-orchestrator.js';
import { browserProbeResult, TEST_DOCUMENT_ID } from '../../helpers/browser-scripting.ts';

const makeHarness = ({ tabUrl, liveUrl = tabUrl }: { tabUrl: string; liveUrl?: string }) => {
  const scriptingCalls: any[] = [];
  const notes: string[] = [];
  let written: any = null;
  const tabs = {
    query: async () => [{ id: 7, url: tabUrl, title: 'Private title token-private' }],
    get: async () => ({ id: 7, url: tabUrl, title: 'Public workspace' }),
  };
  const scripting = {
    executeScript: async (request: any) => {
      scriptingCalls.push(request);
      const probe = browserProbeResult(request, { url: liveUrl });
      if (probe) return probe;
      if (request.func === probeInitTabInjected) {
        return [{
          documentId: TEST_DOCUMENT_ID,
          result: {
            title: 'Exact public title',
            headings: ['Project heading'],
            textSnippet: 'Public project summary',
          },
        }];
      }
      throw new Error('unexpected script');
    },
  };
  const orchestrator = makeInitOrchestrator({
    tabs,
    scripting,
    listApps: async () => [],
    memory: {
      writeWithConfirm: async (request: any) => { written = request; return {}; },
      ensureInitializer: async () => ({}),
    },
    confirm: async () => 'yes_once' as const,
    postChatNote: (note: string) => notes.push(note),
    getDenylist: () => [],
  });
  return {
    orchestrator,
    notes,
    scriptingCalls,
    written: () => written,
  };
};

describe('/init browser target policy', () => {
  test('an internal browser page contributes no URL or title to durable memory', async () => {
    const harness = makeHarness({ tabUrl: 'chrome://history/?q=medical-private-term' });
    await harness.orchestrator.runInit();

    expect(harness.scriptingCalls).toHaveLength(0);
    expect(harness.written().body).not.toContain('chrome://');
    expect(harness.written().body).not.toContain('medical-private-term');
    expect(harness.written().body).not.toContain('token-private');
    expect(harness.notes.some((note) =>
      note === '/init skipped the browser page because this URL type cannot be verified.')).toBe(true);
  });

  test('a direct private page is excluded from durable memory without scripting', async () => {
    const privateUrl = 'http://127.0.0.1/admin?token=private-secret';
    const harness = makeHarness({ tabUrl: privateUrl });
    await harness.orchestrator.runInit();

    expect(harness.scriptingCalls).toHaveLength(0);
    expect(harness.written().body).not.toContain('127.0.0.1');
    expect(harness.written().body).not.toContain('/admin');
    expect(harness.written().body).not.toContain('private-secret');
    const warning = harness.notes.find((note) => note.includes('browser_private_network_blocked')) ?? '';
    expect(warning).toContain('/init skipped the browser page');
    expect(warning).not.toContain('/admin');
    expect(warning).not.toContain('token=');
    expect(warning).not.toContain('private-secret');
  });

  test('a public record replaced by a private document is excluded before the page probe', async () => {
    const harness = makeHarness({
      tabUrl: 'https://example.com/work',
      liveUrl: 'http://192.168.1.20/admin?token=private-secret',
    });
    await harness.orchestrator.runInit();

    expect(harness.scriptingCalls).toHaveLength(1);
    expect(harness.scriptingCalls[0].target).toEqual({ tabId: 7 });
    expect(harness.written().body).not.toContain('192.168.1.20');
    expect(harness.written().body).not.toContain('/admin');
    expect(harness.written().body).not.toContain('private-secret');
    const warning = harness.notes.find((note) => note.includes('browser_private_network_blocked')) ?? '';
    expect(warning).not.toContain('/admin');
    expect(warning).not.toContain('token=');
    expect(warning).not.toContain('private-secret');
  });

  test('an allowed page summary is read from the exact verified document', async () => {
    const harness = makeHarness({ tabUrl: 'https://example.com/work' });
    await harness.orchestrator.runInit();

    expect(harness.scriptingCalls).toHaveLength(3);
    expect(harness.scriptingCalls[2].func).toBe(probeInitTabInjected);
    expect(harness.scriptingCalls[2].target).toEqual({
      tabId: 7,
      documentIds: [TEST_DOCUMENT_ID],
    });
    expect(harness.written().body).toContain('https://example.com/work');
    expect(harness.written().body).toContain('Exact public title');
    expect(harness.written().body).not.toContain('token-private');
    expect(harness.written().body).toContain('Project heading');
    expect(harness.written().body).toContain('Public project summary');
  });
});
