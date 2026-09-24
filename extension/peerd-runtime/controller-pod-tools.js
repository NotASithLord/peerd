// @ts-check

// Pod command/file semantics shared by the orchestrator controller and isolated
// actor heaps. The interface is deliberately finite: the semantic executor
// cannot reach a browser, registry, repository, storage, or generic operation
// callback.

import { podExecTool } from './tools/defs/pod-exec.js';
import { podStatusTool } from './tools/defs/pod-status.js';
import { podCancelTool } from './tools/defs/pod-cancel.js';
import { podReadTool } from './tools/defs/pod-read.js';
import { podWriteTool } from './tools/defs/pod-write.js';

const tools = Object.freeze({
  pod_exec: podExecTool,
  pod_status: podStatusTool,
  pod_cancel: podCancelTool,
  pod_read: podReadTool,
  pod_write: podWriteTool,
});

export const CONTROLLER_POD_TOOL_NAMES = Object.freeze(Object.keys(tools));

export const controllerHostsPodTool = (/** @type {unknown} */ name) =>
  typeof name === 'string' && Object.hasOwn(tools, name);

/**
 * @param {string} name
 * @param {unknown} args
 * @param {{sessionId?:string}} projection
 * @param {{resolve:(request:any)=>Promise<any>,readRemote:(podId:string)=>Promise<any>,
 *   confirmGit:(op:'clone'|'fetch'|'push'|'link')=>Promise<any>,
 *   executeCommand:(request:any)=>Promise<any>,readStatus:(request:any)=>Promise<any>,
 *   cancelJob:(request:any)=>Promise<any>,readFile:(request:any)=>Promise<any>,
 *   writeFile:(request:any)=>Promise<any>}} authority
 * @param {{signal:AbortSignal}} execution
 */
export const executeControllerPodTool = async (
  name, args, projection, authority, execution,
) => {
  const tool = tools[/** @type {keyof typeof tools} */ (name)];
  if (!tool) throw Object.assign(new Error('controller Pod tool is unavailable'), {
    code: 'controller-pod-tool-unavailable', outcomeKnown: true,
  });
  const ctx = /** @type {any} */ ({
    session: { sessionId: projection.sessionId },
    abortSignal: execution.signal,
    podClient: {
      resolveId: authority.resolve,
      exec: (/** @type {string} */ command, /** @type {any} */ options) =>
        authority.executeCommand({ command, ...options }),
      status: authority.readStatus,
      cancel: (/** @type {string} */ jobId, /** @type {any} */ options) =>
        authority.cancelJob({ jobId, ...options }),
      readFile: (/** @type {string} */ path, /** @type {any} */ options) =>
        authority.readFile({ path, ...options }),
      writeFile: (/** @type {string} */ path, /** @type {string} */ content,
        /** @type {any} */ options) => authority.writeFile({ path, content, ...options }),
    },
    repositories: {
      getRemote: (/** @type {{id:string}} */ target) => authority.readRemote(target.id),
    },
    confirm: (/** @type {{kind?:string}} */ prompt) => {
      const match = /^git_(clone|fetch|push|link)$/.exec(prompt?.kind ?? '');
      if (!match) throw Object.assign(new Error('Pod confirmation kind is invalid'), {
        code: 'controller-pod-confirmation-invalid', outcomeKnown: true,
      });
      return authority.confirmGit(/** @type {'clone'|'fetch'|'push'|'link'} */ (match[1]));
    },
  });
  return tool.execute(args, ctx);
};
