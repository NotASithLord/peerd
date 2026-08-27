import { createExecutionToolAuthority } from '../../extension/background/execution-tool-authority.js';

/**
 * Adapt old direct-tool test fixtures to the production controller boundary.
 * The semantic tool sees only named authority methods; raw clients stay in the
 * adapter fixture exactly as they do in the service worker.
 */
export const executionToolContext = (raw: any) => {
  let scriptAuthority: any;
  const bind = (name: string, args: any) => createExecutionToolAuthority({
    call: { id: `test:${name}`, name, args }, ctx: raw, signal: raw.abortSignal,
  });
  return {
    session: raw.session,
    executionAuthority: {
      createWebVm: (plan: any) => {
        const bound = { ...plan, kind: 'webvm' };
        return bind('sandbox_create', bound).createWebVm(bound);
      },
      createNotebook: (plan: any) => {
        const bound = { ...plan, kind: 'notebook' };
        return bind('sandbox_create', bound).createNotebook(bound);
      },
      createPod: (plan: any) => {
        const bound = { ...plan, kind: 'pod' };
        return bind('sandbox_create', bound).createPod(bound);
      },
      createApp: (plan: any) => {
        const bound = { ...plan, kind: 'app' };
        return bind('sandbox_create', bound).createApp(bound);
      },
      runHeadlessScript: (request: any) => {
        scriptAuthority = bind('script', {
          code: request.code,
          ...(request.workspace ? { workspace: true } : {}),
          ...(request.timeoutMs === null ? {} : { timeoutMs: request.timeoutMs }),
        });
        return scriptAuthority.runHeadlessScript(request);
      },
      spillScriptValue: (record: any) => scriptAuthority.spillScriptValue(record),
    },
  };
};
