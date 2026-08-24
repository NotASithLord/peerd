import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { genChannelConfigSource } from '../../packaging/gen-channel-config.ts';
import { generateManifest } from '../../packaging/gen-manifest.ts';
import { REPO_ROOT } from '../../packaging/lib.ts';
import { packageArtifact } from '../../packaging/package.ts';

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
});
