// Diagnostic logpoints record stage entry without pausing or changing product APIs.
import { readFile } from 'node:fs/promises';

export const LOCK_STAGES = [
  ['background/routes/vault.js', '        try { await vault.lock(); }', 'authority-lock'],
  ['background/routes/vault.js', '        try { await onLocked(); }', 'authority-settled'],
  ['background/routes/vault.js', 'try { receipt = await voice(); }', 'voice-stop'],
  ['background/routes/vault.js', 'const results = await stop();', 'voice-settled'],
  ['background/kernel-feature-host.js', 'await runtime.ready;\n    return runtime.lock();', 'feature-host-ready-wait'],
  ['background/kernel-feature-host.js', 'return runtime.lock();\n  };\n  const ensureDwebFeature', 'feature-host-ready-settled'],
  ['background/feature-lease-runtime.js', 'const results = coordinator.lock();', 'coordinator-lock'],
  ['background/feature-lease-runtime.js', 'const finished = await withHostLifecycle(() => finishLockUnsafe(results));', 'host-lane-wait'],
  ['background/feature-lease-runtime.js', 'const results = await resultsPromise;', 'host-lane-enter-stop-receipts-wait'],
  ['background/feature-lease-runtime.js', 'const retirements = await retirePoisonedHostsUnsafe();', 'stop-receipts-settled'],
  ['background/feature-lease-runtime.js', 'await stopOrphanedHostScopes(OFFSCREEN_FEATURE_LEASE_SCOPES);', 'orphan-stop'],
  ['background/feature-lease-runtime.js', 'await closeHostIfIdleUnsafe();\n    return Object.freeze({ results, retirements });', 'host-close'],
  ['background/feature-lease-runtime.js', 'return Object.freeze({ results, retirements });', 'host-cleanup-settled'],
  ['background/routes/vault.js', "await auditLog.append({ type: 'vault_locked' })", 'audit-wait'],
  ['background/routes/vault.js', 'await Promise.resolve(pushState())', 'state-publish-wait'],
  ['background/routes/vault.js', 'if (failure) throw failure;', 'route-settled'],
];

export const locateLockStage = (source, marker) => {
  const index = source.indexOf(marker);
  if (index < 0 || source.indexOf(marker, index + 1) >= 0) {
    throw new Error(`vault-lock diagnostic marker must be unique: ${marker}`);
  }
  return { lineNumber: source.slice(0, index).split('\n').length - 1,
    columnNumber: index - source.lastIndexOf('\n', index - 1) - 1 };
};

export const armVaultLockStages = async (ctx) => {
  const worker = ctx.swConn;
  if (!worker) throw new Error('vault-lock diagnostic worker connection unavailable');
  const key = '__peerdVaultLockStages';
  const points = [];
  const remove = async () => {
    await Promise.all(points.map(({ breakpointId }) => worker.send('Debugger.removeBreakpoint', { breakpointId }).catch(() => {})));
    await worker.send('Runtime.evaluate', { expression: `delete globalThis.${key}` }).catch(() => {});
    await worker.send('Debugger.disable').catch(() => {});
  };
  try {
    await worker.send('Debugger.enable');
    await worker.send('Runtime.evaluate', { expression: `globalThis.${key} = []` });
    for (const [file, marker, stage] of LOCK_STAGES) {
      const source = await readFile(new URL(`../../extension/${file}`, import.meta.url), 'utf8');
      const { lineNumber, columnNumber } = locateLockStage(source, marker);
      const point = await worker.send('Debugger.setBreakpointByUrl', {
        url: `chrome-extension://${ctx.sw.id}/${file}`, lineNumber, columnNumber,
        condition: `(globalThis.${key}.length < 64 && globalThis.${key}.push({stage:${JSON.stringify(stage)},at:performance.now()}), false)`,
      });
      points.push({ ...point, stage, file, lineNumber, columnNumber });
      if (!point.locations?.length || point.locations.some((location) =>
        location.lineNumber !== lineNumber || location.columnNumber < columnNumber
        || location.columnNumber >= columnNumber + marker.split('\n')[0].length)) {
        throw new Error(`vault-lock diagnostic location unresolved or moved: ${stage}`);
      }
    }
    return {
      read: async () => {
        const result = await worker.send('Runtime.evaluate', { expression: `globalThis.${key}`, returnByValue: true });
        return { clock: 'worker-performance-now', stages: result.result?.value ?? [], points };
      },
      remove,
    };
  } catch (cause) { await remove(); throw cause; }
};
