import { createExecutionToolAuthority } from '../../extension/background/execution-tool-authority.js';

/**
 * Adapt old direct-tool test fixtures to the production controller boundary.
 * The semantic tool sees only named authority methods; raw clients stay in the
 * adapter fixture exactly as they do in the service worker.
 */
export const executionToolContext = (raw: any) => {
  const shared: any = {};
  let scriptArgs: any = null;
  const bind = (operation: string, args: any) => createExecutionToolAuthority({
    binding: { operation, args }, ctx: raw, signal: raw.abortSignal, shared,
  });
  return {
    session: raw.session,
    executionAuthority: {
      createWebVm: (plan: any) => {
        const bound = { ...plan, kind: 'webvm' };
        return bind('turn.execution.create-webvm', { plan: bound }).createWebVm(bound);
      },
      createNotebook: (plan: any) => {
        const bound = { ...plan, kind: 'notebook' };
        return bind('turn.execution.create-notebook', { plan: bound }).createNotebook(bound);
      },
      createPod: (plan: any) => {
        const bound = { ...plan, kind: 'pod' };
        return bind('turn.execution.create-pod', { plan: bound }).createPod(bound);
      },
      createApp: (plan: any) => {
        const bound = { ...plan, kind: 'app' };
        return bind('turn.execution.create-app', { plan: bound }).createApp(bound);
      },
      runHeadlessScript: (request: any) => {
        scriptArgs = {
          code: request.code,
          ...(request.workspace ? { workspace: true } : {}),
          ...(request.timeoutMs === null ? {} : { timeoutMs: request.timeoutMs }),
        };
        return bind('turn.execution.run-script', scriptArgs).runHeadlessScript(request);
      },
      spillScriptValue: (record: any) => bind(
        'turn.execution.spill-script', { ...(scriptArgs ?? {}), record },
      ).spillScriptValue(record),
    },
  };
};
