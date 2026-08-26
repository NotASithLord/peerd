import { afterEach, describe, expect, test } from 'bun:test';
import {
  cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONTROLLER_BUILD_ENTRIES,
  CONTROLLER_OPTIONAL_BUILD_ENTRIES,
  CONTROLLER_BUILD_STAMP_MODULES,
  controllerBuildDigest,
  writeControllerBuildIdentity,
} from '../../packaging/controller-build-identity.ts';
import { bundleChromeNativeKernel } from '../../packaging/bundle-chrome-native-kernel.ts';
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

  test('controller-only feature growth leaves normalized SW authority unchanged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'peerd-controller-feature-growth-'));
    roots.push(root);
    const baseline = join(root, 'baseline');
    const candidate = join(root, 'candidate');
    cpSync(join(process.cwd(), 'extension'), baseline, { recursive: true });
    cpSync(join(process.cwd(), 'extension'), candidate, { recursive: true });

    writeFileSync(join(candidate, 'peerd-runtime/controller-feature-fixture.js'), [
      '// Representative ordinary semantic feature: no authority imports or operations.',
      "export const CONTROLLER_FEATURE_FIXTURE = Object.freeze({ name: 'fixture' });",
      '',
    ].join('\n'));
    const turnRuntime = join(candidate, 'offscreen/controller-turn-runtime.js');
    writeFileSync(turnRuntime, [
      readFileSync(turnRuntime, 'utf8'),
      "import { CONTROLLER_FEATURE_FIXTURE } from '/peerd-runtime/controller-feature-fixture.js';",
      'void CONTROLLER_FEATURE_FIXTURE;',
      '',
    ].join('\n'));

    const baselineDigest = await writeControllerBuildIdentity(baseline);
    const candidateDigest = await writeControllerBuildIdentity(candidate);
    expect(candidateDigest).not.toBe(baselineDigest);

    // why: normalize the authored identity leaves before minification. Bun's
    // identifier allocation may change when a literal changes, even though no
    // authority source or input changed; the invariant intentionally excludes
    // that build-identity-only churn.
    for (const extension of [baseline, candidate]) {
      for (const name of CONTROLLER_BUILD_STAMP_MODULES) {
        const path = join(extension, 'shared', name);
        writeFileSync(path, readFileSync(path, 'utf8').replace(
          /(CONTROLLER_BUILD_DIGEST\s*=\s*['"])[a-f0-9]{64}(['"])/,
          `$1${'0'.repeat(64)}$2`,
        ));
      }
    }

    const baselineBundle = await bundleChromeNativeKernel(
      baseline, 'background/vault-kernel.js',
    );
    const candidateBundle = await bundleChromeNativeKernel(
      candidate, 'background/vault-kernel.js',
    );
    expect(candidateBundle.inputs).toEqual(baselineBundle.inputs);
    expect(candidateBundle.inputs).not.toContain('peerd-runtime/controller-feature-fixture.js');

    expect(readFileSync(join(candidate, 'background/vault-kernel.js'), 'utf8'))
      .toBe(readFileSync(join(baseline, 'background/vault-kernel.js'), 'utf8'));
  });

  test('binds the distributed custody protocol', async () => {
    for (const entry of [
      'offscreen/dweb-base.js',
      'offscreen/dweb-custody-host.js',
      'offscreen/dweb-transfer-host.js',
      'background/kernel-preview-addon.js',
    ]) expect(CONTROLLER_OPTIONAL_BUILD_ENTRIES).toContain(entry as any);
    const root = mkdtempSync(join(tmpdir(), 'peerd-dweb-runtime-digest-'));
    roots.push(root);
    const extension = join(root, 'extension');
    cpSync(join(process.cwd(), 'extension'), extension, { recursive: true });
    const before = await controllerBuildDigest(extension);
    const host = join(extension, 'offscreen/dweb-transfer-host.js');
    writeFileSync(host, `${readFileSync(host, 'utf8')}\n`);
    expect(await controllerBuildDigest(extension)).not.toBe(before);
  });
});
