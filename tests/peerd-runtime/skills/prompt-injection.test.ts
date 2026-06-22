import { describe, test, expect, beforeAll, beforeEach } from 'bun:test';
import { useFakeIndexedDB } from '../../setup.ts';

let sp: typeof import('../../../extension/peerd-runtime/loop/system-prompt.js');
let store: typeof import('../../../extension/peerd-runtime/skills/store.js');
let reg: typeof import('../../../extension/peerd-runtime/skills/registry.js');

beforeAll(async () => {
  await useFakeIndexedDB();
  sp = await import('../../../extension/peerd-runtime/loop/system-prompt.js');
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

const TEMPLATE = 'date={{DATE}}\n{{SKILLS_BLOCK}}\nEND';

describe('skills block injection into the system prompt', () => {
  test('describeForPrompt output substitutes at {{SKILLS_BLOCK}}; bodies excluded', async () => {
    const r = reg.createSkillRegistry({ store: store.createSkillStore() });
    await r.install(
      '---\nname: gmail-driver\ndescription: Drive Gmail via @tab. Use for email tasks.\n---\nSECRET BODY STEPS',
      { source: 'local' },
    );
    const skillsBlock = await r.describeForPrompt();

    sp._setTemplateForTests(TEMPLATE);
    const prompt = await sp.renderSystemPrompt({ skillsBlock });

    // The cheap half is present...
    expect(prompt).toContain('gmail-driver — Drive Gmail via @tab');
    expect(prompt).toContain('load_skill');
    // ...the expensive half is NOT.
    expect(prompt).not.toContain('SECRET BODY STEPS');
  });

  test('no skills → placeholder collapses (empty), prompt still renders', async () => {
    sp._setTemplateForTests(TEMPLATE);
    const prompt = await sp.renderSystemPrompt({ skillsBlock: '' });
    expect(prompt).toContain('END');
    expect(prompt).not.toContain('{{SKILLS_BLOCK}}');
    expect(prompt).not.toContain('load_skill');
  });

  test('omitting skillsBlock is safe (defaults to empty)', async () => {
    sp._setTemplateForTests(TEMPLATE);
    const prompt = await sp.renderSystemPrompt({});
    expect(prompt).not.toContain('{{SKILLS_BLOCK}}');
  });
});
