// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
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
import { shouldInjectBody } from '../tools/defs/once-per-session.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const loadSkillTool = composeTool("load_skill", {

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
      // why the dedup (schema-diet 6b): a skill's full SKILL.md re-ships every
      // turn once it's in history, so a second load of the SAME skill this
      // session is pure repetition — UNLESS the first body has scrolled out of
      // the sent slice, in which case the model genuinely can't see it and we
      // must re-page. shouldInjectBody keys on the rolling-summary watermark:
      // it returns false (dedup to a pointer) only while the prior body is still
      // in context. ctx.session carries messageCount/trimCovered (SW-injected).
      const { sessionId, messageCount, trimCovered } = ctx.session ?? {};
      const inject = shouldInjectBody(sessionId, `skill:${meta.name}`, messageCount ?? 0, trimCovered ?? 0);
      // why: frame the body as an instruction playbook the agent should
      // follow, while reminding the model these are operating
      // instructions for a task — not a new system policy and not a
      // license to skip gates. Mirrors the <untrusted_web_content> framing
      // discipline used elsewhere.
      const content = inject
        ? [
          `<skill name="${meta.name}"${meta.version ? ` version="${escapeAttr(meta.version)}"` : ''}>`,
          'The following is the skill\'s playbook. Follow it for this task.',
          'Tool calls it leads to still pass the normal gates.',
          '',
          body,
          '</skill>',
        ].join('\n')
        // Already loaded this session and still in context — a pointer, not the
        // body again. Re-call load_skill to re-page it if it has scrolled away.
        : `<skill name="${meta.name}" already-loaded="this session">`
          + `\nYou already loaded "${meta.name}" earlier this session — its full playbook is above in this conversation; re-read it there. (Call load_skill again to re-page the body if it has scrolled out of view.)`
          + '\n</skill>';
      return { ok: true, content };
    } catch (e) {
      // SkillNotFoundError or storage failure — report by name.
      return { ok: false, error: `skill_not_found: ${name}` };
    }
  },
});
