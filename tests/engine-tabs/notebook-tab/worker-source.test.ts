// The sealed-worker source template. peerd.self.import remains as a compatibility
// relay, but the host refuses it with the stable unsupported-import policy.

import { describe, test, expect } from 'bun:test';
import { buildWorkerSource, mapWorkerError } from '../../../extension/engine-tabs/notebook-tab/worker-source.js';
import { buildCodeClientSource } from '../../../extension/peerd-runtime/actor/capability-manifest.js';

const resolverDeps = {
  readFile: async () => { throw new Error('no OPFS in this test'); },
  makeBlobUrl: (source: string) => `blob:test/${source.length}`,
};

describe('buildWorkerSource dynamic import compatibility relay', () => {
  test('peerd.self.import always routes to the host policy boundary', async () => {
    const { source } = await buildWorkerSource('return 1', { notebookId: 'nb-1', resolverDeps });
    const shimAt = source.indexOf('__peerd_dynamic_import = async');
    const composeAt = source.indexOf("opfsCall('compose-module'", shimAt);
    expect(shimAt).toBeGreaterThan(-1);
    expect(composeAt).toBeGreaterThan(shimAt);
    expect(source.slice(shimAt, composeAt)).not.toContain('PEERD_BUILTINS');
  });

  test('bridge error codes stay local and final payloads claim no policy provenance', async () => {
    const { source } = await buildWorkerSource('return 1', { notebookId: 'nb-1', resolverDeps });
    expect(source).toContain('if (m.errorCode) error.code = m.errorCode');
    expect(source).not.toContain('errorCode: err?.code');
  });
});

describe('buildWorkerSource generated code clients', () => {
  test('the assembled worker exposes only canonical actor and mesh method names', async () => {
    const { source } = await buildWorkerSource('return 1', {
      notebookId: 'job-1', resolverDeps, actors: true, a2a: true,
      clientSources: {
        actors: buildCodeClientSource('actors'),
        mesh: buildCodeClientSource('mesh'),
      },
    });
    expect(source).toContain("call: (address, message, options) => actorsCall('call'");
    expect(source).toContain("cast: (did, message) => meshCall('cast'");
    expect(source).not.toContain("ask:  (address");
    expect(source).not.toContain("ask:         (did");
    expect(source).not.toContain("send:        (did");
  });

  test('enabled actor clients cannot fall back to a second hand-written API', async () => {
    await expect(buildWorkerSource('return 1', {
      notebookId: 'job-1', resolverDeps, actors: true,
    })).rejects.toThrow('actors worker client source is required');
    await expect(buildWorkerSource('return 1', {
      notebookId: 'job-1', resolverDeps, a2a: true,
    })).rejects.toThrow('mesh worker client source is required');
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

  test('mapWorkerError rewrites entry and imported-module blob frames to source paths', () => {
    const blobUrl = 'blob:chrome-extension://abc/uuid-1';
    const raw = [
      'ReferenceError: nope is not defined',
      `    at ${blobUrl}:214:9`,                                // body frame → mapped
      `    at ${blobUrl}:12:1`,                                 // preamble frame (before body) → untouched
      '    at blob:chrome-extension://abc/other-module:7:3',    // another module → untouched
    ].join('\n');
    const out = mapWorkerError(raw, blobUrl, 213, 'notebook.js', new Map([
      ['lib/failure.js', { blobUrl: 'blob:chrome-extension://abc/other-module' }],
    ]));
    expect(out).toContain('at notebook.js:2:9');
    expect(out).toContain(`at ${blobUrl}:12:1`);
    expect(out).toContain('at ./lib/failure.js:7:3');
    expect(out).not.toContain('blob:chrome-extension://abc/other-module');
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

describe('buildWorkerSource: Pod JS profile', () => {
  test('uses the Pod seal and exposes only named command/workspace inputs', async () => {
    const { source } = await buildWorkerSource('console.log(args[0]); return stdin', {
      notebookId: 'pod-1', resolverDeps,
      caps: { page: false, egress: false, subagent: false, opfs: true, provider: false, distributed: false },
      podCommand: { args: ['x'], stdin: 'pipe', cwd: '/src', env: { MODE: 'test' } },
    });
    expect(source.split('\n')[0]).toContain('pod-realm-seal.js');
    expect(source).toContain('const args = Object.freeze(["x"])');
    expect(source).toContain('const stdin = "pipe"');
    expect(source).toContain('const cwd = "/src"');
    expect(source).not.toContain('fetch: __podFetch');
    expect(source).toContain('Network access stays in the explicit shell curl command');
    expect(source).toContain('no-egress capability profile');
    expect(source).toContain('no-subagent capability profile');
    expect(source).toContain('no-distributed capability profile');
    expect(source).not.toContain("makeBridge('page'");
    expect(source).not.toContain("makeBridge('provider'");
  });
});
