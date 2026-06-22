import { describe, test, expect } from 'bun:test';
import { makeHooksRoutes } from '../../extension/background/routes/hooks.js';
import { makeSkillsRoutes } from '../../extension/background/routes/skills.js';

// hooks / skills route groups. These pin the branching that matters:
// default-hook protection, and remote-skill-install gating + typed-error mapping.

describe('hooks routes', () => {
  const DEFAULT_HOOKS = [{ id: 'egress-allowlist' }];
  const deps = (over: any = {}) => ({
    auditLog: { append: async () => {} },
    kv: {},
    listHooks: () => [{ id: 'egress-allowlist', event: 'preToolUse', enabled: true, description: 'floor' }, { id: 'u1', event: 'postToolUse', enabled: false, _record: { kind: 'js', doc: 'mine' } }],
    DEFAULT_HOOKS,
    parseHookMarkdown: (_m: string) => ({ id: 'u2', event: 'preToolUse', kind: 'js' }),
    saveUserHook: async (_io: any, rec: any) => ({ id: rec.id ?? 'u2' }),
    removeHook: async () => {},
    exportHooks: () => [{ id: 'u1', event: 'postToolUse', enabled: false }],
    ...over,
  });
  test('list marks defaults + carries provenance', async () => {
    const r = makeHooksRoutes(deps());
    const res = await r['hooks/list']();
    expect(res.hooks[0]).toMatchObject({ id: 'egress-allowlist', isDefault: true, kind: 'builtin', doc: 'floor' });
    expect(res.hooks[1]).toMatchObject({ id: 'u1', isDefault: false, kind: 'js', doc: 'mine', enabled: false });
  });
  test('remove refuses a default hook', async () => {
    const r = makeHooksRoutes(deps());
    expect(await r['hooks/remove']({ id: 'egress-allowlist' })).toEqual({ ok: false, error: 'cannot remove a default hook' });
  });
  test('toggle refuses a default hook', async () => {
    const r = makeHooksRoutes(deps());
    expect(await r['hooks/toggle']({ id: 'egress-allowlist', enabled: false })).toEqual({ ok: false, error: 'cannot disable a built-in hook' });
  });
  test('toggle unknown user hook → not-found', async () => {
    const r = makeHooksRoutes(deps({ exportHooks: () => [] }));
    expect(await r['hooks/toggle']({ id: 'ghost', enabled: true })).toEqual({ ok: false, error: 'not-found' });
  });
  test('save compile error surfaces as ok:false', async () => {
    const r = makeHooksRoutes(deps({ saveUserHook: async () => { throw new Error('bad hook'); } }));
    expect(await r['hooks/save']({ markdown: '# x' })).toEqual({ ok: false, error: 'bad hook' });
  });
  test('save ok returns compiled id', async () => {
    const r = makeHooksRoutes(deps());
    expect(await r['hooks/save']({ markdown: '# x' })).toEqual({ ok: true, id: 'u2' });
  });
});

describe('skills routes', () => {
  class SkillExistsError extends Error {}
  class SkillParseError extends Error {}
  class SkillInstallError extends Error {}
  const deps = (over: any = {}) => ({
    skillRegistry: {
      list: async () => [{ name: 's1' }],
      setEnabled: async (name: string, on: boolean) => ({ name, enabled: on }),
      remove: async () => true,
    },
    webFetch: async () => new Response('{}'),
    pushState: () => {},
    REMOTE_SKILL_INSTALL: false,
    installFromLocal: async (_io: any, _a: any) => ({ name: 'local' }),
    installFromGit: async () => ({ name: 'git' }),
    installFromManifest: async () => ({ installed: ['a'], failed: [] }),
    SkillExistsError, SkillParseError, SkillInstallError,
    ...over,
  });
  test('installGit blocked when remote install disabled', async () => {
    const r = makeSkillsRoutes(deps());
    expect(await r['skills/installGit']({ url: 'https://x' })).toEqual({ ok: false, error: 'remote-install-disabled' });
  });
  test('installManifest blocked when remote install disabled', async () => {
    const r = makeSkillsRoutes(deps());
    expect(await r['skills/installManifest']({ url: 'https://x' })).toEqual({ ok: false, error: 'remote-install-disabled' });
  });
  test('installGit allowed when enabled, missing url → url-required', async () => {
    const r = makeSkillsRoutes(deps({ REMOTE_SKILL_INSTALL: true }));
    expect(await r['skills/installGit']({ url: '  ' })).toEqual({ ok: false, error: 'url-required' });
  });
  test('installLocal maps SkillExistsError → already-installed', async () => {
    const r = makeSkillsRoutes(deps({ installFromLocal: async () => { throw new SkillExistsError('dup'); } }));
    expect(await r['skills/installLocal']({ text: 'x' })).toEqual({ ok: false, error: 'already-installed', detail: 'dup' });
  });
  test('installLocal maps SkillParseError → parse-failed', async () => {
    const r = makeSkillsRoutes(deps({ installFromLocal: async () => { throw new SkillParseError('nope'); } }));
    expect(await r['skills/installLocal']({ text: 'x' })).toEqual({ ok: false, error: 'parse-failed', detail: 'nope' });
  });
  test('installLocal ok → skill meta', async () => {
    const r = makeSkillsRoutes(deps());
    expect(await r['skills/installLocal']({ text: 'x' })).toEqual({ ok: true, skill: { name: 'local' } });
  });
  test('setEnabled requires a name', async () => {
    const r = makeSkillsRoutes(deps());
    expect(await r['skills/setEnabled']({ enabled: true })).toEqual({ ok: false, error: 'name-required' });
  });
  test('remove returns removed flag', async () => {
    const r = makeSkillsRoutes(deps());
    expect(await r['skills/remove']({ name: 's1' })).toEqual({ ok: true, removed: true });
  });
});
