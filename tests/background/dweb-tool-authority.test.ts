import { describe, expect, test } from 'bun:test';
import { createDwebToolAuthority } from '../../extension/background/dweb-tool-authority.js';

const prepared = Object.freeze({
  ok: true, appId: 'app-1', name: 'Example App', entryFile: 'index.html',
  fileCount: 2, totalBytes: 128, digest: 'a'.repeat(64),
});

describe('exact dweb authority', () => {
  test('pins publication arguments and confirms before mesh mutation', async () => {
    const events: string[] = [];
    let prompt: any = null;
    const authority = createDwebToolAuthority({
      binding: { operation: 'turn.dweb.publish-confirmed-app', args: { appId: 'app-1' } },
      ctx: {
        permission: { mode: 'act', confirmActions: false },
        confirm: async (received: any) => { events.push('confirm'); prompt = received; return 'yes_once'; },
        dweb: {
          prepareShare: async () => prepared,
          share: async (appId: string, received: any) => {
            events.push(`share:${appId}`);
            expect(received).toBe(prepared);
            return { ok: true, uri: 'peerd://app-1' };
          },
        },
      },
    });
    await expect(authority.publishConfirmedApp('app-2'))
      .rejects.toThrow('dweb authority mismatch');
    expect(await authority.publishConfirmedApp('app-1'))
      .toEqual({ ok: true, uri: 'peerd://app-1' });
    expect(events).toEqual(['confirm', 'share:app-1']);
    expect(prompt.summary).toContain('Example App');
    expect(prompt.summary).toContain('Entry: index.html');
    expect(prompt.summary).toContain('Files: 2; bytes: 128');
    expect(prompt.summary).toContain('tree: aaaaaaaaaaaaaaaa');
  });

  test('decline is known before publication and never reaches the mesh', async () => {
    let shared = false;
    const authority = createDwebToolAuthority({
      binding: { operation: 'turn.dweb.publish-confirmed-app', args: { appId: 'app-1' } },
      ctx: {
        permission: { mode: 'act', confirmActions: false },
        confirm: async () => 'no',
        dweb: {
          prepareShare: async () => prepared,
          share: async () => { shared = true; return { ok: true }; },
        },
      },
    });
    expect(await authority.publishConfirmedApp('app-1'))
      .toEqual({ ok: false, error: 'declined', declined: true });
    expect(shared).toBe(false);
  });

  test('failed share rollback preserves performed and unknown publication custody', async () => {
    const authority = createDwebToolAuthority({
      binding: { operation: 'turn.dweb.publish-confirmed-app', args: { appId: 'app-1' } },
      ctx: {
        permission: { mode: 'act', confirmActions: false },
        confirm: async () => 'yes_once',
        dweb: {
          prepareShare: async () => prepared,
          share: async () => ({ ok: false, error: 'share-rollback-failed' }),
        },
      },
    });
    await expect(authority.publishConfirmedApp('app-1')).resolves.toMatchObject({
      ok: false, error: 'share-rollback-failed', performed: true,
      outcomeKnown: false, outcomeKind: 'host-lost', retryable: false,
    });
  });

  test.each(['publish', 'install'] as const)(
    'Stop during the live permission read prevents %s mutation',
    async (kind) => {
      let permissionStarted!: () => void;
      let releasePermission!: () => void;
      const started = new Promise<void>((resolve) => { permissionStarted = resolve; });
      const gate = new Promise<void>((resolve) => { releasePermission = resolve; });
      const controller = new AbortController();
      let mutations = 0;
      const binding = kind === 'publish'
        ? { operation: 'turn.dweb.publish-confirmed-app', args: { appId: 'app-1' } }
        : { operation: 'turn.dweb.install-confirmed-app', args: {
            uri: 'peerd://bundle', name: 'Bundle',
          } };
      const authority = createDwebToolAuthority({
        binding,
        signal: controller.signal,
        ctx: {
          permission: { mode: 'act', confirmActions: false },
          confirm: async () => 'yes_once',
          readAuthorityPermission: async () => {
            permissionStarted();
            await gate;
            return { mode: 'act', confirmActions: false };
          },
          dweb: {
            prepareShare: async () => prepared,
            share: async () => { mutations += 1; return { ok: true }; },
            install: async () => { mutations += 1; return { ok: true }; },
          },
        },
      });
      const pending = kind === 'publish'
        ? authority.publishConfirmedApp('app-1')
        : authority.installConfirmedApp('peerd://bundle', 'Bundle');
      await started;
      controller.abort();
      releasePermission();
      await expect(pending).resolves.toMatchObject({ ok: false, error: 'declined' });
      expect(mutations).toBe(0);
    },
  );

  test('install confirmation distinguishes long common-prefix bundle identities', async () => {
    const prefix = `peerd://did:key:zPublisher/${'a'.repeat(560)}`;
    const summaries: string[] = [];
    for (const suffix of ['bundle-one', 'bundle-two']) {
      const uri = `${prefix}${suffix}`;
      const authority = createDwebToolAuthority({
        binding: { operation: 'turn.dweb.install-confirmed-app', args: { uri, name: 'Bundle' } },
        ctx: {
          permission: { mode: 'act', confirmActions: false },
          confirm: async (prompt: any) => { summaries.push(prompt.summary); return 'no'; },
          dweb: { install: async () => ({ ok: true }) },
        },
      });
      await authority.installConfirmedApp(uri, 'Bundle');
    }
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).not.toBe(summaries[1]);
    expect(summaries[0]).toContain('bundle-one');
    expect(summaries[1]).toContain('bundle-two');
    expect(summaries.every((summary) => /URI SHA-256: [a-f0-9]{64}/.test(summary))).toBe(true);
    expect(summaries.every((summary) => summary.includes('Requested name: Bundle'))).toBe(true);
  });
});
