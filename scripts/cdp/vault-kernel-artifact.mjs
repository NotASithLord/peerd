// Test-only packaged vault-kernel target. It starts from the verified Store
// package, changes only the copied staging manifest, and writes an artifact name
// outside the release matrix. The live manifest and release zips are untouched.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync,
  utimesSync, writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { ARTIFACTS_DIR, REPO_ROOT, readVersion } from '../../packaging/lib.ts';
import { packageArtifact } from '../../packaging/package.ts';
import { collectStaticModuleGraph } from '../../packaging/static-module-graph.ts';
import { genBuildConfigSource } from '../../packaging/gen-build-config.ts';
import { writeControllerBuildIdentity } from '../../packaging/controller-build-identity.ts';

const SOURCE_DATE = new Date(946684800 * 1000);

const entriesSorted = (root) => readdirSync(root, { recursive: true })
  .map((entry) => String(entry).split('\\').join('/'))
  .sort();

export const vaultKernelManifest = (manifest, browser) => ({
  ...manifest,
  name: `${manifest.name} vault kernel floor`,
  background: browser === 'firefox'
    ? { scripts: ['background/vault-kernel.js'], type: 'module' }
    : { service_worker: 'background/vault-kernel.js', type: 'module' },
});

export async function buildVaultKernelArtifact({ browser = 'chrome' } = {}) {
  if (!['chrome', 'firefox'].includes(browser)) throw new Error(`unsupported browser: ${browser}`);
  const version = readVersion();
  await packageArtifact({
    // This is a source-readable test target, not a release artifact. Its own
    // graph is measured below; it must not consume or mutate the live
    // monolith's temporary release-minification budget while that graph is
    // concurrently being dismantled.
    channel: 'store', browser, version, sign: false, verify: true, minify: false,
  });
  const source = join(ARTIFACTS_DIR, 'staging', `store-${browser}`);
  const staging = join(ARTIFACTS_DIR, 'staging', `vault-kernel-${browser}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  cpSync(source, staging, { recursive: true });

  const manifestPath = join(staging, 'manifest.json');
  const manifest = vaultKernelManifest(JSON.parse(readFileSync(manifestPath, 'utf8')), browser);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(staging, 'shared', 'build-config.js'),
    genBuildConfigSource(manifest, { dwebEnabled: false }),
  );
  await writeControllerBuildIdentity(staging);

  const entry = join(staging, 'background', 'vault-kernel.js');
  const graph = [...await collectStaticModuleGraph(staging, entry)].sort();
  const graphRelative = graph.map((path) => relative(staging, path).split('\\').join('/'));
  const forbidden = graphRelative.filter((path) =>
    path.startsWith('offscreen/')
    || path.includes('controller-turn')
    || path.includes('agent-loop')
    || path.includes('semantic-route-host'));
  if (forbidden.length > 0) {
    throw new Error(`vault kernel graph crossed semantic host boundary: ${forbidden.join(', ')}`);
  }

  const entries = entriesSorted(staging);
  for (const rel of ['.', ...entries]) {
    const path = join(staging, rel);
    chmodSync(path, statSync(path).isDirectory() ? 0o755 : 0o644);
    utimesSync(path, SOURCE_DATE, SOURCE_DATE);
  }
  const extension = browser === 'firefox' ? 'xpi' : 'zip';
  const artifact = join(ARTIFACTS_DIR, `peerd-vault-kernel-${browser}.${extension}`);
  rmSync(artifact, { force: true });
  execFileSync('zip', ['-q', '-X', artifact, '-@'], {
    cwd: staging,
    input: `${entries.join('\n')}\n`,
    env: { ...process.env, TZ: 'UTC' },
  });
  const bytes = graph.reduce((total, path) => total + statSync(path).size, 0);
  const sha256 = createHash('sha256').update(readFileSync(artifact)).digest('hex');
  return Object.freeze({
    browser,
    version,
    staging,
    artifact,
    artifactRelative: relative(REPO_ROOT, artifact).split('\\').join('/'),
    sha256,
    artifactBytes: statSync(artifact).size,
    graphModules: graph.length,
    graphBytes: bytes,
    graph: graphRelative,
  });
}

if (import.meta.main) {
  const browser = process.argv.find((value) => value.startsWith('--browser='))?.split('=')[1]
    ?? 'chrome';
  console.log(JSON.stringify(await buildVaultKernelArtifact({ browser }), null, 2));
}
