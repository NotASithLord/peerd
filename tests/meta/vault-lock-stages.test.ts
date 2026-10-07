import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { LOCK_STAGES, locateLockStage, armVaultLockStages } from '../../scripts/cdp/vault-lock-stages.mjs';

test('diagnostics resolve unique current-source stage positions with exact columns', async () => {
  for (const [file, marker] of LOCK_STAGES) {
    const source = await readFile(new URL(`../../extension/${file}`, import.meta.url), 'utf8');
    const { lineNumber, columnNumber } = locateLockStage(source, marker);
    expect(source.split('\n')[lineNumber]!.slice(columnNumber)).toStartWith(marker.split('\n')[0]!);
  }
  expect(locateLockStage('  call(() => stage())', 'stage()')).toEqual({ lineNumber: 0, columnNumber: 13 });
  expect(() => locateLockStage('missing', 'stage')).toThrow('unique');
  expect(() => locateLockStage('stage\nstage', 'stage')).toThrow('unique');
});

test('logpoints never pause and record only bounded stage labels and timestamps, then remove all instrumentation', async () => {
  const calls: { method: string; args: any }[] = [];
  const diagnostics = await armVaultLockStages({ sw: { id: 'fixture' }, swConn: {
    async send(method: string, args: any = {}) {
      calls.push({ method, args });
      if (method === 'Debugger.setBreakpointByUrl') return { breakpointId: String(calls.length), locations: [{ lineNumber: args.lineNumber, columnNumber: args.columnNumber }] };
      return { result: { value: [] } };
    },
  } });
  const points = calls.filter(c => c.method === 'Debugger.setBreakpointByUrl');
  expect(points).toHaveLength(LOCK_STAGES.length);
  for (const { args } of points) {
    const scope = { __peerdVaultLockStages: [] as any[] };
    const evaluate = new Function('globalThis', 'performance', `return ${args.condition}`);
    expect(evaluate(scope, { now: () => 42 })).toBe(false);
    expect(Object.keys(scope.__peerdVaultLockStages[0])).toEqual(['stage', 'at']);
    for (let n = 0; n < 70; n++) expect(evaluate(scope, { now: () => 42 })).toBe(false);
    expect(scope.__peerdVaultLockStages).toHaveLength(64);
  }
  await diagnostics.remove();
  expect(calls.filter(c => c.method === 'Debugger.removeBreakpoint')).toHaveLength(points.length);
  expect(calls.at(-1)!.method).toBe('Debugger.disable');
});
