// Kernel skills metadata authority: preserve stored rows, bodies, audit, and
// editor replies without importing the superseded background route wrapper.

import { describe, expect, test } from 'bun:test';
import { useFakeIndexedDB } from '../setup.ts';
import { createKernelSkillPersistence } from '../../extension/background/kernel-skill-persistence.js';
import { createSkillStore } from '../../extension/peerd-runtime/skills/store.js';
import { createSkillRegistry } from '../../extension/peerd-runtime/skills/registry.js';

await useFakeIndexedDB();

const SKILL_MD = (name: string) => [
  '---', `name: ${name}`, `description: A ${name} playbook`, '---', '',
  `# ${name}`, 'Do the thing carefully.',
].join('\n');

let dbSequence = 0;
const makeLane = async () => {
  // A fresh database name per test keeps fake-indexeddb state isolated.
  const dbName = `peerd-skills-test-${++dbSequence}`;
  const factory: IDBFactory = new Proxy(indexedDB, {
    get(target, property, receiver) {
      if (property === 'open') {
        return (_name: string, version?: number) => target.open(dbName, version);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const store = createSkillStore({ idbFactory: factory });
  const registry = createSkillRegistry({ store });
  const kernelAudit: any[] = [];
  const kernelPushes: number[] = [];
  const kernel = createKernelSkillPersistence({
    idbFactory: factory,
    audit: async (entry: any) => { kernelAudit.push(entry); },
    pushState: () => { kernelPushes.push(1); },
  });
  const install = (name: string) => registry.install(SKILL_MD(name), { source: 'local' });
  return {
    kernel, install, kernelAudit, kernelPushes,
    readBody: (name: string) => store.getBody(name),
  };
};

describe('kernel skill persistence', () => {
  test('list is sorted and metadata only', async () => {
    const lanes = await makeLane();
    await lanes.install('zeta');
    await lanes.install('alpha');
    const kernelReply = await lanes.kernel.routes['skills/list']();
    expect(kernelReply.ok).toBe(true);
    expect(kernelReply.skills.map((skill: any) => skill.name)).toEqual(['alpha', 'zeta']);
    expect(JSON.stringify(kernelReply)).not.toContain('Do the thing');
  });

  test('setEnabled toggles the meta record and keeps the body byte-identical', async () => {
    const lanes = await makeLane();
    await lanes.install('alpha');
    const bodyBefore = await lanes.readBody('alpha');
    expect(bodyBefore).toContain('Do the thing carefully.');
    const kernelReply = await lanes.kernel.routes['skills/setEnabled']({
      name: 'alpha', enabled: false,
    });
    expect(kernelReply).toMatchObject({ ok: true, skill: { id: 'alpha', enabled: false } });
    expect(await lanes.readBody('alpha')).toBe(bodyBefore);
    expect(lanes.kernelPushes).toHaveLength(1);
  });

  test('missing-name and unknown-skill replies stay explicit', async () => {
    const lanes = await makeLane();
    expect(await lanes.kernel.routes['skills/setEnabled']({}))
      .toEqual({ ok: false, error: 'name-required' });
    expect(await lanes.kernel.routes['skills/remove']({}))
      .toEqual({ ok: false, error: 'name-required' });
    expect(await lanes.kernel.routes['skills/setEnabled']({ name: 'ghost', enabled: true }))
      .toEqual({ ok: false, error: "no skill named 'ghost'" });
    expect(await lanes.kernel.routes['skills/remove']({ name: 'ghost' }))
      .toEqual({ ok: true, removed: false });
  });

  test('remove deletes meta and body, audits once, and is idempotent', async () => {
    const lanes = await makeLane();
    await lanes.install('alpha');
    expect(await lanes.kernel.routes['skills/remove']({ name: 'alpha' }))
      .toEqual({ ok: true, removed: true });
    expect(await lanes.readBody('alpha')).toBeNull();
    expect((await lanes.kernel.routes['skills/list']()).skills).toEqual([]);
    expect(await lanes.kernel.routes['skills/remove']({ name: 'alpha' }))
      .toEqual({ ok: true, removed: false });
    expect(lanes.kernelAudit).toEqual([
      { type: 'skill_removed', details: { name: 'alpha' } },
    ]);
  });

  test('the schema write gate refuses mutations but never reads', async () => {
    const lanes = await makeLane();
    await lanes.install('alpha');
    const guarded = createKernelSkillPersistence({
      idbFactory: indexedDB,
      canWrite: () => { throw new Error('profile schema is newer than this build'); },
    });
    expect(await guarded.routes['skills/setEnabled']({ name: 'alpha', enabled: false }))
      .toEqual({ ok: false, error: 'profile schema is newer than this build' });
    await expect(guarded.routes['skills/remove']({ name: 'alpha' })).resolves
      .toMatchObject({ ok: true });
  });
});
