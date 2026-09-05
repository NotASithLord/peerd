import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EXTENSION_DIR } from '../../packaging/lib.ts';
import { loadStagedModuleResolver } from '../../packaging/verify-store-artifact.ts';

describe('Store artifact executable policy verification', () => {
  test('isolates browser-root imports for each staged artifact', async () => {
    const first = mkdtempSync(join(tmpdir(), 'peerd-store-verifier-first-'));
    const second = mkdtempSync(join(tmpdir(), 'peerd-store-verifier-second-'));
    try {
      for (const scratchRoot of [first, second]) {
        const resolver = await loadStagedModuleResolver(EXTENSION_DIR, scratchRoot);
        await expect(resolver.buildEntry(
          "import 'https://reachable.test/module.js';",
          'entry.js',
          {
            remoteModulesEnabled: false,
            readFile: async () => '',
            makeBlobUrl: () => 'blob:store-verifier',
          },
        )).rejects.toMatchObject({ code: 'remote_module_imports_unavailable' });
      }
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });
});
