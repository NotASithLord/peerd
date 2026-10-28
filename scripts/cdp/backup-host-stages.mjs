// Temporary diagnostic: bounded logpoints, never pause or replace product APIs.
import { readFile } from 'node:fs/promises';
import { locateLockStage } from './vault-lock-stages.mjs';

export async function armBackupHostStages(ctx) {
  const worker = ctx.swConn;
  const points = [];
  await worker.send('Debugger.enable');
  await worker.send('Runtime.evaluate', { expression: 'globalThis.__backupStages = []' });
  for (const [file, marker, stage, details] of [
    ['feature-lease-coordinator.js', "if (disabled.has(scope)) return outcome(false, 'feature-lease-disabled', true, { scope });", 'start',
      "disabled:disabled.has(scope),locked,reason:['host-replaced','feature-demand','vault-resume','vault-unlock','vault-initialize','boot-reconcile'].includes(options.reason)?options.reason:'other'"],
    ['feature-lease-runtime.js', "if (create) await hostEffect(() => ensureOffscreen(scope), 'ensure');", 'ensure', 'create'],
  ]) {
    const source = await readFile(new URL(`../../extension/background/${file}`, import.meta.url), 'utf8');
    const location = locateLockStage(source, marker);
    const point = await worker.send('Debugger.setBreakpointByUrl', {
      url: `chrome-extension://${ctx.sw.id}/background/${file}`, ...location,
      condition: `(globalThis.__backupStages.length < 128 && globalThis.__backupStages.push({stage:${JSON.stringify(stage)},scope:['vault-authority','controller','dweb','dom-host','media-host','model-host'].includes(scope)?scope:'other',at:Date.now(),${details}}),false)`,
    });
    points.push(point);
    if (!point.locations?.some(item => item.lineNumber === location.lineNumber)) {
      throw new Error(`backup host logpoint unresolved: ${stage}`);
    }
  }
  return {
    read: async () => (await worker.send('Runtime.evaluate', {
      expression: 'globalThis.__backupStages', returnByValue: true,
    })).result?.value,
    close: async () => {
      for (const point of points) await worker.send('Debugger.removeBreakpoint', { breakpointId: point.breakpointId });
      await worker.send('Debugger.disable');
    },
  };
}
