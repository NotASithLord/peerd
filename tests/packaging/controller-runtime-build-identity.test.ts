import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CONTROLLER_BUILD_ENTRIES,
  CONTROLLER_OPTIONAL_BUILD_ENTRIES,
  CONTROLLER_BUILD_STAMP_MODULES,
  controllerBuildDigest,
  writeControllerBuildIdentity,
} from '../../packaging/controller-build-identity.ts';
import { minifyColdArtifactModules } from '../../packaging/minify-artifact-js.ts';
import { packageArtifact } from '../../packaging/package.ts';
import { PACKAGED_LAZY_MODULE_ENTRIES } from '../../packaging/lazy-entry-manifest.ts';
import { collectStaticModuleGraph } from '../../packaging/static-module-graph.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const normalizeControllerBuildIdentity = (extension: string) => {
  for (const name of CONTROLLER_BUILD_STAMP_MODULES) {
    const path = join(extension, 'shared', name);
    writeFileSync(path, readFileSync(path, 'utf8').replace(
      /(CONTROLLER_BUILD_DIGEST\s*=\s*['"])[a-f0-9]{64}(['"])/,
      `$1${'0'.repeat(64)}$2`,
    ));
  }
};

const authorityGraphFingerprint = async (extension: string, entry: string) => {
  const graph = await collectStaticModuleGraph(extension, join(extension, entry));
  const inputs = [...graph].map((path) => path.slice(extension.length + 1)
    .split('\\').join('/')).sort();
  const sources = inputs.map((input) => readFileSync(join(extension, input), 'utf8'));
  return Object.freeze({
    inputs: Object.freeze(inputs),
    bytes: sources.reduce((total, source) => total + Buffer.byteLength(source), 0),
    inputSha256: createHash('sha256').update(inputs.map((input, index) =>
      `input\0${input}\0${sources[index]}\0`).join('')).digest('hex'),
  });
};

const copyPackageSource = (target: string, extension: string) => {
  mkdirSync(join(target, 'packaging'), { recursive: true });
  cpSync(extension, join(target, 'extension'), { recursive: true });
  cpSync(join(process.cwd(), 'manifests'), join(target, 'manifests'), { recursive: true });
  cpSync(
    join(process.cwd(), 'packaging/default-settings.mjs'),
    join(target, 'packaging/default-settings.mjs'),
  );
};

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

  test('binds representative compose, lease, actor, voice, and contributor demand hosts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'peerd-controller-demand-digest-'));
    roots.push(root);
    const extension = join(root, 'extension');
    cpSync(join(process.cwd(), 'extension'), extension, { recursive: true });
    let prior = await controllerBuildDigest(extension);
    for (const entry of [
      'offscreen/controller-compose-runtime.js',
      'offscreen/supervisor-channels.js',
      'offscreen/actor-runner.js',
      'offscreen/voice-channel-host.js',
      'offscreen/contributor-channel-addon.js',
    ]) {
      const path = join(extension, entry);
      writeFileSync(path, `${readFileSync(path, 'utf8')}\n`);
      const next = await controllerBuildDigest(extension);
      expect(next, entry).not.toBe(prior);
      prior = next;
    }
  });

  test('controller-only feature growth leaves every normalized SW authority target unchanged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'peerd-controller-feature-growth-'));
    roots.push(root);
    const baseline = join(root, 'baseline');
    const candidate = join(root, 'candidate');
    cpSync(join(process.cwd(), 'extension'), baseline, { recursive: true });
    cpSync(join(process.cwd(), 'extension'), candidate, { recursive: true });

    writeFileSync(join(candidate, 'peerd-runtime/controller-feature-fixture.js'), [
      '// Representative catalog-registered semantic feature reusing one exact read authority.',
      "export const CONTROLLER_FEATURE_TOOL_NAME = 'fixture_feature';",
      'export const controllerFeatureTool = Object.freeze({',
      '  execute: async (_args, ctx) => {',
      '    const posture = await ctx.introspectionAuthority.readProviderPosture();',
      "    return { ok: true, content: `provider:${posture.provider}` };",
      '  },',
      '});',
      '',
    ].join('\n'));
    const catalog = join(candidate, 'peerd-runtime/tools/metadata/catalog.js');
    writeFileSync(catalog, readFileSync(catalog, 'utf8')
      .replace('export const TOOL_METADATA_RECORDS = {', [
        'export const TOOL_METADATA_RECORDS = {',
        '  "fixture_feature": {',
        '    "name": "fixture_feature",',
        '    "primitive": "inspect",',
        '    "description": "Read the active provider through a controller-owned semantic view.",',
        '    "schema": { "type": "object", "properties": {}, "additionalProperties": false },',
        '    "sideEffect": "read",',
        '    "originRule": { "kind": "none" }',
        '  },',
      ].join('\n')));
    const introspectionTools = join(
      candidate, 'peerd-runtime/controller-introspection-tools.js',
    );
    writeFileSync(introspectionTools, readFileSync(introspectionTools, 'utf8')
      .replace("import { loadSkillTool } from './skills/load-skill-tool.js';", [
        "import { loadSkillTool } from './skills/load-skill-tool.js';",
        'import {',
        '  CONTROLLER_FEATURE_TOOL_NAME, controllerFeatureTool,',
        "} from './controller-feature-fixture.js';",
      ].join('\n'))
      .replace(
        'const tools = Object.freeze({',
        'const tools = Object.freeze({\n  [CONTROLLER_FEATURE_TOOL_NAME]: controllerFeatureTool,',
      ));
    const ownership = join(candidate, 'peerd-runtime/controller-tool-ownership.js');
    writeFileSync(ownership, readFileSync(ownership, 'utf8').replace(
      "  load_skill: ['turn.introspection.installed-skill'],",
      [
        "  load_skill: ['turn.introspection.installed-skill'],",
        "  fixture_feature: ['turn.introspection.provider-posture'],",
      ].join('\n'),
    ));

    const candidateIntrospectionTools = await import(
      `${pathToFileURL(introspectionTools).href}?fixture=${Date.now()}`
    );
    const readCalls: string[] = [];
    expect(candidateIntrospectionTools.CONTROLLER_INTROSPECTION_TOOL_NAMES)
      .toContain('fixture_feature');
    expect(candidateIntrospectionTools.controllerHostsIntrospectionTool('fixture_feature'))
      .toBe(true);
    expect(await candidateIntrospectionTools.executeControllerIntrospectionTool(
      'fixture_feature', {}, { sessionId: 'feature-growth' }, {
        readProviderPosture: async () => {
          readCalls.push('turn.introspection.provider-posture');
          return { provider: 'fixture-provider' };
        },
      },
    )).toEqual({ ok: true, content: 'provider:fixture-provider' });
    expect(readCalls).toEqual(['turn.introspection.provider-posture']);

    const candidateOwnership = await import(
      `${pathToFileURL(ownership).href}?fixture=${Date.now()}`
    );
    expect(candidateOwnership.controllerHostsTool('fixture_feature')).toBe(true);
    expect(candidateOwnership.controllerAuthorityClassForTool('fixture_feature'))
      .toBe('introspection');
    expect(candidateOwnership.controllerOperationsForTools(['fixture_feature']))
      .toEqual(['turn.introspection.provider-posture']);

    const candidateProjection = await import(
      `${pathToFileURL(join(candidate, 'peerd-runtime/controller-tool-projection.js')).href}?fixture=${Date.now()}`
    );
    expect(candidateProjection.projectControllerToolSurface({
      surface: 'selection', toolNames: ['fixture_feature'],
    })).toMatchObject({
      ok: true,
      tools: [{ name: 'fixture_feature', primitive: 'inspect', sideEffect: 'read' }],
      operations: ['turn.introspection.provider-posture'],
    });

    const baselineDigest = await writeControllerBuildIdentity(baseline);
    const candidateDigest = await writeControllerBuildIdentity(candidate);
    expect(candidateDigest).not.toBe(baselineDigest);

    // why: normalize only the authored identity leaves before comparing. The
    // invariant excludes exactly build-identity-only churn and nothing else.
    for (const extension of [baseline, candidate]) {
      normalizeControllerBuildIdentity(extension);
    }

    const baselineStoreSource = join(root, 'baseline-store-source');
    const candidateStoreSource = join(root, 'candidate-store-source');
    copyPackageSource(baselineStoreSource, baseline);
    copyPackageSource(candidateStoreSource, candidate);

    const targets = [
      {
        label: 'native Chrome', entry: 'background/vault-kernel-chrome.js',
      },
      {
        label: 'native Firefox', entry: 'background/vault-kernel-firefox.js',
      },
      {
        label: 'Preview Chrome', entry: 'background/vault-kernel-preview.js',
      },
      {
        label: 'Preview Firefox', entry: 'background/vault-kernel-firefox-preview.js',
      },
    ] as const;
    for (const target of targets) {
      const baselineGraph = await authorityGraphFingerprint(baseline, target.entry);
      const candidateGraph = await authorityGraphFingerprint(candidate, target.entry);
      expect(candidateGraph.inputs, target.label).toEqual(baselineGraph.inputs);
      expect(candidateGraph.bytes, target.label).toBe(baselineGraph.bytes);
      expect(candidateGraph.inputSha256, target.label).toBe(baselineGraph.inputSha256);
      expect(candidateGraph.inputs, target.label)
        .not.toContain('peerd-runtime/controller-feature-fixture.js');
    }

    const controllerGraph = await collectStaticModuleGraph(
      candidate, join(candidate, 'offscreen/controller-turn-runtime.js'),
    );
    expect([...controllerGraph].some((path) =>
      path.endsWith('/peerd-runtime/controller-feature-fixture.js'))).toBe(true);

    const fixture = readFileSync(
      join(candidate, 'peerd-runtime/controller-feature-fixture.js'), 'utf8',
    );
    expect(readFileSync(catalog, 'utf8')).toContain('"fixture_feature"');
    expect(fixture).toContain('controllerFeatureTool');

    expect(readFileSync(join(candidate, 'background/vault-kernel.js'), 'utf8'))
      .toBe(readFileSync(join(baseline, 'background/vault-kernel.js'), 'utf8'));

    const baselineArtifacts = join(root, 'baseline-artifacts');
    const candidateArtifacts = join(root, 'candidate-artifacts');
    for (const [sourceRoot, artifactRoot] of [
      [baselineStoreSource, baselineArtifacts],
      [candidateStoreSource, candidateArtifacts],
    ]) {
      await packageArtifact({
        sourceRoot, artifactRoot, channel: 'store', browser: 'chrome',
        version: '0.0.0', sign: false, verify: false, minify: false,
        coldBudgetMode: 'measure-only',
      });
    }
    const baselineStaging = join(baselineArtifacts, 'staging/store-chrome');
    const candidateStaging = join(candidateArtifacts, 'staging/store-chrome');
    // packageArtifact produced the exact Store-pruned/generated staging trees.
    // Re-run the real release order under a normalized identity: compact static
    // cold modules, stamp the target controller, then normalize only that stamp.
    for (const staging of [baselineStaging, candidateStaging]) {
      normalizeControllerBuildIdentity(staging);
    }
    const baselineReport = await minifyColdArtifactModules(
      baselineStaging, 'chrome', 'store',
    );
    const candidateReport = await minifyColdArtifactModules(
      candidateStaging, 'chrome', 'store',
    );
    const baselineStagedDigest = await writeControllerBuildIdentity(baselineStaging);
    const candidateStagedDigest = await writeControllerBuildIdentity(candidateStaging);
    expect(candidateStagedDigest).not.toBe(baselineStagedDigest);
    for (const staging of [baselineStaging, candidateStaging]) {
      normalizeControllerBuildIdentity(staging);
    }
    expect(candidateReport.graphs.serviceWorker.modules)
      .toBe(baselineReport.graphs.serviceWorker.modules);
    expect(candidateReport.graphs.serviceWorker.afterBytes)
      .toBe(baselineReport.graphs.serviceWorker.afterBytes);
    const baselineStagedGraph = await authorityGraphFingerprint(
      baselineStaging, 'background/vault-kernel-chrome.js',
    );
    const candidateStagedGraph = await authorityGraphFingerprint(
      candidateStaging, 'background/vault-kernel-chrome.js',
    );
    expect(candidateStagedGraph).toEqual(baselineStagedGraph);
    expect(candidateStagedGraph.inputs)
      .not.toContain('peerd-runtime/controller-feature-fixture.js');
    const stagedControllerGraph = await collectStaticModuleGraph(
      candidateStaging, join(candidateStaging, 'offscreen/controller-turn-runtime.js'),
    );
    expect([...stagedControllerGraph].some((path) =>
      path.endsWith('/peerd-runtime/controller-feature-fixture.js'))).toBe(true);
  }, 120_000);

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
