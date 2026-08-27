import { describe, expect, test } from 'bun:test';
import {
  makeKernelHooksRoutes,
  makeKernelMemoryInitRoutes,
  makeKernelSkillInstallRoutes,
} from '../../extension/background/kernel-administrative-routes.js';

const writeRefusal = () => {
  const error: any = new Error('profile schema is newer than this build');
  error.code = 'store-read-only';
  return error;
};

describe('kernel administrative routes', () => {
  test('rich dependencies stay cold and keep one construction after timeout', async () => {
    let loads = 0;
    let release!: (value: any) => void;
    const pending = new Promise((resolve) => { release = resolve; });
    const live = {
      auditLog: { append: async () => {} },
      kv: { get: async () => [], set: async () => {} },
      listHooks: () => [], DEFAULT_HOOKS: [], parseHookMarkdown: () => ({}),
      saveUserHook: async () => ({}), removeHook: async () => {}, exportHooks: () => [],
    };
    const routes = makeKernelHooksRoutes({
      loadTimeoutMs: 1,
      load: () => { loads += 1; return pending; },
    });
    expect(loads).toBe(0);
    await expect(routes['hooks/list']()).rejects.toMatchObject({
      code: 'kernel-route-owner-timeout', outcomeKnown: true,
    });
    expect(loads).toBe(1);
    release(live);
    expect(await routes['hooks/list']()).toEqual({ ok: true, hooks: [] });
    expect(loads).toBe(1);
  });

  test('hooks preserve the editor contract and guard the exact persistence effect', async () => {
    const stored = new Map<string, any>();
    const audits: any[] = [];
    let guards = 0;
    const routes = makeKernelHooksRoutes({
      auditLog: { append: async (entry: any) => { audits.push(entry); } },
      kv: {
        get: async (key: string) => structuredClone(stored.get(key)),
        set: async (key: string, value: any) => { stored.set(key, structuredClone(value)); },
      },
      canWrite: () => { guards += 1; },
      listHooks: () => [{ id: 'default', event: 'pre-tool-use', enabled: true }],
      DEFAULT_HOOKS: [{ id: 'default' }],
      parseHookMarkdown: () => ({ id: 'user', event: 'post-tool-use', kind: 'rule' }),
      saveUserHook: async ({ kv }: any, record: any) => {
        await kv.set('hooks.user.v1', [record]);
        return { id: record.id };
      },
      removeHook: async ({ kv }: any) => { await kv.set('hooks.user.v1', []); },
      exportHooks: () => [{ id: 'user', event: 'post-tool-use', kind: 'rule' }],
    });

    expect(Object.keys(routes).sort()).toEqual([
      'hooks/list', 'hooks/remove', 'hooks/save', 'hooks/toggle',
    ]);
    expect(await routes['hooks/list']()).toMatchObject({
      ok: true, hooks: [{ id: 'default', isDefault: true }],
    });
    expect(guards).toBe(0);
    expect(await routes['hooks/save']({ markdown: '# user' }))
      .toEqual({ ok: true, id: 'user' });
    expect(await routes['hooks/toggle']({ id: 'user', enabled: false }))
      .toEqual({ ok: true });
    expect(await routes['hooks/remove']({ id: 'user' })).toEqual({ ok: true });
    expect(guards).toBe(3);
    expect(audits.map((entry) => entry.type)).toEqual([
      'hook_added', 'hook_disabled', 'hook_removed',
    ]);
  });

  test('hook loss after set dispatch is outcome-unknown while a write refusal stays known', async () => {
    const deps: any = {
      auditLog: { append: async () => {} },
      kv: { get: async () => [], set: async () => { throw new Error('lost'); } },
      listHooks: () => [], DEFAULT_HOOKS: [],
      parseHookMarkdown: () => ({ id: 'user', event: 'post-tool-use', kind: 'rule' }),
      saveUserHook: async ({ kv }: any, record: any) => {
        await kv.set('hooks.user.v1', [record]); return { id: record.id };
      },
      removeHook: async ({ kv }: any) => { await kv.set('hooks.user.v1', []); },
      exportHooks: () => [],
    };
    expect(await makeKernelHooksRoutes(deps)['hooks/save']({ markdown: '# user' }))
      .toMatchObject({ ok: false, outcomeKnown: false, retryable: false });

    const refused = makeKernelHooksRoutes({
      ...deps,
      kv: { get: async () => [], set: async () => {} },
      canWrite: () => { throw writeRefusal(); },
    });
    await expect(refused['hooks/save']({ markdown: '# user' }))
      .rejects.toThrow('profile schema is newer than this build');
  });

  test('skill installs stay demand injected and preserve known validation failures', async () => {
    class SkillExistsError extends Error {}
    class SkillParseError extends Error {}
    class SkillInstallError extends Error {}
    const installed: string[] = [];
    let guards = 0;
    const deps: any = {
      skillRegistry: {
        install: async (text: string) => { installed.push(text); return { name: text }; },
      },
      webFetch: async () => new Response(''),
      pushState: () => {},
      REMOTE_SKILL_INSTALL: true,
      installFromLocal: ({ registry }: any, { text }: any) => registry.install(text),
      installFromGit: ({ registry }: any, { url }: any) => registry.install(url),
      installFromManifest: async ({ registry }: any) => ({
        installed: [await registry.install('manifest')], failed: [],
      }),
      SkillExistsError, SkillParseError, SkillInstallError,
      canWrite: () => { guards += 1; },
    };
    const routes = makeKernelSkillInstallRoutes(deps);
    expect(Object.keys(routes).sort()).toEqual([
      'skills/installGit', 'skills/installLocal', 'skills/installManifest',
    ]);
    expect(await routes['skills/installLocal']({ text: 'local' }))
      .toEqual({ ok: true, skill: { name: 'local' } });
    expect(await routes['skills/installGit']({ url: 'https://example.test/skill' }))
      .toEqual({ ok: true, skill: { name: 'https://example.test/skill' } });
    expect(await routes['skills/installManifest']({ url: 'https://example.test/list' }))
      .toEqual({ ok: true, installed: [{ name: 'manifest' }], failed: [] });
    expect(installed).toEqual(['local', 'https://example.test/skill', 'manifest']);
    expect(guards).toBe(3);

    const invalid = makeKernelSkillInstallRoutes({
      ...deps,
      skillRegistry: { install: async () => { throw new SkillParseError('bad'); } },
    });
    expect(await invalid['skills/installLocal']({ text: 'bad' }))
      .toEqual({ ok: false, error: 'parse-failed', detail: 'bad' });
  });

  test('a swallowed manifest persistence loss is still outcome-unknown', async () => {
    class SkillExistsError extends Error {}
    class SkillParseError extends Error {}
    class SkillInstallError extends Error {}
    const routes = makeKernelSkillInstallRoutes({
      skillRegistry: { install: async () => { throw new Error('storage lost'); } },
      webFetch: async () => new Response(''), pushState: () => {},
      REMOTE_SKILL_INSTALL: true,
      installFromLocal: () => { throw new Error('unused'); },
      installFromGit: () => { throw new Error('unused'); },
      installFromManifest: async ({ registry }: any) => {
        const failed = [];
        try { await registry.install('one'); }
        catch (error: any) { failed.push({ url: 'one', error: error.message }); }
        return { installed: [], failed };
      },
      SkillExistsError, SkillParseError, SkillInstallError,
    });
    expect(await routes['skills/installManifest']({ url: 'https://example.test/list' }))
      .toMatchObject({ ok: false, outcomeKnown: false, retryable: false });
  });

  test('/init keeps its accepted-then-note UX and checks write posture first', async () => {
    const notes: string[] = [];
    let ran = 0;
    const routes = makeKernelMemoryInitRoutes({
      canWrite: () => { throw writeRefusal(); },
      runInit: async () => { ran += 1; },
      postChatNote: (note: string) => { notes.push(note); },
    });
    expect(await routes['memory/init']()).toEqual({ ok: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ran).toBe(0);
    expect(notes).toEqual(['/init failed: profile schema is newer than this build']);
  });

});
