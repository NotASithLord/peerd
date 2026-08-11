// The sealed-worker source template. The dynamic-import shim must short-circuit
// BUILTINS (peerd:std) to a native import of their real URL — the compose-module
// path reads OPFS, where a builtin has no file, so routing a builtin there
// throws "cannot resolve" (the field failure: peerd.self.import('peerd:std')).

import { describe, test, expect } from 'bun:test';
import { buildWorkerSource, mapWorkerError, NOTEBOOK_BUILTINS } from '../../../extension/engine-tabs/notebook-tab/worker-source.js';

const resolverDeps = {
  readFile: async () => { throw new Error('no OPFS in this test'); },
  makeBlobUrl: (source: string) => `blob:test/${source.length}`,
};

describe('buildWorkerSource — the builtin short-circuit in the dynamic shim', () => {
  test('the emitted worker source embeds the builtins map and checks it before the OPFS compose path', async () => {
    const { source } = await buildWorkerSource('return 1', { notebookId: 'nb-1', resolverDeps });
    // the map itself rides into the worker realm…
    expect(source).toContain(`const PEERD_BUILTINS = ${JSON.stringify(NOTEBOOK_BUILTINS)}`);
    // …and the shim consults it BEFORE calling out to compose-module
    const shimAt = source.indexOf('__peerd_dynamic_import = async');
    const checkAt = source.indexOf('hasOwnProperty.call(PEERD_BUILTINS', shimAt);
    const composeAt = source.indexOf("opfsCall('compose-module'", shimAt);
    expect(shimAt).toBeGreaterThan(-1);
    expect(checkAt).toBeGreaterThan(shimAt);
    expect(composeAt).toBeGreaterThan(checkAt);
  });
});

// Error line mapping: user line L sits at source line bodyLine + L - 1, so a
// stack frame in the entry blob maps back to <entryPath>:<L>. This is what
// turns "blob:chrome-extension://…:214:9" into "notebook.js:3:9" in the pane
// and in the agent's [ERROR] tool result.
describe('buildWorkerSource — bodyLine + mapWorkerError', () => {
  test('bodyLine is exactly the source line where the user code begins', async () => {
    const { source, bodyLine } = await buildWorkerSource('const A = 1;\nthrow new Error("x")', { notebookId: 'nb-1', resolverDeps });
    const lines = source.split('\n');
    expect(lines[bodyLine - 1]).toBe('const A = 1;');          // user line 1 at source line bodyLine
    expect(lines[bodyLine]).toBe('throw new Error("x")');     // user line 2 right after
  });

  test('an import keeps line positions (extraction leaves a blank line behind)', async () => {
    const code = "import { mean } from 'peerd:std';\nconst A = 1;\nmean([A]);";
    const { source, bodyLine } = await buildWorkerSource(code, { notebookId: 'nb-1', resolverDeps });
    const lines = source.split('\n');
    expect(lines[bodyLine - 1]).toBe('');                      // user line 1: the extracted import → blank
    expect(lines[bodyLine]).toBe('const A = 1;');              // user line 2 stays user line 2
    expect(lines[bodyLine + 1]).toBe('mean([A]);');
  });

  test('mapWorkerError rewrites entry-blob frames to entryPath:userLine and leaves others alone', () => {
    const blobUrl = 'blob:chrome-extension://abc/uuid-1';
    const raw = [
      'ReferenceError: nope is not defined',
      `    at ${blobUrl}:214:9`,                                // body frame → mapped
      `    at ${blobUrl}:12:1`,                                 // preamble frame (before body) → untouched
      '    at blob:chrome-extension://abc/other-module:7:3',    // another module → untouched
    ].join('\n');
    const out = mapWorkerError(raw, blobUrl, 213, 'notebook.js');
    expect(out).toContain('at notebook.js:2:9');
    expect(out).toContain(`at ${blobUrl}:12:1`);
    expect(out).toContain('at blob:chrome-extension://abc/other-module:7:3');
    expect(out).not.toContain(`${blobUrl}:214:9`);
  });

  test('mapWorkerError is a no-op on messages without the blob URL, and on non-strings', () => {
    expect(mapWorkerError('TypeError: plain message', 'blob:x/y', 10)).toBe('TypeError: plain message');
    expect(mapWorkerError(undefined, 'blob:x/y', 10)).toBe(undefined);
    expect(mapWorkerError('', 'blob:x/y', 10)).toBe('');
  });

  test('a $&-bearing body survives splicing verbatim (no string-replacement pattern damage)', async () => {
    const code = 'const s = "a$&b$1c"; return s;';
    const { source } = await buildWorkerSource(code, { notebookId: 'nb-1', resolverDeps });
    expect(source).toContain('const s = "a$&b$1c"; return s;');
  });
});

describe('buildWorkerSource — Pod JS profile', () => {
  test('uses the Pod seal and exposes only named command/workspace/fetch inputs', async () => {
    const { source } = await buildWorkerSource('console.log(args[0]); return stdin', {
      notebookId: 'pod-1', resolverDeps,
      caps: { page: false, egress: false, subagent: false, opfs: true, provider: false, distributed: false },
      podCommand: { args: ['x'], stdin: 'pipe', cwd: '/src', env: { MODE: 'test' } },
    });
    expect(source.split('\n')[0]).toContain('pod-realm-seal.js');
    expect(source).toContain('const args = Object.freeze(["x"])');
    expect(source).toContain('const stdin = "pipe"');
    expect(source).toContain('const cwd = "/src"');
    expect(source).toContain('fetch: __podFetch');
    expect(source).toContain('no-egress capability profile');
    expect(source).toContain('no-subagent capability profile');
    expect(source).toContain('no-distributed capability profile');
    expect(source).not.toContain("makeBridge('page'");
    expect(source).not.toContain("makeBridge('provider'");
  });
});
