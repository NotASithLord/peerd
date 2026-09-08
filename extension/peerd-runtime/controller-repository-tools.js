// @ts-check

// Repository and Pod-lifecycle semantics shared by both sealed execution heaps.
// Coordination, editor quiescence, repository locks, network credentials, tab
// closure, and durable mutation remain behind these named authority methods.

import { podDestroyTool } from './tools/defs/pod-destroy.js';
import { repositoryHistoryTool } from './tools/defs/app-history.js';
import { repositoryVersionTool } from './tools/defs/app-version.js';
import { repositoryRemoteTool } from './tools/defs/app-remote.js';

const tools = Object.freeze({
  pod_destroy: podDestroyTool,
  repo_history: repositoryHistoryTool,
  repo_version: repositoryVersionTool,
  repo_remote: repositoryRemoteTool,
});

export const CONTROLLER_REPOSITORY_TOOL_NAMES = Object.freeze(Object.keys(tools));

export const controllerHostsRepositoryTool = (/** @type {unknown} */ name) =>
  typeof name === 'string' && Object.hasOwn(tools, name);

/**
 * @param {string} name
 * @param {unknown} args
 * @param {{actorType?:string,actorInstanceId?:string}} projection
 * @param {Record<string,Function>} authority
 * @param {{signal:AbortSignal}} execution
 */
export const executeControllerRepositoryTool = async (
  name, args, projection, authority, execution,
) => {
  const tool = tools[/** @type {keyof typeof tools} */ (name)];
  if (!tool) throw Object.assign(new Error('controller repository tool is unavailable'), {
    code: 'controller-repository-tool-unavailable', outcomeKnown: true,
  });
  return tool.execute(args, /** @type {any} */ ({
    actorType: projection.actorType,
    actorInstanceId: projection.actorInstanceId,
    abortSignal: execution.signal,
    repositoryAuthority: authority,
  }));
};
