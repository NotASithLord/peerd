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
      '// Representative ordinary semantic feature using the existing local authority class.',
      "export const CONTROLLER_FEATURE_TOOL_NAME = 'fixture_feature';",
      'export const CONTROLLER_FEATURE_TOOL_POLICY = Object.freeze({',
      '  name: CONTROLLER_FEATURE_TOOL_NAME,',
      "  primitive: 'local', sideEffect: false, retryClass: 'A',",
      "  description: 'Return a controller-owned semantic projection.',",
      "  schema: Object.freeze({ type: 'object', properties: Object.freeze({}), additionalProperties: false }),",
      '});',
      'export const executeControllerFeatureTool = async () => ({',
      "  ok: true, content: 'controller-only feature',",
      '});',
      '',
    ].join('\n'));
    const localTools = join(candidate, 'peerd-runtime/controller-local-tools.js');
    writeFileSync(localTools, readFileSync(localTools, 'utf8')
      .replace("import { executeNow } from './clock/execute.js';", [
        "import { executeNow } from './clock/execute.js';",
        'import {',
        '  CONTROLLER_FEATURE_TOOL_NAME, executeControllerFeatureTool,',
        "} from './controller-feature-fixture.js';",
      ].join('\n'))
      .replace(
        "Object.freeze(['now', 'complete_goal'])",
        "Object.freeze(['now', 'complete_goal', CONTROLLER_FEATURE_TOOL_NAME])",
      )
      .replace(
        "  if (name === 'now') return executeNow();",
        [
          "  if (name === 'now') return executeNow();",
          '  if (name === CONTROLLER_FEATURE_TOOL_NAME) return executeControllerFeatureTool();',
        ].join('\n'),
      ));
    const projection = join(candidate, 'peerd-runtime/controller-tool-projection.js');
    writeFileSync(projection, readFileSync(projection, 'utf8')
      .replace("import { listToolAuthorities } from './tools/metadata/authority.js';", [
        "import { listToolAuthorities } from './tools/metadata/authority.js';",
        "import { CONTROLLER_FEATURE_TOOL_POLICY } from './controller-feature-fixture.js';",
      ].join('\n'))
      .replace(
        'const descriptors = Object.freeze(listToolAuthorities().map(toToolDescriptor));',
        'const descriptors = Object.freeze([...listToolAuthorities(), CONTROLLER_FEATURE_TOOL_POLICY].map(toToolDescriptor));',
      ));

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
      baseline, 'background/vault-kernel-chrome.js',
    );
    const candidateBundle = await bundleChromeNativeKernel(
      candidate, 'background/vault-kernel-chrome.js',
    );
    expect(candidateBundle.inputs).toEqual(baselineBundle.inputs);
    expect(candidateBundle.bytes).toBe(baselineBundle.bytes);
    expect(candidateBundle.inputs).not.toContain('peerd-runtime/controller-feature-fixture.js');

    const controllerGraph = await collectStaticModuleGraph(
      candidate, join(candidate, 'offscreen/controller-turn-runtime.js'),
    );
    expect([...controllerGraph].some((path) =>
      path.endsWith('/peerd-runtime/controller-feature-fixture.js'))).toBe(true);

    const fixture = readFileSync(
      join(candidate, 'peerd-runtime/controller-feature-fixture.js'), 'utf8',
    );
    expect(fixture).toContain("name: CONTROLLER_FEATURE_TOOL_NAME");
    expect(fixture).toContain("schema: Object.freeze");
    expect(fixture).toContain('executeControllerFeatureTool');

    expect(readFileSync(join(candidate, 'background/vault-kernel.js'), 'utf8'))
      .toBe(readFileSync(join(baseline, 'background/vault-kernel.js'), 'utf8'));
  });

  test('representative actor and lifecycle growth remains controller-only', async () => {
    const root = mkdtempSync(join(tmpdir(), 'peerd-controller-owner-growth-'));
    roots.push(root);
    const baseline = join(root, 'baseline');
    const candidate = join(root, 'candidate');
    cpSync(join(process.cwd(), 'extension'), baseline, { recursive: true });
    cpSync(join(process.cwd(), 'extension'), candidate, { recursive: true });

    writeFileSync(join(candidate, 'peerd-runtime/controller-actor-growth-fixture.js'),
      "export const ACTOR_GROWTH_FIXTURE = Object.freeze({ actorType: 'web' });\n");
    const actorTools = join(candidate, 'peerd-runtime/controller-actor-tools.js');
    writeFileSync(actorTools, [
      "import { ACTOR_GROWTH_FIXTURE } from './controller-actor-growth-fixture.js';",
      readFileSync(actorTools, 'utf8'),
      'export const __actorGrowthFixture = ACTOR_GROWTH_FIXTURE;',
      '',
    ].join('\n'));

    writeFileSync(join(candidate, 'offscreen/controller-lifecycle-growth-fixture.js'),
      "export const LIFECYCLE_GROWTH_FIXTURE = Object.freeze({ phase: 'settled' });\n");
    const turnRuntime = join(candidate, 'offscreen/controller-turn-runtime.js');
    writeFileSync(turnRuntime, [
      "import { LIFECYCLE_GROWTH_FIXTURE } from './controller-lifecycle-growth-fixture.js';",
      readFileSync(turnRuntime, 'utf8'),
      'export const __lifecycleGrowthFixture = LIFECYCLE_GROWTH_FIXTURE;',
      '',
    ].join('\n'));

    const baselineDigest = await writeControllerBuildIdentity(baseline);
    const candidateDigest = await writeControllerBuildIdentity(candidate);
    expect(candidateDigest).not.toBe(baselineDigest);
    for (const extension of [baseline, candidate]) {
      for (const name of CONTROLLER_BUILD_STAMP_MODULES) {
        const path = join(extension, 'shared', name);
        writeFileSync(path, readFileSync(path, 'utf8').replace(
          /(CONTROLLER_BUILD_DIGEST\s*=\s*['"])[a-f0-9]{64}(['"])/,
          `$1${'0'.repeat(64)}$2`,
        ));
      }
    }

    const entry = 'background/vault-kernel-chrome.js';
    const baselineBundle = await bundleChromeNativeKernel(baseline, entry);
    const candidateBundle = await bundleChromeNativeKernel(candidate, entry);
    expect(candidateBundle.inputs).toEqual(baselineBundle.inputs);
    expect(candidateBundle.inputSha256).toBe(baselineBundle.inputSha256);
    expect(candidateBundle.bytes).toBe(baselineBundle.bytes);
    for (const fixture of [
      'peerd-runtime/controller-actor-growth-fixture.js',
      'offscreen/controller-lifecycle-growth-fixture.js',
    ]) expect(candidateBundle.inputs).not.toContain(fixture);

    const controllerGraph = await collectStaticModuleGraph(
      candidate, join(candidate, 'offscreen/controller-turn-runtime.js'),
    );
    expect([...controllerGraph].some((path) =>
      path.endsWith('/peerd-runtime/controller-actor-growth-fixture.js'))).toBe(true);
    expect([...controllerGraph].some((path) =>
      path.endsWith('/offscreen/controller-lifecycle-growth-fixture.js'))).toBe(true);
  });

  test('binds the distributed custody protocol', async () => {
    for (const entry of [
      'offscreen/dweb-base.js',
      'offscreen/dweb-custody-host.js',
      'offscreen/dweb-transfer-host.js',
      'background/kernel-preview-addon.js',
      'background/vault-kernel-firefox-preview.js',
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
