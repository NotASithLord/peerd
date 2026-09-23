import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EXTENSION_DIR } from '../../packaging/lib.ts';

// The service worker registers browser listeners at load. Check the local
// model dispatch order without importing the full worker.
const serviceWorker = readFileSync(join(EXTENSION_DIR, 'background/service-worker.js'), 'utf8');

describe('local model Stop wiring', () => {
  test('Stop during offscreen startup settles the stream before dispatch', () => {
    const start = serviceWorker.indexOf('const generateLocalForAdapter =');
    const end = serviceWorker.indexOf('setLocalGenerate(', start);
    const bridge = serviceWorker.slice(start, end);
    const abortStart = bridge.indexOf('const abortHostGeneration =');
    const abortEnd = bridge.indexOf('};', abortStart);
    const abort = bridge.slice(abortStart, abortEnd);
    const listener = bridge.indexOf("opts.signal.addEventListener('abort', abortHostGeneration", abortEnd);
    const preAborted = bridge.indexOf('if (opts.signal?.aborted) abortHostGeneration();', listener);
    const startup = bridge.indexOf('else ensureOffscreen()', preAborted);
    const postStartupCheck = bridge.indexOf('opts.signal?.aborted', startup);
    const settle = bridge.indexOf('abortHostGeneration()', postStartupCheck);
    const dispatch = bridge.indexOf("type: 'local-model/host/generate'", startup);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(abort).toContain('state.done = true;');
    expect(abort).toContain('wakeLocalGen(state);');
    expect(listener).toBeGreaterThan(abortEnd);
    expect(preAborted).toBeGreaterThan(listener);
    expect(startup).toBeGreaterThan(preAborted);
    expect(postStartupCheck).toBeGreaterThan(startup);
    expect(settle).toBeGreaterThan(postStartupCheck);
    expect(dispatch).toBeGreaterThan(settle);
  });
});
