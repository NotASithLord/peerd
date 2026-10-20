// @ts-check

import { composeTool } from '/peerd-runtime/tools/metadata/index.js';
// load_skill reads an installed playbook. Its instructions grant no authority.
// The controller receives one exact installed-skill read capability. Durable
// skill storage stays in the SW; the body framing and dedup semantics live here.

import { escapeAttr } from '/shared/util.js';
import { shouldInjectBody } from '../tools/defs/once-per-session.js';
import { buildPagedResult, SPILL_PAGE_CHARS, pageStatusLine } from '../tools/web/spill.js';

/** @type {import('/shared/tool-types.js').Tool} */
export const loadSkillTool = composeTool("load_skill", {

  execute: async (args, ctx) => {
    const skillAuthority = /** @type {{readInstalledSkill?:(name:string)=>Promise<{
     * meta:{name:string,version?:string|null},body:string}>}} */ (
      /** @type {{skillAuthority?:unknown}} */ (ctx).skillAuthority
    );
    if (typeof skillAuthority?.readInstalledSkill !== 'function') {
      return { ok: false, error: 'skills_unavailable' };
    }
    const name = typeof args?.name === 'string' ? args.name.trim() : '';
    if (!name) return { ok: false, error: 'name_required' };
    try {
      const { meta, body } = await skillAuthority.readInstalledSkill(name);
      // why: dedup only the first page while it remains in the sent slice.
      const { sessionId, messageCount, trimCovered } = ctx.session ?? {};
      const offset = typeof args.offset === 'number' ? args.offset : 0;
      const inject = offset > 0 || shouldInjectBody(
        sessionId, `skill:${meta.name}`, messageCount ?? 0, trimCovered ?? 0,
        ctx.session?.messages, 'load_skill', `<skill name="${meta.name}"`,
      );
      if (!inject) return { ok: true, content: `<skill name="${meta.name}" already-loaded="this session">`
        + `\nYou already loaded "${meta.name}" earlier this session. Read that result and follow its paging note for more instructions. Call load_skill again if that page has scrolled out of view.\n</skill>` };
      // why: page the durable body so redaction cannot remove its middle.
      return buildPagedResult({ text: body, offset, limit: SPILL_PAGE_CHARS,
        frame: (page) => [
          `<skill${page.offset ? ` offset="${page.offset}"` : ''} name="${meta.name}"${meta.version ? ` version="${escapeAttr(meta.version)}"` : ''}>`,
          'The following is the skill\'s playbook. Follow it for this task.',
          'Tool calls it leads to still pass the normal gates.',
          '',
          page.slice,
          '</skill>',
          ...(page.remaining > 0 || page.offset > 0 ? [pageStatusLine({ page,
            nextArgs: JSON.stringify({ name: meta.name, offset: page.end }) })] : []),
        ].join('\n'),
      });
    } catch (e) {
      // SkillNotFoundError or storage failure — report by name.
      return { ok: false, error: `skill_not_found: ${name}` };
    }
  },
});
