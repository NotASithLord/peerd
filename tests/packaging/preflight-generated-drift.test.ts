import { describe, expect, test } from 'bun:test';
import { generatedFilesDifferFromHead } from '../../packaging/preflight.ts';

describe('preflight generated-file drift batching', () => {
  test('checks every generated path in one Git process', () => {
    const calls: any[][] = [];
    const runner = ((...args: any[]) => { calls.push(args); return Buffer.alloc(0); }) as any;
    expect(generatedFilesDifferFromHead('/repo', ['/repo/a', '/repo/b'], runner)).toBe(false);
    expect(calls).toEqual([[
      'git',
      ['diff', '--quiet', '--exit-code', 'HEAD', '--', '/repo/a', '/repo/b'],
      { cwd: '/repo', stdio: 'ignore' },
    ]]);
  });

  test('keeps both ordinary drift and Git failures fail-closed', () => {
    for (const status of [1, 128]) {
      let calls = 0;
      const runner = (() => {
        calls += 1;
        throw Object.assign(new Error('git failed'), { status });
      }) as any;
      expect(generatedFilesDifferFromHead('/repo', ['/repo/a'], runner)).toBe(true);
      expect(calls).toBe(1);
    }
  });

  test('an empty generated set preserves the old no-drift, no-process result', () => {
    const runner = (() => { throw new Error('must not run'); }) as any;
    expect(generatedFilesDifferFromHead('/repo', [], runner)).toBe(false);
  });
});
