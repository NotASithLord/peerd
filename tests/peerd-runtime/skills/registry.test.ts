import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';
import { useFakeIndexedDB } from '../../setup.ts';

let store: typeof import('../../../extension/peerd-runtime/skills/store.js');
let reg: typeof import('../../../extension/peerd-runtime/skills/registry.js');

beforeAll(async () => {
  await useFakeIndexedDB();
  store = await import('../../../extension/peerd-runtime/skills/store.js');
  reg = await import('../../../extension/peerd-runtime/skills/registry.js');
});

beforeEach(async () => {
  await new Promise<void>((resolve) => {
    const req = globalThis.indexedDB.deleteDatabase('peerd-skills');
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
});

const SKILL_A = [
  '---',
  'name: alpha',
  'description: Alpha does the A thing. Use for A tasks.',
  '---',
  '# Alpha',
  'Full alpha instructions that are EXPENSIVE and only load on invocation.',
].join('\n');

const SKILL_B = [
  '---',
  'name: beta',
  'description: Beta does the B thing.',
  '---',
  'Beta body.',
].join('\n');

const make = () => reg.createSkillRegistry({ store: store.createSkillStore() });

describe('skill registry — progressive disclosure', () => {
  test('install then list returns DESCRIPTIONS only (no bodies)', async () => {
    const r = make();
    await r.install(SKILL_A, { source: 'local' });
    const list = await r.list();
    expect(list).toHaveLength(1);
    const meta = list[0];
    expect(meta.name).toBe('alpha');
    expect(meta.description).toContain('Alpha does the A thing');
    // The body must NOT be present on the listed meta — that's the disclosure line.
    expect((meta as any).body).toBeUndefined();
    expect(JSON.stringify(meta)).not.toContain('EXPENSIVE');
  });

  test('describeForPrompt renders names + descriptions, never bodies', async () => {
    const r = make();
    await r.install(SKILL_A, { source: 'local' });
    await r.install(SKILL_B, { source: 'git', origin: 'https://x/y' });
    const block = await r.describeForPrompt();
    expect(block).toContain('alpha — Alpha does the A thing');
    expect(block).toContain('beta — Beta does the B thing');
    expect(block).toContain('load_skill');
    // Bodies stay out of the startup prompt.
    expect(block).not.toContain('EXPENSIVE');
    expect(block).not.toContain('Beta body');
  });

  test('describeForPrompt collapses to empty string with no skills', async () => {
    expect(await make().describeForPrompt()).toBe('');
  });

  test('loadBody returns the FULL body — the on-invocation tier', async () => {
    const r = make();
    await r.install(SKILL_A, { source: 'local' });
    const { meta, body } = await r.loadBody('alpha');
    expect(meta.name).toBe('alpha');
    expect(body).toContain('EXPENSIVE and only load on invocation');
  });

  test('loadBody throws SkillNotFoundError for unknown / disabled skills', async () => {
    const r = make();
    await r.install(SKILL_A, { source: 'local' });
    expect(r.loadBody('nope')).rejects.toThrow(reg.SkillNotFoundError);
    await r.setEnabled('alpha', false);
    expect(r.loadBody('alpha')).rejects.toThrow(reg.SkillNotFoundError);
    // Disabled skills also drop out of the prompt block.
    expect(await r.describeForPrompt()).toBe('');
  });

  test('duplicate install throws unless replace is set', async () => {
    const r = make();
    await r.install(SKILL_A, { source: 'local' });
    expect(r.install(SKILL_A, { source: 'local' })).rejects.toThrow(reg.SkillExistsError);
    await r.install(SKILL_A.replace('Use for A tasks.', 'UPDATED.'), { source: 'local', replace: true });
    const list = await r.list();
    expect(list).toHaveLength(1);
    expect(list[0].description).toContain('UPDATED');
  });

  test('remove uninstalls (reversibility); cold-start rehydrates from store', async () => {
    const s = store.createSkillStore();
    const r1 = reg.createSkillRegistry({ store: s });
    await r1.install(SKILL_A, { source: 'local' });
    await r1.install(SKILL_B, { source: 'local' });
    await r1.remove('alpha');

    // Fresh registry over the SAME store simulates a cold SW start: it must
    // read persisted skills back (MV3 30s-death survival).
    const r2 = reg.createSkillRegistry({ store: s });
    const names = (await r2.list()).map((m) => m.name);
    expect(names).toEqual(['beta']);
  });

  test('install records source provenance', async () => {
    const r = make();
    await r.install(SKILL_B, { source: 'git', origin: 'https://github.com/u/r/SKILL.md' });
    const meta = (await r.list())[0];
    expect(meta.source).toBe('git');
    expect(meta.origin).toContain('github.com');
    expect(meta.sizeBytes).toBeGreaterThan(0);
  });
});

describe('listCommands — composer slash-command source (feature-04 integration)', () => {
  test('enabled skills surface as commands that route through load_skill', async () => {
    const r = make();
    await r.install(SKILL_A, { source: 'local' });
    const cmds = await r.listCommands();
    expect(cmds.length).toBe(1);
    expect(cmds[0].name).toBe('alpha');
    expect(cmds[0].body).toContain('load_skill');
    expect(cmds[0].body).toContain('"alpha"');
    expect(typeof cmds[0].description).toBe('string');
  });

  test('disabled skills are excluded', async () => {
    const r = make();
    await r.install(SKILL_A, { source: 'local' });
    await r.install(SKILL_B, { source: 'local' });
    await r.setEnabled('alpha', false);
    const cmds = await r.listCommands();
    expect(cmds.map((c: any) => c.name)).toEqual(['beta']);
  });
});
