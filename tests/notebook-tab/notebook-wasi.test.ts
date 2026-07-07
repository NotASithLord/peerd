// peerd:wasi — run wasm32-wasi command modules against caller-built
// capabilities. The wrapper is pure values-in/values-out (module bytes + opts
// → exit/stdout/files), so it's exercised directly in bun; the fixtures are
// hand-assembled wasm (wasi-test-module.ts), so the whole path — compile,
// link against the vendored shim, _start, exit — runs for real here.

import { describe, test, expect } from 'bun:test';
import {
  runWasi, buildFileTree, readFileTree, WasiRunError, demoModule,
} from '../../extension/notebook-tab/notebook-wasi.js';
import {
  buildHelloModule, buildEchoModule, buildFloodModule,
  buildEmptyModule, buildNonWasiModule,
} from './wasi-test-module.ts';

describe('runWasi', () => {
  test('runs a command module: stdout + exit code 0', async () => {
    const result = await runWasi(buildHelloModule('hello, wasi\n'));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello, wasi\n');
    expect(result.stderr).toBe('');
    expect(result.stdoutTruncated).toBe(false);
  });

  test('proc_exit code comes back as a value, not a throw', async () => {
    const result = await runWasi(buildHelloModule('failing\n', 3));
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe('failing\n');
  });

  test('stdin reaches fd 0 (echo module round-trips it)', async () => {
    const result = await runWasi(buildEchoModule(), { stdin: 'piped input' });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('piped input');
  });

  test('accepts a precompiled WebAssembly.Module', async () => {
    const compiled = await WebAssembly.compile(buildHelloModule('precompiled\n') as BufferSource);
    const result = await runWasi(compiled);
    expect(result.stdout).toBe('precompiled\n');
  });

  test('caps a runaway stdout and flags the truncation', async () => {
    // 200 × 4096 B ≈ 800 KiB attempted — must clamp at the 512 KiB cap.
    const result = await runWasi(buildFloodModule(200));
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout.length).toBe(512 * 1024);
    expect(result.stderrTruncated).toBe(false);
  });

  test('seed files come back in the result (unchanged tree round-trips)', async () => {
    const result = await runWasi(buildHelloModule('ok\n'), {
      files: { 'input.txt': 'seed data', 'data/nested.txt': 'deeper' },
    });
    expect(result.files['input.txt']).toBe('seed data');
    expect(result.files['data/nested.txt']).toBe('deeper');
  });

  test('refuses a module without _start (reactor / empty)', async () => {
    expect(runWasi(buildEmptyModule())).rejects.toThrow(WasiRunError);
    expect(runWasi(buildEmptyModule())).rejects.toThrow(/command module/);
  });

  test('refuses a module that wants non-WASI imports, with an actionable message', async () => {
    expect(runWasi(buildNonWasiModule())).rejects.toThrow(WasiRunError);
    expect(runWasi(buildNonWasiModule())).rejects.toThrow(/WASI preview1/);
  });

  test('rejects junk bytes at compile', async () => {
    expect(runWasi(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow();
  });

  test('the shim debug logger stays OFF (no per-syscall console spam)', async () => {
    // Upstream gotcha: the WASI ctor treats an omitted debug option as
    // enable(TRUE). The wrapper passes { debug: false }; a regression here
    // floods every Notebook run's captured console with "wasi:" lines.
    const original = console.log;
    const logged: unknown[][] = [];
    console.log = (...logArgs: unknown[]) => { logged.push(logArgs); };
    try {
      await runWasi(buildHelloModule('quiet\n'), { files: { 'f.txt': 'x' } });
    } finally {
      console.log = original;
    }
    expect(logged.filter((l) => l.some((a) => String(a).includes('wasi:'))).length).toBe(0);
  });
});

describe('buildFileTree / readFileTree', () => {
  test('nested paths round-trip through the tree', () => {
    const tree = buildFileTree({
      'a.txt': 'top',
      'dir/b.txt': 'mid',
      'dir/sub/c.txt': 'deep',
    });
    expect(readFileTree(tree)).toEqual({
      'a.txt': 'top',
      'dir/b.txt': 'mid',
      'dir/sub/c.txt': 'deep',
    });
  });

  test('binary (non-UTF-8) content stays Uint8Array on the way out', () => {
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x80]);
    const out = readFileTree(buildFileTree({ 'blob.bin': bytes }));
    expect(out['blob.bin']).toBeInstanceOf(Uint8Array);
    expect([...(out['blob.bin'] as Uint8Array)]).toEqual([0xff, 0xfe, 0x00, 0x80]);
  });

  test('a path through an existing FILE is a conflict, not silent nesting', () => {
    expect(() => buildFileTree({ 'x': 'file', 'x/y.txt': 'nested' })).toThrow(/conflict/);
  });

  test('empty path segments are rejected', () => {
    expect(() => buildFileTree({ '': 'nope' })).toThrow(TypeError);
  });
});

describe('demoModule — the embedded self-test fixture', () => {
  test('the embedded blob IS buildHelloModule("hello from wasi\\n") — blob and source cannot drift', () => {
    expect([...demoModule()]).toEqual([...buildHelloModule('hello from wasi\n')]);
  });

  test('runWasi(demoModule()) runs green: the agent-facing smoke test works', async () => {
    const result = await runWasi(demoModule());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello from wasi\n');
    expect(result.stderr).toBe('');
  });
});
