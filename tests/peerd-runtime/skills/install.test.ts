import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';
import { useFakeIndexedDB } from '../../setup.ts';
import type { ToolContext } from '../../../extension/shared/tool-types.js';

let store: typeof import('../../../extension/peerd-runtime/skills/store.js');
let reg: typeof import('../../../extension/peerd-runtime/skills/registry.js');
let install: typeof import('../../../extension/peerd-runtime/skills/install.js');
let tool: typeof import('../../../extension/peerd-runtime/skills/load-skill-tool.js');

beforeAll(async () => {
  await useFakeIndexedDB();
  store = await import('../../../extension/peerd-runtime/skills/store.js');
  reg = await import('../../../extension/peerd-runtime/skills/registry.js');
  install = await import('../../../extension/peerd-runtime/skills/install.js');
  tool = await import('../../../extension/peerd-runtime/skills/load-skill-tool.js');
});

beforeEach(async () => {
  await new Promise<void>((resolve) => {
    const req = globalThis.indexedDB.deleteDatabase('peerd-skills');
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
});

const SKILL = '---\nname: demo\ndescription: A demo skill.\n---\n# Demo\nbody text';

describe('resolveGitRawUrl', () => {
  test('rewrites a GitHub blob URL to raw.githubusercontent.com', () => {
    const r = install.resolveGitRawUrl('https://github.com/u/repo/blob/main/skills/demo/SKILL.md');
    expect(r).toBe('https://raw.githubusercontent.com/u/repo/main/skills/demo/SKILL.md');
  });

  test('appends SKILL.md to a GitHub tree (directory) URL', () => {
    const r = install.resolveGitRawUrl('https://github.com/u/repo/tree/main/skills/demo');
    expect(r).toBe('https://raw.githubusercontent.com/u/repo/main/skills/demo/SKILL.md');
  });

  test('passes through an already-raw SKILL.md URL', () => {
    const u = 'https://raw.githubusercontent.com/u/repo/main/SKILL.md';
    expect(install.resolveGitRawUrl(u)).toBe(u);
  });

  test('rejects a non-http(s) URL', () => {
    expect(() => install.resolveGitRawUrl('file:///etc/passwd/SKILL.md'))
      .toThrow(install.SkillInstallError);
  });
});

describe('install sources go through the injected webFetch (egress)', () => {
  const okFetch = (body: string) =>
    async () => new Response(body, { status: 200 });

  test('installFromGit fetches the resolved raw URL and installs', async () => {
    const registry = reg.createSkillRegistry({ store: store.createSkillStore() });
    let fetched = '';
    const webFetch = async (url: string) => { fetched = url; return new Response(SKILL, { status: 200 }); };
    const meta = await install.installFromGit({ registry, webFetch }, {
      url: 'https://github.com/u/repo/blob/main/SKILL.md',
    });
    expect(fetched).toBe('https://raw.githubusercontent.com/u/repo/main/SKILL.md');
    expect(meta.name).toBe('demo');
    expect(meta.source).toBe('git');
  });

  test('a denied webFetch surfaces as a clean install failure', async () => {
    const registry = reg.createSkillRegistry({ store: store.createSkillStore() });
    const webFetch = async () => { throw new Error('egress denied: raw.githubusercontent.com'); };
    expect(install.installFromGit({ registry, webFetch }, { url: 'https://github.com/u/r/SKILL.md' }))
      .rejects.toThrow(install.SkillInstallError);
  });

  test('installFromManifest fetches each listed skill; bad entries fail soft', async () => {
    const registry = reg.createSkillRegistry({ store: store.createSkillStore() });
    const manifest = JSON.stringify({
      skills: [
        { url: 'https://cdn.example.com/a/SKILL.md' },
        { url: 'https://cdn.example.com/bad/SKILL.md' },
      ],
    });
    const SKILL2 = '---\nname: other\ndescription: Another.\n---\nbody';
    const webFetch = async (url: string) => {
      if (url.endsWith('skills.json') || url.includes('manifest')) return new Response(manifest, { status: 200 });
      if (url.includes('/a/')) return new Response(SKILL, { status: 200 });
      if (url.includes('/bad/')) return new Response('not found', { status: 404 });
      return new Response(manifest, { status: 200 }); // first call = manifest
    };
    const result = await install.installFromManifest({ registry, webFetch }, {
      url: 'https://example.com/manifest',
    });
    expect(result.installed.map((m: any) => m.name)).toContain('demo');
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].url).toContain('/bad/');
  });

  test('installFromLocal needs no fetch and records source=local', async () => {
    const registry = reg.createSkillRegistry({ store: store.createSkillStore() });
    const meta = await install.installFromLocal({ registry }, { text: SKILL, origin: 'my-dir' });
    expect(meta.source).toBe('local');
    expect(meta.origin).toBe('my-dir');
  });
});

describe('load_skill tool — on-invocation body injection', () => {
  test('returns the wrapped full body for an installed skill', async () => {
    const registry = reg.createSkillRegistry({ store: store.createSkillStore() });
    await install.installFromLocal({ registry }, { text: SKILL });
    // why the cast: a deliberately MINIMAL ctx — load_skill's execute reads
    // only ctx.skills, so the rest of the (required) ToolContext surface is
    // irrelevant to this unit and intentionally omitted.
    const res: any = await tool.loadSkillTool.execute({ name: 'demo' }, { skills: registry } as unknown as ToolContext);
    expect(res.ok).toBe(true);
    expect(res.content).toContain('<skill name="demo">');
    expect(res.content).toContain('body text');
  });

  test('reports not-found for an unknown skill', async () => {
    const registry = reg.createSkillRegistry({ store: store.createSkillStore() });
    // why the cast: same deliberately minimal ctx as above.
    const res: any = await tool.loadSkillTool.execute({ name: 'ghost' }, { skills: registry } as unknown as ToolContext);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('ghost');
  });
});
