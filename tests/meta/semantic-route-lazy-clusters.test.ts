import { describe, expect, test } from 'bun:test';
import { relative, join } from 'node:path';
import { EXTENSION_DIR } from '../../packaging/lib.ts';
import { collectStaticModuleGraph } from '../../packaging/static-module-graph.ts';
import {
  CONTROLLER_BUILD_ENTRIES, CONTROLLER_OPTIONAL_BUILD_ENTRIES,
} from '../../packaging/controller-build-identity.ts';
import { PACKAGED_LAZY_MODULE_ENTRIES } from '../../packaging/lazy-entry-manifest.ts';
import {
  SEMANTIC_HOST_BUILD_ENTRIES,
  SEMANTIC_HOST_CLUSTER_ENTRIES,
} from '../../packaging/semantic-host-entries.ts';
import {
  SEMANTIC_ROUTE_CLASSIFICATIONS,
  SEMANTIC_ROUTE_CUTOVER,
} from '../../extension/shared/semantic-route-classification.js';
import { SEMANTIC_HOST_ROUTE_CLASSIFICATIONS } from '../../extension/shared/semantic-host-route-manifest.js';
import { SEMANTIC_CUTOVER_SUMMARY } from '../../extension/background/vault-kernel-assembly.js';

const modulesFor = async (entry: string) => {
  const absolute = join(EXTENSION_DIR, entry);
  const graph = await collectStaticModuleGraph(EXTENSION_DIR, absolute);
  return new Set([...graph].map((file) => relative(EXTENSION_DIR, file).split('\\').join('/')));
};

describe('digest-bound lazy semantic route clusters', () => {
  test('dispatcher shell does not evaluate any route family on first load', async () => {
    const modules = await modulesFor('offscreen/semantic-route-host.js');
    expect(modules.has('background/routes/actor-overview.js')).toBe(false);
    expect(modules.has('background/routes/contacts.js')).toBe(false);
    expect(modules.has('peerd-provider/background.js')).toBe(false);
    expect(modules.has('background/routes/toolbox.js')).toBe(false);
    expect([...modules].some((file) => file.startsWith('offscreen/semantic-routes/')))
      .toBe(false);
    expect(modules.has('shared/semantic-route-inventory.generated.js')).toBe(false);
    expect(modules.has('shared/semantic-route-classification.js')).toBe(false);
  });

  test('compact host admission is exactly the migrated non-kernel ledger', () => {
    const expected = SEMANTIC_ROUTE_CLASSIFICATIONS.filter((row) =>
      row.state === 'migrated' && row.placement !== 'kernel');
    expect(JSON.parse(JSON.stringify(SEMANTIC_HOST_ROUTE_CLASSIFICATIONS)))
      .toEqual(expected);
  });

  test('cold summary is an exact projection of the full route ledger', () => {
    const kernel = SEMANTIC_ROUTE_CLASSIFICATIONS.filter((row) => row.placement === 'kernel');
    const split = SEMANTIC_ROUTE_CLASSIFICATIONS.filter((row) => row.placement === 'split');
    const migrated = SEMANTIC_ROUTE_CLASSIFICATIONS.filter((row) => row.state === 'migrated');
    const executable = migrated.map((row) => row.route);
    expect(JSON.parse(JSON.stringify(SEMANTIC_CUTOVER_SUMMARY))).toEqual({
      schema: 2,
      total: SEMANTIC_ROUTE_CLASSIFICATIONS.length,
      kernel: kernel.length,
      split: split.length,
      migrated: migrated.length,
      unmigrated: SEMANTIC_ROUTE_CLASSIFICATIONS.length - migrated.length,
      executable: executable.length,
      unavailable: SEMANTIC_ROUTE_CLASSIFICATIONS.length - executable.length,
      ready: SEMANTIC_ROUTE_CUTOVER.ready,
    });
    expect(new Set(executable).size).toBe(executable.length);
    for (const route of executable) {
      const row = SEMANTIC_ROUTE_CLASSIFICATIONS.find((entry) => entry.route === route);
      expect(row, route).toMatchObject({ route, state: 'migrated' });
      if (row?.placement === 'split') {
        expect(SEMANTIC_HOST_ROUTE_CLASSIFICATIONS.some((entry) => entry.route === route), route)
          .toBe(true);
      } else {
        expect(row?.placement, route).toBe('kernel');
      }
    }
  });

  test('each literal cluster reaches only its own route family', async () => {
    const expected: Record<string, string> = {
      actors: 'offscreen/semantic-routes/actors.js',
      apps: 'peerd-engine/app-manifest.js',
      contacts: 'background/routes/contacts.js',
      contributor: 'peerd-runtime/observability/contributor-store.js',
      memory: 'offscreen/semantic-routes/memory.js',
      providers: 'peerd-provider/metadata.js',
    };
    for (const [cluster, ownRoute] of Object.entries(expected)) {
      const entry = `offscreen/semantic-routes/${cluster}.js`;
      const modules = await modulesFor(entry);
      expect(modules.has(ownRoute), entry).toBe(true);
      for (const other of Object.values(expected).filter((route) => route !== ownRoute)) {
        expect(modules.has(other), `${entry} -> ${other}`).toBe(false);
      }
      expect([
        ...CONTROLLER_BUILD_ENTRIES, ...CONTROLLER_OPTIONAL_BUILD_ENTRIES,
      ]).toContain(entry as any);
      expect(PACKAGED_LAZY_MODULE_ENTRIES).toContain(entry as any);
    }
    expect(JSON.parse(JSON.stringify(SEMANTIC_HOST_CLUSTER_ENTRIES))).toEqual(
      Object.keys(expected).map((cluster) => `offscreen/semantic-routes/${cluster}.js`),
    );
    expect(SEMANTIC_HOST_BUILD_ENTRIES).toEqual([
      'offscreen/semantic-route-host.js', ...SEMANTIC_HOST_CLUSTER_ENTRIES,
    ]);
  });
});
