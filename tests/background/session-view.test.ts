import { describe, expect, test } from 'bun:test';
import { makeSessionKernelRoutes } from '../../extension/background/routes/sessions.js';

const makeRoutes = (overrides: Record<string, any> = {}) => makeSessionKernelRoutes({
  vault: { isLocked: () => false },
  commandSources: { list: async () => [] },
  browser: { tabs: { query: async () => [] } },
  originOfTabUrl: (url: string) => { try { return new URL(url).origin; } catch { return ''; } },
  matchesDenylist: (host: string, patterns: string[]) => patterns.includes(host),
  denylistStore: { patterns: () => ['bank.example'] },
  sessionCache: { sessionGet: async () => 'chat' },
  appClient: { listFiles: async () => [] },
  sessions: { list: async () => [], get: async () => null },
  manifestLabel: (manifest: any) => manifest?.preset ?? null,
  contextSnapshots: { snapshotsFor: () => [] },
  ...overrides,
});

describe('controller-independent session routes', () => {
  test('live routes preserve response shapes while excluding private source fields', async () => {
    const commands = [
      { name: 'review', description: 'Review it', body: 'private command body', source: 'user' },
      { name: 'plain', body: 'also private' },
    ];
    const tabs = [
      { id: 1, title: 'Allowed', url: 'https://example.com/private/path?q=secret', active: true },
      { id: 2, title: 'Bank', url: 'https://bank.example/account', active: false },
      { id: 3, title: 'Browser', url: 'chrome://settings', active: false },
    ];
    const files = [
      'src/main.js', { path: 'notes.md', content: 'private file body', digest: 'secret' },
    ];
    const sessions = [
      { sessionId: 'chat', title: 'Main', createdAt: 1,
        messages: [{ when: 2, content: 'private transcript' }], provider: 'p', model: 'm',
        customSystemPrompt: 'private prompt', toolManifest: { preset: 'research' } },
      { sessionId: 'actor', kind: 'actor', createdAt: 3,
        messages: [{ when: 4, content: 'private child transcript' }] },
    ];
    const routes = makeRoutes({
      commandSources: { list: async () => commands },
      browser: { tabs: { query: async () => tabs } },
      appClient: { listFiles: async () => files },
      sessions: { list: async () => sessions, get: async () => null },
    });

    const results = {
      commands: await routes['commands/list'](),
      tabs: await routes['composer/tabs'](),
      files: await routes['composer/files'](),
      sessions: await routes['session/list'](),
    };
    expect(results.commands).toEqual({ ok: true, commands: [
      { name: 'review', description: 'Review it' }, { name: 'plain', description: '' },
    ] });
    expect(results.tabs).toEqual({ ok: true, tabs: [
      { id: 1, title: 'Allowed', origin: 'https://example.com', active: true, blocked: false },
      { id: 2, title: 'Bank', origin: 'https://bank.example', active: false, blocked: true },
      { id: 3, title: 'Browser', origin: 'null', active: false, blocked: true },
    ] });
    expect(results.files).toEqual({ ok: true, files: ['src/main.js', 'notes.md'] });
    expect(results.sessions).toEqual({ ok: true, sessions: [{
      sessionId: 'chat', title: 'Main', createdAt: 1, lastMessageAt: 2,
      messageCount: 1, archived: false, provider: 'p', model: 'm',
      hasCustomSystemPrompt: true, toolManifestLabel: 'research',
    }] });
    const serialized = JSON.stringify(results);
    for (const secret of [
      'private command body', '/private/path', 'private file body',
      'private transcript', 'private prompt', 'private child transcript',
    ]) expect(serialized).not.toContain(secret);
  });

  test('locked and read-failure paths do not touch protected stores', async () => {
    const calls: string[] = [];
    const locked = makeRoutes({
      vault: { isLocked: () => true },
      sessionCache: { sessionGet: async () => { calls.push('session-cache'); return 'sid'; } },
      appClient: { listFiles: async () => { calls.push('app-files'); return []; } },
      sessions: { list: async () => { calls.push('sessions'); return []; } },
    });
    await expect(locked['composer/files']()).resolves.toEqual({ ok: true, files: [] });
    await expect(locked['session/list']()).resolves.toEqual({ ok: false, error: 'locked' });
    expect(calls).toEqual([]);

    const failedReads = makeRoutes({
      browser: { tabs: { query: async () => { throw new Error('tabs unavailable'); } } },
      appClient: { listFiles: async () => { throw new Error('app unavailable'); } },
    });
    await expect(failedReads['composer/tabs']()).resolves.toEqual({ ok: true, tabs: [] });
    await expect(failedReads['composer/files']()).resolves.toEqual({ ok: true, files: [] });
  });
});
