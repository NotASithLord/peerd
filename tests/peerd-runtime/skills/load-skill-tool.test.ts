import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';
import { useFakeIndexedDB } from '../../setup.ts';
import type { ToolContext } from '../../../extension/shared/tool-types.js';

let store: typeof import('../../../extension/peerd-runtime/skills/store.js');
let reg: typeof import('../../../extension/peerd-runtime/skills/registry.js');
let tool: typeof import('../../../extension/peerd-runtime/skills/load-skill-tool.js');

beforeAll(async () => {
  await useFakeIndexedDB();
  store = await import('../../../extension/peerd-runtime/skills/store.js');
  reg = await import('../../../extension/peerd-runtime/skills/registry.js');
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

describe('load_skill tool: on-invocation body injection', () => {
  test('returns the wrapped full body for an installed skill', async () => {
    const registry = reg.createSkillRegistry({ store: store.createSkillStore() });
    await registry.install(SKILL, { source: 'local', origin: 'local' });
    // why the cast: a deliberately minimal ctx. load_skill's execute reads
    // only ctx.skills, so the rest of the (required) ToolContext surface is
    // irrelevant to this unit and intentionally omitted.
    const res: any = await tool.loadSkillTool.execute({ name: 'demo' }, {
      skillAuthority: { readInstalledSkill: registry.loadBody },
    } as unknown as ToolContext);
    expect(res.ok).toBe(true);
    expect(res.content).toContain('<skill name="demo">');
    expect(res.content).toContain('body text');
  });

  test('reports not-found for an unknown skill', async () => {
    const registry = reg.createSkillRegistry({ store: store.createSkillStore() });
    // why the cast: same deliberately minimal ctx as above.
    const res: any = await tool.loadSkillTool.execute({ name: 'ghost' }, {
      skillAuthority: { readInstalledSkill: registry.loadBody },
    } as unknown as ToolContext);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('ghost');
  });
});
