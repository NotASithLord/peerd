// @ts-check

// Exact engine-creation and headless-run custody for controller-owned tools.
// why: the controller decides what a sandbox/script means; this adapter alone
// may create engine records, open engine tabs, mount session storage, mint run
// grants, or place spill bytes in the session-owned result store.
import { normalizeGitRemote } from '/peerd-engine/authority.js';

const ENGINE_TAB_GROUP_TITLE = 'peerd';

const mismatch = () => Object.assign(new Error('execution authority mismatch'), {
  outcomeKnown: true, retryable: false,
});

const sameClone = (/** @type {unknown} */ left, /** @type {unknown} */ right) => {
  try { return JSON.stringify(left) === JSON.stringify(right); }
  catch { return false; }
};

const expectedTimeout = (
  /** @type {any} */ args, /** @type {boolean} */ actors,
  /** @type {boolean} */ provider,
) => {
  const value = typeof args?.timeoutMs === 'number' ? args.timeoutMs : Number.NaN;
  const fallback = actors || provider ? 270_000 : 30_000;
  const ceiling = actors || provider ? 300_000 : 120_000;
  return Math.min(ceiling, Math.max(1000, Number.isFinite(value) ? value : fallback));
};

const messageOf = (/** @type {unknown} */ cause) =>
  /** @type {{message?:string}} */ (cause)?.message ?? String(cause);

const rollbackCreatedExecution = async (
  /** @type {any} */ ctx, /** @type {any} */ registry,
  /** @type {'notebook'|'pod'} */ kind, /** @type {string} */ id,
) => {
  const repositoryRemoved = !ctx?.repositories?.destroy
    || await ctx.repositories.destroy({ kind, id }, { worktree: true })
      .then(() => true, () => false);
  const recordRemoved = await registry.delete(id).then(
    (/** @type {unknown} */ removed) => removed === true, () => false,
  );
  return repositoryRemoved && recordRemoved;
};

const rollbackFailure = (/** @type {string} */ message) => Object.assign(new Error(message), {
  outcomeKnown: false, performed: true, retryable: false,
});

