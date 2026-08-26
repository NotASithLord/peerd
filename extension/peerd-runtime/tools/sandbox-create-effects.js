// @ts-check

import { normalizeGitRemote } from '/peerd-engine/background.js';

const states = new WeakMap();
const KINDS = new Set(['webvm', 'notebook', 'pod', 'app']);
const RECORD_KINDS = new Set(['webvm', 'notebook', 'pod']);

const object = (/** @type {unknown} */ value) => value && typeof value === 'object'
  && !Array.isArray(value) ? /** @type {Record<string,any>} */ (value) : null;
const exactKeys = (/** @type {Record<string,any>} */ value, /** @type {string[]} */ keys) =>
  Object.keys(value).every((key) => keys.includes(key));
const failure = (/** @type {string} */ code, /** @type {string} */ error = code) => ({
  ok: false, code, error, outcomeKnown: true,
});
const success = (/** @type {unknown} */ value) => ({
  ok: true, outcomeKnown: true, value: { json: JSON.stringify(value ?? null) },
});
const requestOf = (/** @type {unknown} */ payload) => {
  const envelope = object(payload);
  if (!envelope || !exactKeys(envelope, ['json']) || typeof envelope.json !== 'string') return null;
  try {
    const request = JSON.parse(envelope.json);
    return object(request);
  } catch { return null; }
};
const registryFor = (/** @type {any} */ ctx, /** @type {string} */ kind) => ({
  webvm: ctx.vmRegistry, notebook: ctx.jsRegistry, pod: ctx.podRegistry,
})[kind];
const trackerFor = (/** @type {any} */ ctx, /** @type {string} */ kind) => ({
  webvm: ctx.vmTabTracker, notebook: ctx.jsTabTracker, pod: ctx.podTabTracker,
})[kind];

/**
 * Exact privileged effects for the controller-owned sandbox_create planner.
 * The execution-scoped WeakMap binds every follow-up mutation to the record
 * created by this one admitted tool call.
 * @param {{custody:any,operation:string,payload:unknown,binding:any}} input
 */
