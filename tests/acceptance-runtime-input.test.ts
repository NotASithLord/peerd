import { test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acceptanceRuntimeInput } from '../scripts/cdp/acceptance-runtime-input.mjs';

test('explicit runtime selection refuses ambiguous inputs instead of packaging a fallback', () => {
  expect(acceptanceRuntimeInput([], '0.10.0')).toBeNull();
  for (const args of [['--extension='], ['--other=x'], ['--extension=a', '--extension=b']]) {
    expect(() => acceptanceRuntimeInput(args, '0.10.0')).toThrow();
  }
});
test('installed runtime must match the harness version and MV3 packaging', () => {
  const root = mkdtempSync(join(tmpdir(), 'runtime-input-'));
  try {
    const manifest = (version: string, manifest_version = 3) => writeFileSync(join(root, 'manifest.json'), JSON.stringify({ version, manifest_version }));
    manifest('0.10.0');
    expect(acceptanceRuntimeInput([`--extension=${root}`], '0.10.0')).toBe(root);
    expect(() => acceptanceRuntimeInput([`--extension=${root}`], '0.11.0')).toThrow('versions differ');
    manifest('0.10.0', 2);
    expect(() => acceptanceRuntimeInput([`--extension=${root}`], '0.10.0')).toThrow('MV3');
    const alias = `${root}-alias`;
    symlinkSync(root, alias);
    try { expect(() => acceptanceRuntimeInput([`--extension=${alias}`], '0.10.0')).toThrow('real directory'); }
    finally { rmSync(alias); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
