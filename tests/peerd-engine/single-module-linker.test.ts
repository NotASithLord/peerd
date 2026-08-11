import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { buildWorkerSource, NOTEBOOK_BUILTINS, SEAL_MODULE_URL } from '../../extension/engine-tabs/notebook-tab/worker-source.js';
import { linkSingleModuleWorker } from '../../extension/peerd-engine/single-module-linker.js';

const withFileFetch = async <T>(run: () => Promise<T>): Promise<T> => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith('file:')) {
      return new Response(await readFile(new URL(url)), {
        headers: { 'content-type': 'application/wasm' },
      });
    }
    return original(input, init);
  }) as typeof fetch;
  try { return await run(); }
  finally { globalThis.fetch = original; }
};

describe('single-module Notebook linker', () => {
  test('emits one seal-first worker module with local ESM semantics intact', async () => {
    const files: Record<string, string> = {
      'lib/value.js': `await Promise.resolve();
export let value = 40;
export const sourceUrl = import.meta.url;
export const add = (n) => { value += n; };`,
      'lib/index.js': "export { value, sourceUrl, add } from './value.js';",
      'side.js': "import { add } from './lib/index.js'; add(2); globalThis.sideOrder = ['side'];",
    };
    let sequence = 0;
    const built = await buildWorkerSource(`import './side.js';
import * as values from './lib/index.js';
await Promise.resolve();
return { value: values.value, order: globalThis.sideOrder };`, {
      notebookId: 'linker-test',
      resolverDeps: {
        readFile: async (path) => files[path],
        makeBlobUrl: () => `blob:peerd-test/${sequence += 1}`,
      },
    });
    const linked = await withFileFetch(() => linkSingleModuleWorker(
      built.source, built.cache, [SEAL_MODULE_URL, ...Object.values(NOTEBOOK_BUILTINS)],
    ));
    expect(linked.startsWith("'use strict';\n")).toBe(true);
    expect(linked).not.toContain(`import '${SEAL_MODULE_URL}'`);
    expect(linked).not.toContain('import.meta');
    expect(linked).toContain('"./lib/value.js"');
    expect(linked).toMatch(/\/\*__peerd_module:[0-9a-f-]+:module:.%2Flib%2Fvalue\.js__\*\//);
    expect(linked.indexOf('applyNotebookRealmSeal(globalThis)'))
      .toBeLessThan(linked.indexOf('let value = 40'));
    expect(linked).not.toContain('blob:peerd-test');
    expect(linked).toContain('value += n');
    expect(linked).toContain('await Promise.resolve()');
  });
});
