// @ts-check
// load_skill — the on-invocation body-injection tool.
//
// PROGRESSIVE DISCLOSURE, model-facing half: the system prompt carries
// only skill NAMES + descriptions (registry.describeForPrompt). When the
// model decides a skill applies, it calls load_skill("<name>") and gets
// the full SKILL.md body back as a tool result — at which point the
// instructions enter the context and the model follows them.
//
// This keeps the agent loop untouched: a skill is "loaded" exactly like
// any other tool call, with full lineage + audit. sideEffect is 'read'
// (no external mutation, no egress) so it never trips a confirmation gate
// — reading a playbook you already installed should be friction-free. The
// PLAYBOOK may then ask the agent to do things that DO trip gates; those
// are governed normally.
//
// The registry is injected onto the ToolContext by the SW (ctx.skills).

import { escapeAttr } from '/shared/util.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const loadSkillTool = {
  name: 'load_skill',
  primitive: 'inspect',
  description: [
    'Load the full instructions for an installed skill by name. The system',
    'prompt lists available skills as name + one-line description only; call',
    'this to read a skill\'s complete SKILL.md body before following it.',
    'Returns the markdown body. Skill instructions are a playbook, not a',
    'privilege grant — any tool calls they lead to still pass the normal gates.',
  ].join(' '),
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The skill name (as shown in the skills list).' },
    },
    required: ['name'],
  },
  sideEffect: 'read',
  origins: () => [],

  execute: async (args, ctx) => {
    if (!ctx.skills) return { ok: false, error: 'skills_unavailable' };
    // why: ctx.skills is typed as a bare Object on ToolContext (the SW
    // injects the registry without the runtime depending on its shape);
    // recover the real SkillRegistry surface for the one method we use.
    const skills = /** @type {import('./registry.js').SkillRegistry} */ (ctx.skills);
    const name = typeof args?.name === 'string' ? args.name.trim() : '';
    if (!name) return { ok: false, error: 'name_required' };
    try {
      const { meta, body } = await skills.loadBody(name);
      // why: frame the body as an instruction playbook the agent should
      // follow, while reminding the model these are operating
      // instructions for a task — not a new system policy and not a
      // license to skip gates. Mirrors the <untrusted_web_content> framing
      // discipline used elsewhere.
      return {
        ok: true,
        content: [
          `<skill name="${meta.name}"${meta.version ? ` version="${escapeAttr(meta.version)}"` : ''}>`,
          'The following is the skill\'s playbook. Follow it for this task.',
          'Tool calls it leads to still pass the normal gates.',
          '',
          body,
          '</skill>',
        ].join('\n'),
      };
    } catch (e) {
      // SkillNotFoundError or storage failure — report by name.
      return { ok: false, error: `skill_not_found: ${name}` };
    }
  },
};
