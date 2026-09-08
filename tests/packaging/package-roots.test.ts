import { afterEach, describe, expect, test } from 'bun:test';
import {
  mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { genChannelConfigSource } from '../../packaging/gen-channel-config.ts';
import { generateManifest } from '../../packaging/gen-manifest.ts';
import { REPO_ROOT } from '../../packaging/lib.ts';
import {
  assertRegularContainedPackageInput, assertRegularPackageTree, packageArtifact,
} from '../../packaging/package.ts';

const roots: string[] = [];
const temporaryRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'peerd-package-roots-'));
  roots.push(root);
  return root;
};

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('isolated package source and artifact roots', () => {
  test('manifest and generated channel data can come from the measured source tree', () => {
    const manifestsDir = join(temporaryRoot(), 'manifests');
    mkdirSync(manifestsDir, { recursive: true });
    writeFileSync(join(manifestsDir, 'base.json'), JSON.stringify({
      manifest_version: 3,
      name: 'base',
      version: '0.0.0',
      permissions: [],
    }));
    writeFileSync(join(manifestsDir, 'store.patch.json'), JSON.stringify({ name: 'historical store' }));

    expect(generateManifest({
      channel: 'store', browser: 'chrome', version: '1.2.3', manifestsDir,
    })).toMatchObject({ name: 'historical store', version: '1.2.3' });
    expect(genChannelConfigSource('store', 'chrome', {
      comparisonMarker: { store: 'historical', preview: 'candidate' },
    })).toContain('comparisonMarker: "historical"');
  });

  test('the historical measure-only posture cannot be applied to current release inputs or outputs', async () => {
    const artifactRoot = temporaryRoot();
    await expect(packageArtifact({
      channel: 'store',
      browser: 'chrome',
      version: '0.0.0',
      sourceRoot: REPO_ROOT,
      artifactRoot,
      sign: false,
      verify: false,
      minify: false,
      coldBudgetMode: 'measure-only',
    })).rejects.toThrow('measure-only cold budgets require isolated historical source and artifact roots');

    const incompleteSource = temporaryRoot();
    await expect(packageArtifact({
      channel: 'store',
      browser: 'chrome',
      version: '0.0.0',
      sourceRoot: incompleteSource,
      artifactRoot,
      sign: false,
      verify: false,
    })).rejects.toThrow('package source root is incomplete');
  });

  test('explicit source and artifact roots cannot overlap in either direction', async () => {
    const outer = temporaryRoot();
    await expect(packageArtifact({
      channel: 'store', browser: 'chrome', version: '0.0.0',
      sourceRoot: REPO_ROOT,
      artifactRoot: join(REPO_ROOT, 'artifacts', 'comparison-output'),
      sign: false, verify: false, minify: false,
    })).rejects.toThrow('must be disjoint');
    await expect(packageArtifact({
      channel: 'store', browser: 'chrome', version: '0.0.0',
      sourceRoot: join(outer, 'source'),
      artifactRoot: outer,
      sign: false, verify: false, minify: false,
    })).rejects.toThrow('must be disjoint');

    const symlinkRoot = temporaryRoot();
    const source = join(symlinkRoot, 'source');
    mkdirSync(source);
    const artifactAlias = join(symlinkRoot, 'artifact-alias');
    symlinkSync(source, artifactAlias);
    await expect(packageArtifact({
      channel: 'store', browser: 'chrome', version: '0.0.0',
      sourceRoot: source,
      artifactRoot: artifactAlias,
      sign: false, verify: false, minify: false,
    })).rejects.toThrow('must be disjoint');
  });

  test('an unreferenced asset symlink cannot escape into a release archive', async () => {
    const sourceRoot = temporaryRoot();
    const artifactRoot = temporaryRoot();
    const outsideRoot = temporaryRoot();
    mkdirSync(join(sourceRoot, 'extension', 'assets'), { recursive: true });
    mkdirSync(join(sourceRoot, 'manifests'), { recursive: true });
    mkdirSync(join(sourceRoot, 'packaging'), { recursive: true });
    writeFileSync(join(sourceRoot, 'packaging', 'default-settings.mjs'), 'export const defaults = {};\n');
    const outside = join(outsideRoot, 'vault-plaintext.txt');
    writeFileSync(outside, 'must never enter an extension archive\n');
    symlinkSync(outside, join(sourceRoot, 'extension', 'assets', 'unreferenced.txt'));

    await expect(packageArtifact({
      channel: 'preview', browser: 'chrome', version: '0.0.0',
      sourceRoot, artifactRoot, sign: false, verify: false, minify: false,
      coldBudgetMode: 'measure-only',
    })).rejects.toThrow(
      'package source extension tree contains a symbolic link: assets/unreferenced.txt',
    );
  });

  test('non-extension inputs reject symlinked files and parent directories', () => {
    const trustedRoot = temporaryRoot();
    const outsideRoot = temporaryRoot();
    const outsideFile = join(outsideRoot, 'vault-plaintext.js');
    writeFileSync(outsideFile, 'must never enter an extension archive\n');

    const linkedFile = join(trustedRoot, 'template.js');
    symlinkSync(outsideFile, linkedFile);
    expect(() => assertRegularContainedPackageInput(trustedRoot, linkedFile, 'fixture input'))
      .toThrow('fixture input contains a symbolic link: template.js');

    const outsideParent = join(outsideRoot, 'templates');
    mkdirSync(outsideParent);
    writeFileSync(join(outsideParent, 'template.js'), 'must never enter an extension archive\n');
    const linkedParent = join(trustedRoot, 'templates');
    symlinkSync(outsideParent, linkedParent);
    expect(() => assertRegularContainedPackageInput(
      trustedRoot, join(linkedParent, 'template.js'), 'fixture input',
    )).toThrow('fixture input contains a symbolic link: templates');
  });

  test('package sources reject linked manifests and default-settings parents before staging', async () => {
    const sourceRoot = temporaryRoot();
    const artifactRoot = temporaryRoot();
    const outsideRoot = temporaryRoot();
    mkdirSync(join(sourceRoot, 'extension'));
    mkdirSync(join(sourceRoot, 'packaging'));
    writeFileSync(join(sourceRoot, 'packaging', 'default-settings.mjs'), 'export const defaults = {};\n');
    const outsideManifests = join(outsideRoot, 'manifests');
    mkdirSync(outsideManifests);
    symlinkSync(outsideManifests, join(sourceRoot, 'manifests'));

    await expect(packageArtifact({
      channel: 'preview', browser: 'chrome', version: '0.0.0',
      sourceRoot, artifactRoot, sign: false, verify: false, minify: false,
      coldBudgetMode: 'measure-only',
    })).rejects.toThrow('package source manifests tree contains a symbolic link: manifests');

    const linkedDefaultsSource = temporaryRoot();
    mkdirSync(join(linkedDefaultsSource, 'extension'));
    mkdirSync(join(linkedDefaultsSource, 'manifests'));
    const outsidePackaging = join(outsideRoot, 'packaging');
    mkdirSync(outsidePackaging);
    writeFileSync(join(outsidePackaging, 'default-settings.mjs'), 'export const defaults = {};\n');
    symlinkSync(outsidePackaging, join(linkedDefaultsSource, 'packaging'));

    await expect(packageArtifact({
      channel: 'preview', browser: 'chrome', version: '0.0.0',
      sourceRoot: linkedDefaultsSource, artifactRoot,
      sign: false, verify: false, minify: false, coldBudgetMode: 'measure-only',
    })).rejects.toThrow('package source default settings contains a symbolic link: packaging');
  });

  test('release trees reject special filesystem nodes', () => {
    const root = temporaryRoot();
    const fifo = join(root, 'unreferenced.pipe');
    execFileSync('mkfifo', [fifo]);

    expect(() => assertRegularPackageTree(root, 'fixture tree'))
      .toThrow('fixture tree contains a non-regular entry: unreferenced.pipe');
  });
});