/** @param {{binding:any,ctx:any,signal?:AbortSignal,shared?:any}} input */
export const createExecutionToolAuthority = ({ binding, ctx, signal, shared = {} }) => {
  const args = binding.args ?? {};
  const sessionId = ctx?.session?.sessionId;
  const abortSignal = signal ?? ctx?.abortSignal;
  const requireOperation = (/** @type {string} */ operation) => {
    if (binding.operation !== operation) throw mismatch();
  };
  const requirePlan = (/** @type {string} */ kind, /** @type {any} */ plan) => {
    requireOperation(`turn.execution.create-${kind}`);
    if (!sameClone(plan, args.plan)) throw mismatch();
  };
  const cloneRemote = async (
    /** @type {'notebook'|'pod'} */ kind, /** @type {string} */ id,
    /** @type {any} */ plan,
  ) => {
    const gitUrl = typeof plan.gitUrl === 'string' ? plan.gitUrl.trim() : '';
    if (!gitUrl) return null;
    if (!ctx?.repositories) return { error: 'repository_unavailable' };
    let remote;
    try { remote = normalizeGitRemote(gitUrl); }
    catch (cause) {
      return { error: `git_clone_failed: ${messageOf(cause)}` };
    }
    if (typeof ctx?.confirm !== 'function') return { error: 'git_confirmation_unavailable' };
    let answer;
    try {
      answer = await ctx.confirm({
        tool: binding.operation, kind: 'git_clone', sideEffect: 'write',
        origins: [new URL(remote.url).origin],
        summary: `Clone ${remote.url} into a local browser ${kind === 'pod' ? 'Pod' : 'Notebook'}? Repository bytes stay in browser storage; a configured vault credential for this host may be used by the broker.`,
      }, abortSignal);
    } catch {
      // why: the engine record already exists. Convert prompt transport loss
      // into the same pre-clone refusal shape so the caller proves rollback
      // before returning instead of abandoning an orphan.
      return { error: 'git_confirmation_failed' };
    }
    if (answer !== true && answer !== 'yes_once' && answer !== 'yes_session') {
      return { error: 'git_clone_declined' };
    }
    if (abortSignal?.aborted) return { error: 'git_clone_aborted' };
    try {
      return await ctx.repositories.clone({ kind, id }, {
        url: remote.url,
        ...(typeof plan.gitRef === 'string' && plan.gitRef.trim()
          ? { ref: plan.gitRef.trim() } : {}),
        depth: Math.min(500, Math.max(1, Number(plan.gitDepth) || 50)),
        signal: abortSignal,
      });
    } catch (cause) {
      return { error: `git_clone_failed: ${messageOf(cause)}` };
    }
  };
  return Object.freeze({
    createWebVm: async (/** @type {any} */ plan) => {
      requirePlan('webvm', plan);
      const registry = ctx?.vmRegistry;
      const tracker = ctx?.vmTabTracker;
      if (!registry || !tracker) return { ok: false, error: 'vm_registry_unavailable' };
      const name = typeof plan.name === 'string' && plan.name.trim()
        ? plan.name.trim().slice(0, 40) : undefined;
      const record = await registry.create({ name, ownerSessionId: sessionId ?? null });
      try {
        await tracker.ensureTab(record.id, { active: false, groupTitle: ENGINE_TAB_GROUP_TITLE });
      } catch (cause) {
        if (tracker.getTabId?.(record.id) == null) {
          const removed = await registry.delete(record.id).then(
            (/** @type {unknown} */ deleted) => deleted === true, () => false,
          );
          if (!removed) {
            throw Object.assign(new Error(`vm_spawn_failed: ${messageOf(cause)}`), {
              outcomeKnown: false, performed: true, retryable: false,
            });
          }
          return { ok: false, error: `vm_spawn_failed: ${messageOf(cause)}` };
        }
      }
      if (sessionId) await registry.setDefaultForSession(sessionId, record.id);
      return { ok: true, record, isCurrent: !!sessionId };
    },
    createNotebook: async (/** @type {any} */ plan) => {
      requirePlan('notebook', plan);
      const registry = ctx?.jsRegistry;
      const tracker = ctx?.jsTabTracker;
      if (!registry || !tracker) return { ok: false, error: 'js_registry_unavailable' };
      const name = typeof plan.name === 'string' && plan.name.trim()
        ? plan.name.trim().slice(0, 40) : undefined;
      const record = await registry.create({ name, ownerSessionId: sessionId ?? null });
      const repository = await cloneRemote('notebook', record.id, plan);
      if (repository?.error) {
        if (!await rollbackCreatedExecution(ctx, registry, 'notebook', record.id)) {
          throw rollbackFailure(repository.error);
        }
        return { ok: false, error: repository.error };
      }
      try {
        await tracker.ensureTab(record.id, { active: false, groupTitle: ENGINE_TAB_GROUP_TITLE });
      } catch (cause) {
        if (tracker.getTabId?.(record.id) == null) {
          const error = `notebook_spawn_failed: ${messageOf(cause)}`;
          if (!await rollbackCreatedExecution(ctx, registry, 'notebook', record.id)) {
            throw rollbackFailure(error);
          }
          return { ok: false, error };
        }
      }
      if (sessionId) await registry.setDefaultForSession(sessionId, record.id);
      return { ok: true, record, repository, isCurrent: !!sessionId };
    },
    createPod: async (/** @type {any} */ plan) => {
      requirePlan('pod', plan);
      const registry = ctx?.podRegistry;
      const tracker = ctx?.podTabTracker;
      if (!registry || !tracker) return { ok: false, error: 'pod_registry_unavailable' };
      const name = typeof plan.name === 'string' && plan.name.trim()
        ? plan.name.trim().slice(0, 40) : undefined;
      const record = await registry.create({
        name, ownerSessionId: sessionId ?? null, persistent: plan.persistent !== false,
      });
      const repository = await cloneRemote('pod', record.id, plan);
      if (repository?.error) {
        const error = repository.error.replace(/^git_clone_failed:/, 'pod_create_failed:');
        if (!await rollbackCreatedExecution(ctx, registry, 'pod', record.id)) {
          throw rollbackFailure(error);
        }
        return { ok: false, error };
      }
      try {
        await tracker.ensureTab(record.id, { active: false, groupTitle: ENGINE_TAB_GROUP_TITLE });
      } catch (cause) {
        if (tracker.getTabId?.(record.id) == null) {
          const error = `pod_create_failed: ${messageOf(cause)}`;
          if (!await rollbackCreatedExecution(ctx, registry, 'pod', record.id)) {
            throw rollbackFailure(error);
          }
          return { ok: false, error };
        }
      }
      if (sessionId) await registry.setDefaultForSession(sessionId, record.id);
      return { ok: true, record, repository, isCurrent: !!sessionId };
    },
    createApp: async (/** @type {any} */ plan) => {
      requirePlan('app', plan);
      const client = ctx?.appClient;
      if (!client) return { ok: false, error: 'app_not_available' };
      const gitUrl = typeof plan.gitUrl === 'string' ? plan.gitUrl.trim() : '';
      const files = plan.files && typeof plan.files === 'object'
        ? plan.files : (typeof plan.html === 'string' ? { 'index.html': plan.html } : null);
      const makeDwapp = plan.dwapp === true && !!ctx?.dweb;
      const tags = makeDwapp
        ? [...new Set([...(Array.isArray(plan.tags) ? plan.tags : []), 'dweb'])]
        : plan.tags;
      try {
        let record;
        let repository = null;
        let contract = null;
        if (gitUrl) {
          let remote;
          try { remote = normalizeGitRemote(gitUrl); }
          catch (cause) { return { ok: false, error: `git_clone_failed: ${messageOf(cause)}` }; }
          if (!client.createFromGit || typeof ctx?.confirm !== 'function') {
            return { ok: false, error: 'git_confirmation_unavailable' };
          }
          const answer = await ctx.confirm({
            tool: binding.operation, kind: 'git_clone', sideEffect: 'write',
            origins: [new URL(remote.url).origin],
            summary: `Clone ${remote.url} and instantiate its peerd.json as a browser App?`,
          }, abortSignal);
          if (answer !== true && answer !== 'yes_once' && answer !== 'yes_session') {
            return { ok: false, error: 'git_clone_declined' };
          }
          if (abortSignal?.aborted) return { ok: false, error: 'git_clone_aborted' };
          const result = await client.createFromGit({
            name: typeof plan.name === 'string' ? plan.name
              : new URL(remote.url).pathname.split('/').at(-1)?.replace(/\.git$/, ''),
            url: remote.url, ref: typeof plan.gitRef === 'string' ? plan.gitRef : undefined,
            depth: Math.min(500, Math.max(1, Number(plan.gitDepth) || 50)),
            sessionId, signal: abortSignal, allowDweb: !!ctx?.dweb,
          });
          if (!result) return { ok: false, error: 'git_app_import_unavailable' };
          ({ record, repository, contract } = result);
        } else {
          if (!client.create) return { ok: false, error: 'app_not_available' };
          record = await client.create({
            name: plan.name, files, tags, entryFile: plan.entryFile, sessionId,
            ...(makeDwapp
              ? { dweb: { uri: null, publisher: null, hash: null, local: true } } : {}),
          });
        }
        let opened = true;
        let openError;
        try { await client.open?.({ appId: record.id, sessionId, focus: false }); }
        catch (cause) {
          opened = false;
          openError = messageOf(cause);
        }
        return { ok: true, record, repository, contract, opened, openError };
      } catch (cause) {
        if (/** @type {{performed?:boolean,outcomeKnown?:boolean}} */ (cause)?.performed === true
            || /** @type {{outcomeKnown?:boolean}} */ (cause)?.outcomeKnown === false) {
          // why: incomplete App rollback is host custody, not a safe semantic
          // creation failure that the model may retry.
          throw cause;
        }
        // why: App storage/catalog failures may contain backend or credential
        // detail. The exact host outcome is known here, but its raw text is not
        // trusted model content.
        return {
          ok: false, error: 'app_create_failed',
          outcomeKind: 'pre-effect-failure', retryable: true,
        };
      }
    },
    runHeadlessScript: async (/** @type {any} */ request) => {
      requireOperation('turn.execution.run-script');
      const code = args.code;
      if (typeof code !== 'string' || request?.code !== code) throw mismatch();
      const sessionKind = ctx?.session?.kind;
      const actorsAllowed = typeof ctx?.messageActor === 'function'
        && ctx?.operationGrant instanceof Set
        && ctx.operationGrant.has('turn.actor.message')
        && sessionKind !== 'actor' && ctx?.inbound !== true;
      const wantsActors = /\bactors\b/.test(code);
      const wantsProvider = /\bpeerd\s*\.\s*provider\b/.test(code);
      const wantsWorkspace = args.workspace === true;
      const actors = actorsAllowed && wantsActors;
      const provider = sessionKind !== 'spawned' && sessionKind !== 'actor'
        && wantsProvider;
      const workspace = wantsWorkspace && !!sessionId
        && sessionKind !== 'spawned' && sessionKind !== 'actor';
      const timeoutMs = expectedTimeout(args, actors, provider);
      if (!request || request.actors !== wantsActors || request.provider !== wantsProvider
          || request.workspace !== wantsWorkspace
          || request.timeoutMs !== (args.timeoutMs ?? null)) throw mismatch();
      const client = ctx?.jsOffscreenClient;
      const runs = ctx?.scriptRuns;
      if (!client?.execHeadless) return { ok: false, error: 'headless_js_unavailable' };
      if (abortSignal?.aborted) {
        return { ok: false, error: 'script_aborted: the turn was stopped before the run started' };
      }
      /** @type {string|undefined} */
      let runId;
      /** @type {(()=>void)|undefined} */
      let onAbort;
      const deliveryIds = new Set();
      try {
        /** @type {any} */
        const opts = { timeoutMs, caps: { subagent: false }, signal: abortSignal };
        if (workspace) opts.workspaceSessionId = sessionId;
        if (sessionId && runs) {
          runId = runs.mintRunId(sessionId);
          runs.register(runId, abortSignal, sessionId, {
            actors, provider, egress: true,
          }, actors ? [
            'turn.actor.message', 'turn.introspection.actor-roster',
          ].filter((operation) => ctx.operationGrant.has(operation)) : []);
          onAbort = () => { void client.abortHeadless?.(runId, sessionId); };
          if (abortSignal && client.abortHeadless) {
            if (abortSignal.aborted) onAbort();
            else abortSignal.addEventListener('abort', onAbort, { once: true });
          }
          Object.assign(opts, { runId, ownerSessionId: sessionId });
          if (actors) Object.assign(opts, { actors: true, ownerToolUseId: ctx?.toolUseId });
          if (provider) opts.caps = { ...opts.caps, provider: true };
        }
        const result = await client.execHeadless(code, opts);
        for (const id of result?.actorDeliveryIds ?? []) if (typeof id === 'string') deliveryIds.add(id);
        for (const op of runId && runs?.opsFor?.(runId) || []) {
          if (typeof op?.actorDeliveryId === 'string') deliveryIds.add(op.actorDeliveryId);
        }
        shared.lastScriptResult = result;
        if (result?.outcomeKnown === false) {
          // why: the job may finish only after an admitted nested App/page/
          // actor/site operation loses host custody. The script resource did
          // run, but neither a caught worker error nor a fulfilled offscreen
          // RPC can make the whole effect safe to retry.
          return {
            ok: false,
            error: 'script_nested_host_outcome_unknown',
            outcomeKnown: false,
            outcomeKind: result?.outcomeKind === 'host-lost'
              ? 'host-lost' : 'transport-lost',
            performed: true,
            retryable: false,
            result,
            actorDeliveryIds: [...deliveryIds],
          };
        }
        return { ok: true, result, actorDeliveryIds: [...deliveryIds] };
      } catch (cause) {
        const mirrored = runId && runs?.opsFor?.(runId) || [];
        for (const op of mirrored) if (typeof op?.actorDeliveryId === 'string') deliveryIds.add(op.actorDeliveryId);
        const detail = /** @type {{name?:string,outcomeKnown?:boolean}} */ (cause);
        if (detail?.outcomeKnown === true) {
          return {
            ok: false,
            errorName: String(detail.name ?? 'Error').slice(0, 80),
            errorMessage: messageOf(cause).slice(0, 2048),
            actors, mirrored, actorDeliveryIds: [...deliveryIds],
          };
        }
        // why: execHeadless resolves ordinary user-code failures. A rejected
        // host call means the resource crossed dispatch without attesting its
        // outcome, so lifecycle custody must keep it unknown.
        const error = Object.assign(new Error(messageOf(cause)), {
          name: String(detail?.name ?? 'Error').slice(0, 80),
          outcomeKnown: false,
          retryable: false,
          actors, mirrored, actorDeliveryIds: [...deliveryIds],
        });
        throw error;
      } finally {
        if (runId && runs) runs.release(runId);
        if (onAbort && abortSignal) abortSignal.removeEventListener?.('abort', onAbort);
      }
    },
    spillScriptValue: async (/** @type {any} */ record) => {
      requireOperation('turn.execution.spill-script');
      if (!shared.lastScriptResult || !record || typeof record.text !== 'string'
          || typeof record.fenced !== 'boolean' || typeof record.originLabel !== 'string'
          || !sessionId || !ctx?.resultStore?.key || !ctx?.resultStore?.put) throw mismatch();
      const expectedFenced = !!(shared.lastScriptResult.usedEgress
        || shared.lastScriptResult.usedRemoteModules || shared.lastScriptResult.usedActors
        || shared.lastScriptResult.usedPage || shared.lastScriptResult.usedApp
        || shared.lastScriptResult.usedWorkspace);
      if (record.fenced !== expectedFenced || record.originLabel.length > 256) throw mismatch();
      const key = ctx.resultStore.key();
      await ctx.resultStore.put({
        key, ownerSessionId: sessionId, producer: 'script',
        fenced: record.fenced, originLabel: record.originLabel, text: record.text,
      });
      return key;
    },
  });
};

export const bindExecutionToolAuthority = (
  /** @type {any} */ state, /** @type {any} */ input,
) => createExecutionToolAuthority({
  ...input,
  binding: Object.freeze({ operation: input.operation, args: structuredClone(input.args) }),
  shared: state,
});
