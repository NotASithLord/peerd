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
import {
  collectStaticModuleGraph,
} from '../../packaging/static-module-graph.ts';
import { genBuildConfigSource } from '../../packaging/gen-build-config.ts';
import { dwebEnabledForTarget } from '../../packaging/gen-channel-config.ts';
import { minifyColdArtifactModules } from '../../packaging/minify-artifact-js.ts';
import { writeControllerBuildIdentity } from '../../packaging/controller-build-identity.ts';
import { COLD_START_TARGETS } from '../bench/cold-start-budgets.js';
import { bundleChromeNativeKernel } from '../../packaging/bundle-chrome-native-kernel.ts';

const SOURCE_DATE = new Date(946684800 * 1000);
const entriesSorted = (root) => readdirSync(root, { recursive: true })
  .map((entry) => String(entry).split('\\').join('/'))
  .sort();

const nativeEntry = (browser, channel) => browser === 'chrome' && channel === 'preview'
  ? 'background/vault-kernel-preview.js'
  : 'background/vault-kernel.js';

export const vaultKernelManifest = (manifest, browser, channel = 'store') => ({
  ...manifest,
  name: `${manifest.name} vault kernel ${channel} floor`,
  background: browser === 'firefox'
    ? { scripts: [nativeEntry(browser, channel)], type: 'module' }
    : { service_worker: nativeEntry(browser, channel), type: 'module' },
});

export const assertVaultKernelReleaseTarget = ({
  browser, modules, graphBytes, entryBytes, bundled = false,
}) => {
  const target = COLD_START_TARGETS[browser]?.serviceWorker;
  if (!target) throw new Error(`no native cold target for ${browser}`);
  for (const [name, value] of Object.entries({ modules, graphBytes, entryBytes })) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`invalid native ${name}: ${value}`);
    if (!bundled && value > target[name]) {
      throw new Error(`native ${browser} ${name} ${value} exceeds ${target[name]}`);
    }
  }
  if (bundled) {
    if (modules !== 1 || entryBytes !== graphBytes) {
      throw new Error('native Chrome bundle must be exactly one static module');
    }
    if (graphBytes > target.graphBytes) {
      throw new Error(`native ${browser} graphBytes ${graphBytes} exceeds ${target.graphBytes}`);
    }
  }
};

export async function buildVaultKernelArtifact({
  browser = 'chrome', channel = 'store', releaseMinify = false,
} = {}) {
  if (!['chrome', 'firefox'].includes(browser)) throw new Error(`unsupported browser: ${browser}`);
  if (!['store', 'preview'].includes(channel)) throw new Error(`unsupported channel: ${channel}`);
  const version = readVersion();
  await packageArtifact({
    // Start from the readable target package, then transform only this copied
    // native floor when releaseMinify is requested. The live artifact and its
    // legacy ratchet remain untouched.
    channel, browser, version, sign: false, verify: channel === 'store', minify: false,
  });
  const source = join(ARTIFACTS_DIR, 'staging', `${channel}-${browser}`);
  const staging = join(ARTIFACTS_DIR, 'staging', `vault-kernel-${channel}-${browser}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  cpSync(source, staging, { recursive: true });

  const manifestPath = join(staging, 'manifest.json');
  const manifest = vaultKernelManifest(
    JSON.parse(readFileSync(manifestPath, 'utf8')), browser, channel,
  );
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(
    join(staging, 'shared', 'build-config.js'),
    genBuildConfigSource(manifest, {
      dwebEnabled: dwebEnabledForTarget(channel, browser), channel, browser,
    }),
  );
  if (releaseMinify) await minifyColdArtifactModules(staging, browser, channel);
  await writeControllerBuildIdentity(staging);
  if (releaseMinify && browser === 'chrome') {
    await bundleChromeNativeKernel(staging, nativeEntry(browser, channel));
  }

  const entry = join(staging, nativeEntry(browser, channel));
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
  const artifact = join(
    ARTIFACTS_DIR, `peerd-vault-kernel-${channel}-${browser}.${extension}`,
  );
  rmSync(artifact, { force: true });
  execFileSync('zip', ['-q', '-X', artifact, '-@'], {
    cwd: staging,
    input: `${entries.join('\n')}\n`,
    env: { ...process.env, TZ: 'UTC' },
  });
  const bytes = graph.reduce((total, path) => total + statSync(path).size, 0);
  const entryBytes = statSync(entry).size;
  if (releaseMinify) {
    assertVaultKernelReleaseTarget({
      browser, modules: graph.length, graphBytes: bytes, entryBytes,
      bundled: browser === 'chrome',
    });
  }
  const sha256 = createHash('sha256').update(readFileSync(artifact)).digest('hex');
  return Object.freeze({
    browser, channel, releaseMinify,
    version,
    staging,
    artifact,
    artifactRelative: relative(REPO_ROOT, artifact).split('\\').join('/'),
    sha256,
    artifactBytes: statSync(artifact).size,
    graphModules: graph.length,
    graphBytes: bytes,
    entryBytes,
    graph: graphRelative,
  });
}

if (import.meta.main) {
  const browser = process.argv.find((value) => value.startsWith('--browser='))?.split('=')[1]
    ?? 'chrome';
  const channel = process.argv.find((value) => value.startsWith('--channel='))?.split('=')[1]
    ?? 'store';
  const releaseMinify = process.argv.includes('--release-minify');
  console.log(JSON.stringify(
    await buildVaultKernelArtifact({ browser, channel, releaseMinify }), null, 2,
  ));
}