const runSandboxCreateEffect = async ({ custody, operation, payload, binding }) => {
  const request = requestOf(payload);
  const ctx = custody?.ctx;
  if (!request || !ctx || !binding || typeof binding.sessionId !== 'string') {
    return failure('sandbox-effect-request-invalid');
  }
  let state = states.get(custody);
  if (!state) {
    state = { created: null, approvedGitUrl: null };
    states.set(custody, state);
  }
  const sameCreated = (/** @type {string} */ kind, /** @type {unknown} */ id) =>
    state.created?.kind === kind && state.created.id === id;

  if (operation === 'sandbox.record.mutate') {
    if (!exactKeys(request, ['kind', 'action', 'options', 'id'])
        || !RECORD_KINDS.has(request.kind)
        || !['create', 'delete', 'default'].includes(request.action)) {
      return failure('sandbox-record-request-invalid');
    }
    const registry = registryFor(ctx, request.kind);
    if (!registry) return failure('sandbox-record-unavailable');
    if (request.action === 'create') {
      if (state.created) return failure('sandbox-record-already-created');
      const options = object(request.options) ?? {};
      const name = typeof options.name === 'string' && options.name.trim()
        ? options.name.trim().slice(0, 40) : undefined;
      const record = await registry.create({
        ...(name ? { name } : {}), ownerSessionId: binding.sessionId,
        ...(request.kind === 'pod' ? { persistent: options.persistent !== false } : {}),
      });
      if (!record || typeof record.id !== 'string') {
        return failure('sandbox-record-create-invalid');
      }
      state.created = { kind: request.kind, id: record.id };
      return success({
        id: record.id, name: record.name,
        ...(request.kind === 'pod' ? { persistent: record.persistent !== false } : {}),
      });
    }
    if (!sameCreated(request.kind, request.id)) {
      return failure('sandbox-record-binding-mismatch');
    }
    if (request.action === 'delete') {
      await registry.delete(request.id);
      return success(null);
    }
    await registry.setDefaultForSession(binding.sessionId, request.id);
    return success(null);
  }

  if (operation === 'sandbox.tab.ensure') {
    if (!exactKeys(request, ['kind', 'id']) || !RECORD_KINDS.has(request.kind)
        || !sameCreated(request.kind, request.id)) {
      return failure('sandbox-tab-request-invalid');
    }
    const tracker = trackerFor(ctx, request.kind);
    if (!tracker?.ensureTab) return failure('sandbox-tab-unavailable');
    try {
      await tracker.ensureTab(request.id, { active: false, groupTitle: 'peerd' });
    } catch (cause) {
      // Background throttling can miss readiness after the tab exists. Preserve
      // the original create contract: only a proven absence is a failure.
      if (tracker.getTabId?.(request.id) == null) throw cause;
    }
    return success(null);
  }

  if (operation === 'sandbox.git.confirm') {
    if (!exactKeys(request, ['kind', 'url']) || !['notebook', 'pod', 'app'].includes(request.kind)
        || typeof request.url !== 'string' || typeof ctx.confirm !== 'function') {
      return failure('sandbox-confirm-request-invalid');
    }
    let remote;
    try { remote = normalizeGitRemote(request.url); }
    catch { return failure('sandbox-git-url-invalid'); }
    const summaries = {
      notebook: `Clone ${remote.url} into a lightweight browser Notebook? Repository bytes stay in browser storage; a vault token for this host is used if configured.`,
      pod: `Clone ${remote.url} into a local Peerd Pod? Repository bytes stay in OPFS; a configured vault credential for this host may be used by the broker.`,
      app: `Clone ${remote.url} and instantiate its peerd.json as a browser App?`,
    };
    const answer = await ctx.confirm({
      tool: 'sandbox_create', kind: 'git_clone', sideEffect: 'write',
      origins: [new URL(remote.url).origin],
      summary: summaries[/** @type {'notebook'|'pod'|'app'} */ (request.kind)],
      sessionId: binding.sessionId, dispatchId: custody.call?.id ?? null,
    }, binding.signal);
    if (answer === true || answer === 'yes_once' || answer === 'yes_session') {
      state.approvedGitUrl = remote.url;
    }
    return success(answer);
  }

  if (operation === 'sandbox.repository.mutate') {
    if (!exactKeys(request, ['action', 'ref', 'options'])
        || !['clone', 'destroy'].includes(request.action)) {
      return failure('sandbox-repository-request-invalid');
    }
    const ref = object(request.ref);
    const options = object(request.options) ?? {};
    if (!ref || !['notebook', 'pod'].includes(ref.kind)
        || !sameCreated(ref.kind, ref.id) || !ctx.repositories) {
      return failure('sandbox-repository-binding-mismatch');
    }
    if (request.action === 'destroy') {
      await ctx.repositories.destroy({ kind: ref.kind, id: ref.id }, { worktree: true });
      return success(null);
    }
    let remote;
    try { remote = normalizeGitRemote(options.url); }
    catch { return failure('sandbox-git-url-invalid'); }
    if (remote.url !== state.approvedGitUrl) return failure('sandbox-git-approval-mismatch');
    const result = await ctx.repositories.clone({ kind: ref.kind, id: ref.id }, {
      url: remote.url,
      ...(typeof options.ref === 'string' && options.ref.trim()
        ? { ref: options.ref.trim() } : {}),
      depth: Math.min(500, Math.max(1, Number(options.depth) || 50)),
      signal: binding.signal,
    });
    return success(result);
  }

  if (operation === 'sandbox.app.persist') {
    if (!exactKeys(request, ['mode', 'options']) || !['create', 'import'].includes(request.mode)
        || state.created || !ctx.appClient) {
      return failure('sandbox-app-request-invalid');
    }
    const options = object(request.options);
    if (!options) return failure('sandbox-app-options-invalid');
    let value;
    if (request.mode === 'import') {
      let remote;
      try { remote = normalizeGitRemote(options.url); }
      catch { return failure('sandbox-git-url-invalid'); }
      if (remote.url !== state.approvedGitUrl || typeof ctx.appClient.createFromGit !== 'function') {
        return failure('sandbox-git-approval-mismatch');
      }
      value = await ctx.appClient.createFromGit({
        name: typeof options.name === 'string' ? options.name : undefined,
        url: remote.url,
        ref: typeof options.ref === 'string' ? options.ref : undefined,
        depth: Math.min(500, Math.max(1, Number(options.depth) || 50)),
        sessionId: binding.sessionId, signal: binding.signal,
        allowDweb: !!ctx.dweb,
      });
      if (!value?.record?.id) return failure('sandbox-app-import-invalid');
      state.created = { kind: 'app', id: value.record.id };
      return success(value);
    }
    if (typeof ctx.appClient.create !== 'function') return failure('sandbox-app-unavailable');
    const record = await ctx.appClient.create({
      name: options.name,
      files: options.files,
      tags: options.tags,
      entryFile: options.entryFile,
      sessionId: binding.sessionId,
      ...(options.dweb && ctx.dweb
        ? { dweb: { uri: null, publisher: null, hash: null, local: true } } : {}),
    });
    if (!record?.id) return failure('sandbox-app-create-invalid');
    state.created = { kind: 'app', id: record.id };
    return success(record);
  }

  if (operation === 'sandbox.app.open') {
    if (!exactKeys(request, ['appId', 'sessionId', 'focus'])
        || !sameCreated('app', request.appId) || typeof ctx.appClient?.open !== 'function') {
      return failure('sandbox-app-open-request-invalid');
    }
    const result = await ctx.appClient.open({
      appId: request.appId, sessionId: binding.sessionId, focus: false,
    });
    return success(result);
  }

  return failure('tool-effect-denied');
};

/**
 * Local effect failures are known kernel replies. Only an actual controller
 * channel loss may turn a resource effect into an unknown outcome.
 * @param {{custody:any,operation:string,payload:unknown,binding:any}} input
 */
export const handleSandboxCreateEffect = async (input) => {
  try { return await runSandboxCreateEffect(input); }
  catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return failure('sandbox-effect-failed', message.slice(0, 4_096));
  }
};
