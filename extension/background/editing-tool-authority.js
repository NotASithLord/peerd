// @ts-check

// Exact edit-target custody. Search/replace parsing and result shaping stay in
// the controller; only the admitted App/Notebook path can be read and written.
const mismatch = () => Object.assign(new Error('editing authority mismatch'), {
  outcomeKnown: true, retryable: false,
});

/** @param {{binding:any,ctx:any,signal?:AbortSignal,shared?:any}} input */
export const createEditingToolAuthority = ({ binding, ctx, signal, shared = {} }) => {
  const args = binding.args;
  const kind = args.kind === 'notebook' ? 'notebook' : 'app';
  const boundKind = ctx?.actorType === 'app' || ctx?.actorType === 'notebook'
    ? ctx.actorType : null;
  const boundTargetId = boundKind && typeof ctx?.actorInstanceId === 'string'
    && ctx.actorInstanceId ? ctx.actorInstanceId : null;
  if (boundKind && (kind !== boundKind || !boundTargetId
      || typeof args.targetId === 'string' && args.targetId !== boundTargetId)) throw mismatch();
  const sessionId = ctx?.session?.sessionId;
  const requireTarget = (/** @type {any} */ target) => {
    if (!target || target.kind !== kind
        || target.path !== args.path
        || target.targetId !== (typeof args.targetId === 'string' ? args.targetId : null)) {
      throw mismatch();
    }
  };
  const client = kind === 'app' ? ctx?.appClient : ctx?.jsClient;
  const registry = kind === 'app' ? ctx?.appRegistry : ctx?.jsRegistry;
  if (kind === 'notebook' && typeof ctx?.repositories?.coordinate !== 'function') {
    // why: compare-then-write must share the Notebook repository lane with
    // checkout/restore/commit; a private fallback can overwrite a concurrent
    // repository mutation after comparing stale bytes.
    throw new TypeError('notebook repository coordination is required');
  }
  const canResolveDefault = !!sessionId
    && typeof registry?.getDefaultForSession === 'function';
  const stoppedResult = () => ({
    ok: false, code: 'edit_aborted', retryable: false,
    error: 'The edit was stopped before writing.', outcomeKind: 'pre-effect-failure',
  });
  const resolveTargetId = async (/** @type {any} */ target) => {
    if (boundTargetId) return boundTargetId;
    if (typeof target.targetId === 'string' && target.targetId) return target.targetId;
    if (!sessionId || typeof registry?.getDefaultForSession !== 'function') return null;
    return registry.getDefaultForSession(sessionId).catch(() => null);
  };
  const readSource = async (/** @type {string|null} */ targetId, /** @type {string} */ path) => {
    try {
      const value = kind === 'app'
        ? await client.readFile({ appId: targetId ?? undefined, path, sessionId })
        : await client.readFile(path, { notebookId: targetId ?? undefined, sessionId });
      return { exists: value != null, source: value ?? '' };
    } catch (cause) {
      const error = /** @type {{name?:string}} */ (cause);
      if (error.name === 'NotFoundError') return { exists: false, source: '' };
      throw cause;
    }
  };
  return Object.freeze({
    readEditTarget: async (/** @type {any} */ target) => {
      if (binding.operation !== 'turn.editing.read-target') throw mismatch();
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
      if (kind === 'app' && (!client?.readFile || !client?.writeFile)) {
        return { ok: false, error: 'app_not_available' };
      }
      if (kind === 'notebook' && (!client?.readFile || !client?.writeFile)) {
        return { ok: false, error: 'notebook_not_available' };
      }
      const resolvedTargetId = await resolveTargetId(target);
      if (signal?.aborted) return stoppedResult();
      if (!target.targetId && canResolveDefault && !resolvedTargetId) {
        const create = kind === 'app'
          ? "sandbox_create({kind:'app'})"
          : "sandbox_create({kind:'notebook'}) or js_notebook";
        return {
          ok: false, code: 'no_current_instance',
          error: `An edit needs a current ${kind} in this chat: create one first (${create})`,
        };
      }
      try {
        const current = await readSource(resolvedTargetId, target.path);
        shared.admittedRead = true;
        shared.editReadSnapshot = Object.freeze({
          targetId: resolvedTargetId,
          path: target.path,
          exists: current.exists,
          source: current.source,
        });
        return { ok: true, exists: current.exists, source: current.source };
      } catch (cause) {
        const error = /** @type {{name?:string,code?:string,message?:string}} */ (cause);
        return {
          ok: false, code: error.code ?? 'read_failed',
          error: `read_failed: ${error.message ?? String(cause)}`,
        };
      }
    },
    writeEditTarget: async (/** @type {any} */ target) => {
      if (binding.operation !== 'turn.editing.write-target') throw mismatch();
      requireTarget(target);
      const snapshot = shared.editReadSnapshot;
      if (!shared.admittedRead || !snapshot || typeof target.content !== 'string') throw mismatch();
      const resolvedTargetId = await resolveTargetId(target);
      if (resolvedTargetId !== snapshot.targetId || target.path !== snapshot.path) {
        return {
          ok: false, code: 'edit_conflict', retryable: false,
          error: 'The edit target changed after it was read; review the latest file before writing.',
          outcomeKind: 'pre-effect-failure',
        };
      }
      if (kind === 'app' && typeof client?.compareAndWriteFile === 'function') {
        const result = await client.compareAndWriteFile({
          appId: resolvedTargetId ?? undefined, path: target.path,
          content: target.content, sessionId,
          expectedExists: snapshot.exists, expectedContent: snapshot.source, signal,
        });
        return result?.ok === true ? { ok: true } : result;
      }
      const compareAndWrite = async () => {
        const current = await readSource(resolvedTargetId, target.path);
        if (signal?.aborted) return stoppedResult();
        if (current.exists !== snapshot.exists || current.source !== snapshot.source) {
          return {
            ok: false, code: 'edit_conflict', retryable: false,
            error: 'The file changed after it was read; review the latest contents before writing.',
            outcomeKind: 'pre-effect-failure',
          };
        }
        if (signal?.aborted) return stoppedResult();
        if (kind === 'app') {
          await client.writeFile({
            appId: resolvedTargetId ?? undefined, path: target.path,
            content: target.content, sessionId,
          });
        } else {
          await client.writeFile(target.path, target.content, {
            notebookId: resolvedTargetId ?? undefined, sessionId,
          });
        }
        return { ok: true };
      };
      if (kind === 'notebook' && resolvedTargetId) {
        return ctx.repositories.coordinate(
          { kind: 'notebook', id: resolvedTargetId }, compareAndWrite,
        );
      }
      return compareAndWrite();
    },
  });
};

export const bindEditingToolAuthority = (
  /** @type {any} */ state, /** @type {any} */ input,
) => {
  const binding = Object.freeze({ operation: input.operation, args: structuredClone(input.args) });
  return createEditingToolAuthority({ ...input, binding, shared: state });
};
