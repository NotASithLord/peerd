import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

// Regression guard for the unkernel WebVM runtime contract in vm-tab.js.
describe('vm-tab unkernel contract', () => {
  const src = readFileSync('extension/engine-tabs/vm-tab/vm-tab.js', 'utf8');

  test('loads the vendored unkernel web entry and gzipped kernel bundle', () => {
    expect(src).toContain("import('/vendor/unkernel/web.mjs')");
    expect(src).toContain('vendor/unkernel/unkernel.wasm.gz');
    expect(src).not.toMatch(/cheerpx|disks\.webvm\.io/i);
  });

  test('keeps direct guest networking disabled in createKernel (egress stays bridged)', () => {
    const createCall = src.slice(src.indexOf('await createKernel({'), src.indexOf('await createKernel({') + 500);
    expect(createCall).toContain('kernel: kernelModule');
    expect(createCall).toContain('distro: distroDisk');
    expect(createCall).toContain('disks: [dataDisk]');
    expect(createCall).toContain("'/peerd-data': { fs: peerdDataFs, readOnly: true }");
    expect(createCall).not.toMatch(/\bnet\s*:/);
  });

  test('disables automatic apt command-not-found hooks and targets aarch64 wheels', () => {
    expect(src).toContain("KW_AUTO_APT: '0'");
    expect(src).toContain('PEERD_PYTAGS=\'"aarch64"');
  });
});
