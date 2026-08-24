import { beforeAll, describe, expect, test } from 'bun:test';

let createPageActivityReporter: typeof import('../../extension/background/page-activity.js').createPageActivityReporter;

beforeAll(async () => {
  // The shared bootstrap provides the browser namespace; this suite injects
  // every browser operation it executes.
  const module = await import('../../extension/background/page-activity.js');
  createPageActivityReporter = module.createPageActivityReporter;
});

const depsFor = (href: string) => {
  const calls: any[] = [];
  return {
    calls,
    deps: {
      tabs: {},
      scripting: {
        executeScript: async (request: any) => {
          calls.push(request);
          if (calls.length === 1) {
            return [{
              documentId: 'document-1',
              result: { origin: new URL(href).origin, href },
            }];
          }
          return [{ documentId: 'document-1', result: true }];
        },
      },
    },
  };
};

describe('page activity browser target policy', () => {
  test('reporter refuses a private page before overlay mutation', async () => {
    const { calls, deps } = depsFor('http://127.0.0.1/admin');
    const reporter = createPageActivityReporter(deps as any);
    await reporter.begin(7, 'Reading', '');
    expect(reporter.markedTabs()).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test('reporter refuses a denylisted page before overlay mutation', async () => {
    const { calls, deps } = depsFor('https://accounts.example.com/login');
    const reporter = createPageActivityReporter(deps as any);
    await reporter.begin(7, 'Reading', '', {
      denylist: ['accounts.example.com'],
    });
    expect(reporter.markedTabs()).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test('reporter refuses a document outside the owned origin', async () => {
    const { calls, deps } = depsFor('https://other.example/work');
    const reporter = createPageActivityReporter(deps as any);
    await reporter.begin(7, 'Reading', 'https://example.com');
    expect(reporter.markedTabs()).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test('reporter cleanup remains pinned to the document accepted at begin', async () => {
    const { calls, deps } = depsFor('https://example.com/work');
    const reporter = createPageActivityReporter(deps as any);
    await reporter.begin(7, 'Reading', 'https://example.com');
    await reporter.end(7);
    await reporter.idle(7);

    expect(calls).toHaveLength(4);
    expect(calls.slice(1).every((call) => (
      call.target.documentIds?.[0] === 'document-1'
    ))).toBe(true);
    expect(calls.filter((call) => call.func?.name === 'liveDocumentLocationInjected')).toHaveLength(1);
  });

  test('a slow begin is ordered before fast end and idle cleanup', async () => {
    const calls: any[] = [];
    let resolveProbe: (value: any) => void = () => {};
    let markProbeStarted: () => void = () => {};
    const probeStarted = new Promise<void>((resolve) => { markProbeStarted = resolve; });
    const deps = {
      tabs: {},
      scripting: {
        executeScript: (request: any) => {
          calls.push(request);
          if (calls.length === 1) {
            return new Promise((resolve) => {
              resolveProbe = resolve;
              markProbeStarted();
            });
          }
          return Promise.resolve([{ documentId: 'document-1', result: true }]);
        },
      },
    };
    const reporter = createPageActivityReporter(deps as any);
    const begin = reporter.begin(7, 'Reading', 'https://example.com');
    await probeStarted;
    const end = reporter.end(7);
    const idle = reporter.idle(7);
    resolveProbe([{
      documentId: 'document-1',
      result: { origin: 'https://example.com', href: 'https://example.com/work' },
    }]);
    await Promise.all([begin, end, idle]);

    expect(calls.map((call) => call.func?.name)).toEqual([
      'liveDocumentLocationInjected',
      'activityOverlayInjected',
      'activityOverlayInjected',
      'clearActivityOverlayInjected',
    ]);
    expect(calls.slice(1).every((call) => call.target.documentIds?.[0] === 'document-1')).toBe(true);
  });

  test('an existing user tab group is not rewritten', async () => {
    const grouped: any[] = [];
    const moved: any[] = [];
    const colors: string[] = [];
    let scripts = 0;
    const reporter = createPageActivityReporter({
      tabs: {
        get: async () => ({ id: 7, windowId: 2, groupId: 12, index: 4 }),
        group: async (request: any) => { grouped.push(request); return 99; },
        move: async (tabId: number, request: any) => { moved.push({ tabId, ...request }); },
        ungroup: async () => {},
      },
      tabGroups: {
        query: async () => [],
        update: async (_groupId: number, request: any) => { colors.push(request.color); },
      },
      scripting: {
        executeScript: async () => {
          scripts++;
          return scripts === 1
            ? [{
              documentId: 'document-1',
              result: { origin: 'https://example.com', href: 'https://example.com/work' },
            }]
            : [{ documentId: 'document-1', result: true }];
        },
      },
    } as any);

    await reporter.begin(7, 'Reading', 'https://example.com');
    await reporter.release(7);

    expect(grouped).toEqual([]);
    expect(moved).toEqual([]);
    expect(colors).toEqual([]);
  });
});
