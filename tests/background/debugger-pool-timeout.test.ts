import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

describe('debugger pool evaluate deadline', () => {
  const probe = (mode: string) => {
    const processResult = Bun.spawnSync([
      process.execPath,
      join(import.meta.dir, 'fixtures', 'debugger-pool-timeout-probe.ts'),
      mode,
    ]);
    const stdout = new TextDecoder().decode(processResult.stdout).trim().split('\n');
    const result = JSON.parse(stdout.at(-1) ?? '{}');

    expect(processResult.exitCode).toBe(0);
    return result;
  };

  test('marks a timed-out dispatched script as host-lost', () => {
    expect(probe('timeout').outcomeKind).toBe('host-lost');
  });

  test('marks debugger loss after dispatch as host-lost', () => {
    expect(probe('detach').outcomeKind).toBe('host-lost');
  });
});
