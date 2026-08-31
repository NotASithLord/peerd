// @ts-check

// why: memory presentation and todo math are ordinary feature semantics; only
// confirmed durable writes and serialized session replacement need SW custody.
import { readMemoryTool } from './tools/defs/read-memory.js';
import { rememberTool } from './tools/defs/remember.js';
import { todoAddTool, todoCheckTool, todoInitTool } from './tools/defs/todo.js';

const tools = Object.freeze({
  read_memory: readMemoryTool,
  remember: rememberTool,
  todo_init: todoInitTool,
  todo_check: todoCheckTool,
  todo_add: todoAddTool,
});

export const CONTROLLER_PERSISTENCE_TOOL_NAMES = Object.freeze(Object.keys(tools));

export const controllerHostsPersistenceTool = (/** @type {unknown} */ name) =>
  typeof name === 'string' && Object.hasOwn(tools, name);

/**
 * @param {string} name
 * @param {unknown} args
 * @param {{sessionId?:string,activeTabOrigin?:string,goalActive?:boolean}} projection
 * @param {Record<string,Function>} authority
 */
export const executeControllerPersistenceTool = async (
  name, args, projection, authority,
) => {
  const tool = tools[/** @type {keyof typeof tools} */ (name)];
  if (!tool) throw Object.assign(new Error('controller persistence tool is unavailable'), {
    code: 'controller-persistence-tool-unavailable', outcomeKnown: true,
  });
  const memory = Object.freeze({
    readScope: (/** @type {any} */ scope) => authority.readMemoryScope(scope),
    readSubtree: (/** @type {string} */ workspace, /** @type {string} */ subpath) =>
      authority.readMemorySubtree(workspace, subpath),
    writeWithConfirm: (/** @type {any} */ request) =>
      authority.writeMemory(request.scope, request.body),
  });
  const todoStore = projection.goalActive === true ? Object.freeze({
    apply: async (/** @type {(todos:any[])=>any} */ update) => {
      // why: the old SW store serialized concurrent updates. A versioned retry
      // preserves that behavior while leaving all todo math in this semantic owner.
      for (let attempt = 0; attempt < 16; attempt += 1) {
        const current = await authority.readTodos();
        const result = update(current.todos);
        if (result?.ok !== true || !Array.isArray(result.todos)) return result;
        const committed = await authority.replaceTodos(current.version, result.todos);
        if (committed?.ok === true) return result;
        if (committed?.error !== 'todo_conflict') return committed;
      }
      return { ok: false, error: 'todo_conflict' };
    },
  }) : undefined;
  return tool.execute(args, /** @type {any} */ ({
    memory,
    todoStore,
    session: { sessionId: projection.sessionId ?? null },
    activeTab: projection.activeTabOrigin
      ? { origin: projection.activeTabOrigin } : undefined,
  }));
};
