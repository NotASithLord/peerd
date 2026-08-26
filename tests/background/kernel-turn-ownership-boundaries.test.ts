import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { collectStaticModuleGraph } from '../../packaging/static-module-graph.ts';

const REPO_ROOT = join(import.meta.dir, '../..');
const EXTENSION_ROOT = join(REPO_ROOT, 'extension');

const modulesFor = async (entry: string) => new Set(
  [...await collectStaticModuleGraph(EXTENSION_ROOT, join(EXTENSION_ROOT, entry))]
    .map((file) => relative(EXTENSION_ROOT, file).replaceAll('\\', '/')),
);

describe('kernel turn ownership boundaries', () => {
  it('keeps the semantic owner free of authority and host dependencies', async () => {
    const modules = await modulesFor('peerd-runtime/controller-turn-semantics.js');
    const forbiddenPrefixes = [
      'background/',
      'peerd-egress/vault/',
      'peerd-egress/storage/',
      'peerd-egress/credentials/',
      'peerd-egress/dpop/',
      'peerd-egress/fetch/origin-credentials.js',
    ];
    const forbiddenModules = new Set([
      'shared/browser-api.js',
      'peerd-provider/background.js',
      'peerd-engine/background.js',
      'peerd-runtime/composer/command-store.js',
      'peerd-runtime/site-clients/store.js',
      'peerd-runtime/skills/store.js',
      'peerd-runtime/toolbox/store.js',
      'peerd-runtime/tools/run-cache.js',
    ]);

    expect([...modules].filter((module) =>
      forbiddenModules.has(module)
        || forbiddenPrefixes.some((prefix) => module.startsWith(prefix)))).toEqual([]);
  });

  it('keeps the authority adapter free of feature catalogs and semantic owners', async () => {
    const modules = await modulesFor('background/kernel-turn-authority-adapter.js');
    const forbiddenPrefixes = [
      'peerd-provider/',
      'peerd-runtime/tools/defs/',
      'peerd-runtime/tools/metadata/',
    ];
    const forbiddenModules = new Set([
      'peerd-engine/app-manifest.js',
      'peerd-runtime/controller-turn-semantics.js',
      'peerd-runtime/controller-tools.js',
      'peerd-runtime/semantic.js',
      'peerd-runtime/site-clients/digest.js',
      'peerd-runtime/tools/registry.js',
    ]);

    expect([...modules].filter((module) =>
      forbiddenModules.has(module)
        || forbiddenPrefixes.some((prefix) => module.startsWith(prefix)))).toEqual([]);
  });

  it('composes one synchronous owner path without a protocol or dynamic fallback', () => {
    const source = readFileSync(
      join(EXTENSION_ROOT, 'background/kernel-turn-live-factories.js'),
      'utf8',
    );
    expect(source).toContain('createControllerTurnSemantics()');
    expect(source).toContain('createKernelTurnAuthorityAdapter(deps,');
    expect(source).not.toContain('import(');
    expect(source).not.toMatch(/\b(operation|action)\s*,\s*payload\b/);
  });
});
