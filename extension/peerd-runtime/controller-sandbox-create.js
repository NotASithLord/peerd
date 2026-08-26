// @ts-check

import { normalizeGitRemote } from '../peerd-engine/repository/remote.js';
import { sandboxCreateTool } from './tools/defs/sandbox-create.js';

const effectError = (/** @type {any} */ result) => Object.assign(
  new Error(result?.error ?? result?.code ?? 'sandbox effect failed'),
  {
    code: result?.code ?? 'sandbox-effect-failed',
    outcomeKnown: result?.outcomeKnown === true,
    retryable: result?.retryable === true,
  },
);

/**
 * Convert the six sandbox-scoped kernel effects into the exact context surface
 * the existing kind planners consume. No browser, registry, repository, or
 * storage object crosses into the controller heap.
 * @param {any} args
 * @param {{projection:any,signal:AbortSignal,effects:Record<string,Function>}} context
 */
const controllerContext = (args, context) => {
  const call = async (/** @type {string} */ method, /** @type {unknown} */ payload) => {
    const result = await context.effects[method]({ json: JSON.stringify(payload) });
    if (result?.ok !== true) throw effectError(result);
    return JSON.parse(result.value.json);
  };
  const mutateRecord = (/** @type {string} */ kind, /** @type {string} */ action,
    /** @type {Record<string,unknown>} */ value) =>
    call('mutateRecord', { kind, action, ...value });
  const ensureTab = (/** @type {string} */ kind, /** @type {string} */ id) =>
    call('ensureTab', { kind, id });
  const registry = (/** @type {'webvm'|'notebook'|'pod'} */ kind) => ({
    create: (/** @type {Record<string,unknown>} */ options) =>
      mutateRecord(kind, 'create', { options }),
    delete: (/** @type {string} */ id) => mutateRecord(kind, 'delete', { id }),
    setDefaultForSession: (/** @type {string} */ _sessionId, /** @type {string} */ id) =>
      mutateRecord(kind, 'default', { id }),
  });
  const tracker = (/** @type {'webvm'|'notebook'|'pod'} */ kind) => ({
    ensureTab: (/** @type {string} */ id) => ensureTab(kind, id),
    // The kernel's ensureTab effect absorbs only a timeout for a tab it can
    // prove exists. A rejected effect is therefore a real spawn failure.
    getTabId: () => null,
  });
  const normalizedGitUrl = () => normalizeGitRemote(String(args?.gitUrl ?? '')).url;
  return {
    session: { sessionId: context.projection.sessionId },
    abortSignal: context.signal,
    dweb: context.projection.dwebEnabled === true ? Object.freeze({}) : null,
    vmRegistry: registry('webvm'),
    vmTabTracker: tracker('webvm'),
    jsRegistry: registry('notebook'),
    jsTabTracker: tracker('notebook'),
    podRegistry: registry('pod'),
    podTabTracker: tracker('pod'),
    repositories: {
      clone: (/** @type {any} */ ref, /** @type {any} */ options) =>
        call('mutateRepository', { action: 'clone', ref, options }),
      destroy: (/** @type {any} */ ref, /** @type {any} */ options) =>
        call('mutateRepository', { action: 'destroy', ref, options }),
    },
    appClient: {
      create: (/** @type {any} */ options) =>
        call('persistApp', { mode: 'create', options }),
      createFromGit: (/** @type {any} */ options) =>
        call('persistApp', { mode: 'import', options }),
      open: (/** @type {any} */ options) => call('openApp', options),
    },
    confirm: (/** @type {any} */ _prompt) => call('confirmGitClone', {
      kind: args?.kind,
      url: normalizedGitUrl(),
    }),
  };
};

/** @param {any} args @param {any} context */
export const executeSandboxCreate = (args, context) =>
  sandboxCreateTool.execute(args, /** @type {import('/shared/tool-types.js').ToolContext} */ (
    /** @type {unknown} */ (controllerContext(args, context))
  ));
