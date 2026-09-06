// @ts-check

// why: introspection presentation, skill framing/dedup, and wait semantics are
// ordinary feature behavior. The injected object exposes only named, bounded
// authority reads; it carries no registry, browser, storage, or vault handle.
import { actorListTool } from './tools/defs/actor-list.js';
import { inspectTool } from './tools/defs/inspect.js';
import { loadSkillTool } from './skills/load-skill-tool.js';

const tools = Object.freeze({
  actor_list: actorListTool,
  inspect: inspectTool,
  load_skill: loadSkillTool,
});

export const CONTROLLER_INTROSPECTION_TOOL_NAMES = Object.freeze(Object.keys(tools));

export const controllerHostsIntrospectionTool = (/** @type {unknown} */ name) =>
  typeof name === 'string' && Object.hasOwn(tools, name);

/**
 * @param {string} name
 * @param {unknown} args
 * @param {{sessionId?:string,messageCount?:number,trimCovered?:number,messages?:any[]}} projection
 * @param {Record<string,Function>} authority
 * @param {{signal?:AbortSignal}} [options]
 */
export const executeControllerIntrospectionTool = async (
  name, args, projection, authority, options = {},
) => {
  const tool = tools[/** @type {keyof typeof tools} */ (name)];
  if (!tool) throw Object.assign(new Error('controller introspection tool is unavailable'), {
    code: 'controller-introspection-tool-unavailable', outcomeKnown: true,
  });
  return tool.execute(args, /** @type {any} */ ({
    abortSignal: options.signal,
    actorDirectory: Object.freeze({ readRoster: authority.readActorRoster }),
    introspectionAuthority: Object.freeze({
      readProviderPosture: authority.readProviderPosture,
      readStorageSnapshot: authority.readStorageSnapshot,
      readAutomatableTabs: authority.readAutomatableTabs,
      readDenylistPatterns: authority.readDenylistPatterns,
      readAuditEntries: authority.readAuditEntries,
    }),
    skillAuthority: Object.freeze({ readInstalledSkill: authority.readInstalledSkill }),
    session: {
      sessionId: projection.sessionId,
      messageCount: projection.messageCount ?? 0,
      trimCovered: projection.trimCovered ?? 0,
      messages: projection.messages,
    },
  }));
};
