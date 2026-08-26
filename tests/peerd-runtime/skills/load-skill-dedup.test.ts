// load_skill's trim-aware once-per-session dedup (schema-diet 6b). The FULL
// SKILL.md body ships the first time a skill is loaded in a session; a repeat
// load returns a short pointer instead — UNLESS the first body has scrolled out
// of the sent slice (the rolling-summary watermark passed it), in which case the
// body is re-paged. Exercised through the real tool with a mock skills registry.

import { describe, test, expect, beforeEach } from 'bun:test';
import { loadSkillTool } from '../../../extension/peerd-runtime/skills/load-skill-tool.js';
import { _resetOncePerSession } from '../../../extension/peerd-runtime/tools/defs/once-per-session.js';

beforeEach(() => { _resetOncePerSession(); });

const BODY = 'THE FULL SKILL PLAYBOOK BODY — many lines of instructions.';

// A ctx with a mock skills registry and the SW-injected session watermark fields.
const ctxFor = (session: any) => ({
  skillAuthority: {
    readInstalledSkill: async (name: string) => ({
      meta: { name, version: '1' }, body: BODY,
    }),
  },
  session,
} as any);

describe('load_skill dedup', () => {
  test('injects the full body the first time, a pointer the second (still in context)', async () => {
    const first = await loadSkillTool.execute({ name: 'writer' }, ctxFor({ sessionId: 's1', messageCount: 4, trimCovered: 0 }));
    expect(first.ok).toBe(true);
    expect((first as any).content).toContain(BODY);

    const second = await loadSkillTool.execute({ name: 'writer' }, ctxFor({ sessionId: 's1', messageCount: 9, trimCovered: 0 }));
    expect(second.ok).toBe(true);
    expect((second as any).content).not.toContain(BODY);
    expect((second as any).content).toContain('already loaded');
    expect((second as any).content).toContain('writer');
  });

  test('re-injects the body once the first load scrolled out of the sent slice', async () => {
    await loadSkillTool.execute({ name: 'writer' }, ctxFor({ sessionId: 's1', messageCount: 4, trimCovered: 0 }));
    // rolling summary folded away the first 6 messages → the body at #4 is gone
    const reload = await loadSkillTool.execute({ name: 'writer' }, ctxFor({ sessionId: 's1', messageCount: 30, trimCovered: 6 }));
    expect((reload as any).content).toContain(BODY);
  });

  test('different skills each inject once', async () => {
    const a = await loadSkillTool.execute({ name: 'writer' }, ctxFor({ sessionId: 's1', messageCount: 4, trimCovered: 0 }));
    const b = await loadSkillTool.execute({ name: 'coder' }, ctxFor({ sessionId: 's1', messageCount: 5, trimCovered: 0 }));
    expect((a as any).content).toContain(BODY);
    expect((b as any).content).toContain(BODY);
  });

  test('missing skills registry still fails closed', async () => {
    const res = await loadSkillTool.execute({ name: 'writer' }, { session: { sessionId: 's1' } } as any);
    expect(res.ok).toBe(false);
  });
});
