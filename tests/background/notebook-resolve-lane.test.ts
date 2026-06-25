import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// notebook-client.js auto-creates a default Notebook on the first implicit-
// target call. Without serialization, two concurrent first-commands — the agent
// loop dispatches consecutive READ-class js tools (js_read_file, js_list_files)
// concurrently — both see "no default yet" and create TWO Notebooks; one is
// orphaned (leaked tab + OPFS scratch) and the reads target different scratch
// dirs. The fix mirrors vm-client.js's per-session resolve lane.
//
// notebook-client imports the webextension-polyfill (not bun-importable), so
// assert against the SOURCE TEXT, like offscreen-gate.test.ts. The lane
// PRIMITIVE (createKeyedQueue) is behavior-tested in command-queue.test.ts;
// these pin that notebook-client actually routes implicit resolution through it.
const src = readFileSync(
  join(import.meta.dir, '../../extension/background/notebook-client.js'),
  'utf8',
);

describe('notebook-client — implicit resolve is serialized per session', () => {
  test('lazy default-resolution runs behind a resolve:<sessionId> queue lane', () => {
    expect(src).toMatch(/createKeyedQueue/);
    expect(src).toMatch(/queue\.enqueue\(`resolve:\$\{opts\.sessionId\}`/);
  });
  test('every implicit-target method resolves through the queued lane, not the bare resolve', () => {
    // the bare resolveId(opts) must NOT be the method path (it would race)
    expect(src).not.toMatch(/const id = await resolveId\(opts\)/);
    const queued = src.match(/const id = await resolveIdQueued\(opts\)/g) || [];
    expect(queued.length).toBeGreaterThanOrEqual(4); // eval, writeFile, readFile, listFiles
  });
});
