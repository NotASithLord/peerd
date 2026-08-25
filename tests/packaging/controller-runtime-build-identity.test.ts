import { afterEach, describe, expect, test } from 'bun:test';
import {
  cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTROLLER_BUILD_ENTRIES,
  controllerBuildDigest,
} from '../../packaging/controller-build-identity.ts';
import { PACKAGED_LAZY_MODULE_ENTRIES } from '../../packaging/lazy-entry-manifest.ts';
import { collectStaticModuleGraph } from '../../packaging/static-module-graph.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('controller runtime build identity', () => {
  test('binds the fixed runtime host and its rich relay graph', async () => {
    expect(CONTROLLER_BUILD_ENTRIES).toContain('offscreen/kernel-runtime-host.js');
    expect(PACKAGED_LAZY_MODULE_ENTRIES).toContain('offscreen/kernel-runtime-host.js');
    const graph = await collectStaticModuleGraph(
      join(process.cwd(), 'extension'),
      join(process.cwd(), 'extension/offscreen/kernel-runtime-host.js'),
    );
    expect([...graph].some((path) => path.endsWith('/offscreen/kernel-rich-relay-host.js')))
      .toBe(true);
  });

  test('changes when the rich relay host changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'peerd-controller-runtime-digest-'));
    roots.push(root);
    const extension = join(root, 'extension');
    cpSync(join(process.cwd(), 'extension'), extension, { recursive: true });
    const before = await controllerBuildDigest(extension);
    const relay = join(extension, 'offscreen/kernel-rich-relay-host.js');
    writeFileSync(relay, `${readFileSync(relay, 'utf8')}\n`);
    expect(await controllerBuildDigest(extension)).not.toBe(before);
  });
});
