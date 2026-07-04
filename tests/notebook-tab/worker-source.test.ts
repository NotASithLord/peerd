// The sealed-worker source template. The dynamic-import shim must short-circuit
// BUILTINS (peerd:std) to a native import of their real URL — the compose-module
// path reads OPFS, where a builtin has no file, so routing a builtin there
// throws "cannot resolve" (the field failure: peerd.self.import('peerd:std')).

import { describe, test, expect } from 'bun:test';
import { buildWorkerSource, NOTEBOOK_BUILTINS } from '../../extension/notebook-tab/worker-source.js';

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
