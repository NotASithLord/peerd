// @ts-check

// Exact edit-target custody. Search/replace parsing and result shaping stay in
// the controller; only the admitted App/Notebook path can be read and written.
const mismatch = () => Object.assign(new Error('editing authority mismatch'), {
  outcomeKnown: true, retryable: false,
});

/** @param {{call:any,ctx:any}} input */
export const createEditingToolAuthority = ({ call, ctx }) => {
  const args = call?.args ?? {};
  const kind = args.kind === 'notebook' ? 'notebook' : 'app';
  const sessionId = ctx?.session?.sessionId;
  let admittedRead = false;
  const requireTarget = (/** @type {any} */ target) => {
    if (call?.name !== 'edit_file' || !target || target.kind !== kind
        || target.path !== args.path
        || target.targetId !== (typeof args.targetId === 'string' ? args.targetId : null)) {
      throw mismatch();
    }
  };
  return Object.freeze({
    readEditTarget: async (/** @type {any} */ target) => {
      requireTarget(target);
      const permission = ctx?.permissions?.canWrite;
      if (typeof permission === 'function') {
        let allowed;
        try { allowed = await permission(ctx); }
        catch (cause) {
          const error = /** @type {{message?:string}} */ (cause);
          return { ok: false, error: `write_denied: permission check failed: ${error.message ?? String(cause)}` };
        }
        if (allowed?.allowed !== true) {
          return { ok: false, error: `write_denied: ${allowed?.reason ?? 'plan mode'}` };
        }
      }
      const client = kind === 'app' ? ctx?.appClient : ctx?.jsClient;
      if (kind === 'app' && (!client?.readFile || !client?.writeFile)) {
        return { ok: false, error: 'app_not_available' };
      }
      if (kind === 'notebook' && (!client?.readFile || !client?.writeFile)) {
        return { ok: false, error: 'notebook_not_available' };
      }
      if (!target.targetId && sessionId) {
        const registry = kind === 'app' ? ctx?.appRegistry : ctx?.jsRegistry;
        if (registry?.getDefaultForSession) {
          const currentId = await registry.getDefaultForSession(sessionId).catch(() => null);
          if (!currentId) {
            const create = kind === 'app'
              ? "sandbox_create({kind:'app'})"
              : "sandbox_create({kind:'notebook'}) or js_notebook";
            return {
              ok: false, code: 'no_current_instance',
              error: `edit_file needs a current ${kind} in this chat — create one first (${create})`,
            };
          }
        }
      }
      try {
        const value = kind === 'app'
          ? await client.readFile({ appId: target.targetId ?? undefined, path: target.path, sessionId })
          : await client.readFile(target.path, {
            notebookId: target.targetId ?? undefined, sessionId,
          });
        admittedRead = true;
        return { ok: true, exists: value != null, source: value ?? '' };
      } catch (cause) {
        const error = /** @type {{name?:string,code?:string,message?:string}} */ (cause);
        if (error.name === 'NotFoundError') {
          admittedRead = true;
          return { ok: true, exists: false, source: '' };
        }
        return {
          ok: false, code: error.code ?? 'read_failed',
          error: `read_failed: ${error.message ?? String(cause)}`,
        };
      }
    },
    writeEditTarget: async (/** @type {any} */ target) => {
      requireTarget(target);
      if (!admittedRead || typeof target.content !== 'string') throw mismatch();
      const client = kind === 'app' ? ctx?.appClient : ctx?.jsClient;
      if (kind === 'app') {
        await client.writeFile({
          appId: target.targetId ?? undefined, path: target.path,
          content: target.content, sessionId,
        });
      } else {
        await client.writeFile(target.path, target.content, {
          notebookId: target.targetId ?? undefined, sessionId,
        });
      }
      return { ok: true };
    },
  });
};

export const bindEditingToolAuthority = (
  /** @type {any} */ state, /** @type {any} */ input,
) => state.authority ??= createEditingToolAuthority(input);
