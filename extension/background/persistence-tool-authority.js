// @ts-check

// why: the controller owns memory/todo semantics; this adapter pins each exact
// durable read or mutation to the already-admitted call and its live session.
import { sameCanonicalStructuredClone } from '/shared/canonical-clone-digest.js';

const mismatch = () => Object.assign(new Error('persistence authority mismatch'), {
  outcomeKnown: true, retryable: false,
});

/** @param {{binding:any,ctx:any}} input */
export const createPersistenceToolAuthority = ({ binding, ctx }) => {
  const args = binding.args;
  const sessionId = ctx?.session?.sessionId;
  const requireOperation = (/** @type {string} */ name) => {
    if (binding.operation !== name) throw mismatch();
  };
  return Object.freeze({
    readMemoryScope: (/** @type {any} */ scope) => {
      requireOperation('turn.memory.read-scope');
      if (!sameCanonicalStructuredClone(scope, args.scope)
          || typeof ctx?.memory?.readScope !== 'function') {
        throw mismatch();
      }
      return ctx.memory.readScope(scope);
    },
    readMemorySubtree: (/** @type {string} */ requestedWorkspace,
      /** @type {string} */ subpath) => {
      requireOperation('turn.memory.read-subtree');
      if (requestedWorkspace !== args.workspace
          || subpath !== args.subpath || typeof ctx?.memory?.readSubtree !== 'function') {
        throw mismatch();
      }
      return ctx.memory.readSubtree(requestedWorkspace, subpath);
    },
    writeMemory: (/** @type {any} */ scope, /** @type {string} */ body) => {
      requireOperation('turn.memory.write');
      if (!sameCanonicalStructuredClone(scope, args.scope) || body !== args.body
          || typeof ctx?.memory?.writeWithConfirm !== 'function') throw mismatch();
      return ctx.memory.writeWithConfirm({
        scope, body, origin: 'agent',
        confirm: typeof ctx?.confirm === 'function'
          ? async (/** @type {any} */ proposal) => {
            const answer = await ctx.confirm({
              tool: binding.operation, sideEffect: 'write', kind: 'memory_write', proposal,
              summary: `${proposal.op} memory: ${proposal.header} (+${proposal.addedLines}/−${proposal.removedLines})`,
              origins: [], sessionId: sessionId ?? null,
            }, ctx.abortSignal);
            const permission = typeof ctx.readAuthorityPermission === 'function'
              ? await ctx.readAuthorityPermission().catch(() => ({ mode: 'plan' }))
              : ctx.permission;
            return !ctx.abortSignal?.aborted && permission?.mode === 'act' ? answer : 'no';
          }
          : undefined,
      });
    },
    readTodos: async () => {
      requireOperation('turn.todo.read');
      if (!ctx?.todoStore?.apply) throw mismatch();
      const current = await ctx.todoStore.apply((/** @type {any[]} */ todos) => ({
        ok: true, current: Array.isArray(todos) ? todos : [],
      }));
      const todos = Array.isArray(current?.current) ? current.current : [];
      return { todos, version: JSON.stringify(todos) };
    },
    replaceTodos: (/** @type {string} */ version, /** @type {any[]} */ todos) => {
      requireOperation('turn.todo.replace');
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

export const bindPersistenceToolAuthority = (
  /** @type {any} */ state, /** @type {any} */ input,
) => {
  const binding = Object.freeze({ operation: input.operation, args: structuredClone(input.args) });
  return createPersistenceToolAuthority({ ...input, binding });
};
