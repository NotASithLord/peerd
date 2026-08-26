// @ts-check

// why: the controller owns memory/todo semantics; this adapter pins each exact
// durable read or mutation to the already-admitted call and its live session.
const mismatch = () => Object.assign(new Error('persistence authority mismatch'), {
  outcomeKnown: true, retryable: false,
});

const sameClone = (/** @type {unknown} */ left, /** @type {unknown} */ right) => {
  try { return JSON.stringify(left) === JSON.stringify(right); }
  catch { return false; }
};

/** @param {{call:any,ctx:any}} input */
export const createPersistenceToolAuthority = ({ call, ctx }) => {
  const args = call?.args ?? {};
  const sessionId = ctx?.session?.sessionId;
  const workspace = args.workspace ?? ctx?.activeTab?.origin ?? '';
  const requireTool = (/** @type {string[]} */ names) => {
    if (!names.includes(call?.name)) throw mismatch();
  };
  const todoNames = ['todo_init', 'todo_check', 'todo_add'];
  return Object.freeze({
    readMemoryScope: (/** @type {any} */ scope) => {
      requireTool(['read_memory']);
      const expected = { kind: args.scope, workspace };
      if (!sameClone(scope, expected) || typeof ctx?.memory?.readScope !== 'function') {
        throw mismatch();
      }
      return ctx.memory.readScope(scope);
    },
    readMemorySubtree: (/** @type {string} */ requestedWorkspace,
      /** @type {string} */ subpath) => {
      requireTool(['read_memory']);
      if (args.scope !== 'subtree' || requestedWorkspace !== workspace
          || subpath !== args.subpath || typeof ctx?.memory?.readSubtree !== 'function') {
        throw mismatch();
      }
      return ctx.memory.readSubtree(requestedWorkspace, subpath);
    },
    writeMemory: (/** @type {any} */ scope, /** @type {string} */ body) => {
      requireTool(['remember']);
      const expected = { kind: args.scope, workspace, subpath: args.subpath };
      if (!sameClone(scope, expected) || body !== args.body
          || typeof ctx?.memory?.writeWithConfirm !== 'function') throw mismatch();
      return ctx.memory.writeWithConfirm({
        scope, body, origin: 'agent',
        confirm: typeof ctx?.confirm === 'function'
          ? (/** @type {any} */ proposal) => ctx.confirm({
              tool: 'remember', sideEffect: 'write', kind: 'memory_write', proposal,
              summary: `${proposal.op} memory: ${proposal.header} (+${proposal.addedLines}/−${proposal.removedLines})`,
              origins: [], sessionId: sessionId ?? null,
            }, ctx.abortSignal)
          : undefined,
      });
    },
    readTodos: async () => {
      requireTool(todoNames);
      if (!ctx?.todoStore?.apply) throw mismatch();
      const current = await ctx.todoStore.apply((/** @type {any[]} */ todos) => ({
        ok: true, current: Array.isArray(todos) ? todos : [],
      }));
      const todos = Array.isArray(current?.current) ? current.current : [];
      return { todos, version: JSON.stringify(todos) };
    },
    replaceTodos: (/** @type {string} */ version, /** @type {any[]} */ todos) => {
      requireTool(todoNames);
      if (typeof version !== 'string' || !Array.isArray(todos)
          || !ctx?.todoStore?.apply) throw mismatch();
      return ctx.todoStore.apply((/** @type {any[]} */ current) => {
        const normalized = Array.isArray(current) ? current : [];
        if (JSON.stringify(normalized) !== version) {
          return { ok: false, error: 'todo_conflict' };
        }
        return { ok: true, todos };
      });
    },
  });
};
