import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// notebook-client.js auto-creates a default Notebook on the first implicit-
// target call. Without serialization, two concurrent first-commands — the agent
// loop dispatches consecutive READ-class js tools (js_read_file, js_list_files)
// concurrently — both see "no default yet" and create TWO Notebooks; one is
// orphaned (leaked tab + OPFS scratch) and the reads target different scratch
// dirs. Every engine kind shares one resolver and lane for this.
//
// notebook-client imports the webextension-polyfill (not bun-importable), so
// assert against the SOURCE TEXT, like offscreen-gate.test.ts.
const src = readFileSync(
  join(import.meta.dir, '../../extension/background/notebook-client.js'),
  'utf8',
);

describe('notebook-client — implicit resolve is serialized per session', () => {
  // The lane itself is behaviour-tested in engine-instance-resolver.test.ts (engine-process.js)
  // (including a control proving the race is real without it). These pin that
  // notebook-client routes its implicit targets through that shared resolver.
  test('resolution is the shared engine resolver on the client keyed queue', () => {
    expect(src).toMatch(/createKeyedQueue/);
    expect(src).toMatch(/createEngineInstanceResolver\(\{\s*registry,\s*queue,/);
    expect(src).toMatch(/instances\.resolveQueued\(/);
  });
  test('every implicit-target method resolves through the queued lane, not the bare resolve', () => {
    // the bare resolveId(opts) must NOT be the method path (it would race)
    expect(src).not.toMatch(/const id = await resolveId\(opts\)/);
    const queued = src.match(/const id = await resolveIdQueued\(opts\)/g) || [];
    expect(queued.length).toBeGreaterThanOrEqual(4); // eval, writeFile, readFile, listFiles
  });
});

describe('notebook-client — re-inflates the OPFS not-found signal (edit_file 3a)', () => {
  // why: the tab flattens the NotFoundError DOMException to a message + a
  // 'not_found' code; the client must restore the NAME so edit_file can tell an
  // absent notebook file (a legit whole-file create) from a genuine read fault.
  test("a 'not_found' reply is rethrown as a NotFoundError-named Error", () => {
    expect(src).toMatch(/code === 'not_found'/);
    expect(src).toMatch(/err\.name = 'NotFoundError'/);
  });
});

describe('notebook-client: Stop reaches the exact Notebook run', () => {
  test('eval mints a run id and relays abort through js/abort', () => {
    expect(src).toMatch(/const runId = crypto\.randomUUID\(\)/);
    expect(src).toMatch(/type: 'js\/abort', notebookId, runId: message\.runId/);
    expect(src).toMatch(/opts\.signal/);
  });
});
