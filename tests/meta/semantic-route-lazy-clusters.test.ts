import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
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
import { SEMANTIC_HOST_ROUTE_MANIFEST } from '../../extension/shared/semantic-host-route-manifest.js';

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
    expect([...modules].some((file) => file.startsWith('offscreen/semantic-routes/')))
      .toBe(false);
  });

  test('compact host admission has one exact row per executable host route', () => {
    const routes = SEMANTIC_HOST_ROUTE_MANIFEST.map((row) => row.route);
    expect(routes).toHaveLength(18);
    expect(new Set(routes).size).toBe(routes.length);
    expect(SEMANTIC_HOST_ROUTE_MANIFEST.every((row) =>
      Object.keys(row).sort().join(',') === 'channels,route,source')).toBe(true);
  });

  test('the Store host projects out Preview-only semantic routes', () => {
    const storeRows = SEMANTIC_HOST_ROUTE_MANIFEST.filter(
      (row) => row.channels.includes('store'),
    );
    expect(storeRows.some((row) => row.route.startsWith('contributor/'))).toBe(false);
    expect(storeRows.some((row) => row.route === 'apps/open')).toBe(true);
    const template = readFileSync(
      join(process.cwd(), 'packaging/templates/semantic-route-host.store.js'), 'utf8',
    );
    expect(template).toContain("row.channels.includes('store')");
    expect(template).toContain('manifest: storeManifest');
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
