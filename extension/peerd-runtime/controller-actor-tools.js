// @ts-check

// Actor tool semantics shared by the orchestrator controller and isolated actor
// heaps. Authority is finite and named; no implementation receives a browser,
// storage, vault, or generic operation callback.

import { actorCreateTool } from './tools/defs/actor-create.js';
import { actorTasksTool } from './tools/defs/actor-tasks.js';
import { actorCancelTool } from './tools/defs/actor-cancel.js';
import { messageActorTool } from './tools/defs/message-actor.js';

const tools = Object.freeze({
  actor_create: actorCreateTool,
  actor_tasks: actorTasksTool,
  actor_cancel: actorCancelTool,
  message_actor: messageActorTool,
});

export const CONTROLLER_ACTOR_TOOL_NAMES = Object.freeze(Object.keys(tools));

export const controllerHostsActorTool = (/** @type {unknown} */ name) =>
  typeof name === 'string' && Object.hasOwn(tools, name);

/**
 * @param {string} name
 * @param {unknown} args
 * @param {{sessionId?:string,sessionDepth?:number,sessionKind?:string,inbound?:boolean}} projection
 * @param {{spawnSync:(request:any)=>Promise<any>,spawnAsync:(request:any)=>Promise<any>,
 *   listTasks:()=>Promise<any>,cancelTask:(taskId:string)=>Promise<any>,
 *   message:(request:any)=>Promise<any>}} authority
 * @param {{callId:string,signal:AbortSignal}} execution
 */
export const executeControllerActorTool = async (
  name, args, projection, authority, execution,
) => {
  const tool = tools[/** @type {keyof typeof tools} */ (name)];
  if (!tool) throw Object.assign(new Error('controller actor tool is unavailable'), {
    code: 'controller-actor-tool-unavailable', outcomeKnown: true,
  });
  const ctx = /** @type {any} */ ({
    session: {
      sessionId: projection.sessionId,
      depth: projection.sessionDepth ?? 0,
      kind: projection.sessionKind ?? 'chat',
    },
    inbound: projection.inbound === true,
    toolUseId: execution.callId,
    abortSignal: execution.signal,
    spawnActor: authority.spawnSync,
    spawnActorAsync: authority.spawnAsync,
    actorTasks: authority.listTasks,
    actorCancel: authority.cancelTask,
    messageActor: authority.message,
  });
  return tool.execute(args, ctx);
};
