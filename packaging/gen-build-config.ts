// Build-config generator: emits the tiny immutable identity facts that are
// unavailable in every extension realm. In particular, Chrome offscreen
// documents expose runtime.getURL but not runtime.getManifest, so provenance
// checks must not discover the privileged background entry at runtime.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  EXTENSION_DIR, parseArgs, type Browser, type ConfigChannel,
} from './lib.ts';
import { flattenDefaults } from './gen-channel-config.ts';
import { writeControllerBuildIdentity } from './controller-build-identity.ts';

const DEV_MANIFEST = join(EXTENSION_DIR, 'manifest.json');
const DEV_OUT = join(EXTENSION_DIR, 'shared', 'build-config.js');

export const backgroundEntryFromManifest = (manifest: Record<string, any>): string => {
  const serviceWorker = manifest?.background?.service_worker;
  if (typeof serviceWorker === 'string' && serviceWorker.length > 0) return serviceWorker;
  const script = manifest?.background?.scripts?.[0];
  if (typeof script === 'string' && script.length > 0) return script;
  throw new Error('manifest has no background module entry');
};

export const genBuildConfigSource = (
  manifest: Record<string, any>,
  {
    dwebEnabled = false, channel = 'preview', browser = 'chrome',
  }: { dwebEnabled?: boolean, channel?: ConfigChannel, browser?: Browser } = {},
): string => {
  const version = manifest?.version;
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('manifest has no extension version');
  }
  const backgroundEntry = backgroundEntryFromManifest(manifest);
  const settingsDefaults = JSON.stringify(flattenDefaults(channel, browser));
  return `// @ts-check
// GENERATED FILE. Do not edit. Source of truth: the packaged manifest.
// Chrome offscreen documents do not expose runtime.getManifest, so these
// exact build facts are stamped into every artifact and the dev tree.

export const EXTENSION_VERSION = ${JSON.stringify(version)};
export const BACKGROUND_MODULE_PATH = ${JSON.stringify(backgroundEntry)};
/** @type {'chrome'|'firefox'} */
export const BROWSER = ${JSON.stringify(browser)};
export const CHANNEL = ${JSON.stringify(channel)};
export const DWEB_ENABLED = ${dwebEnabled ? 'true' : 'false'};
export const CHANNEL_DEFAULTS = Object.freeze(${settingsDefaults});
export const CONTROLLER_BUILD_DIGEST = '${'0'.repeat(64)}';
`;
};

export const writeDevBuildConfig = async ({
  manifestFile = DEV_MANIFEST,
  out = DEV_OUT,
}: {
  manifestFile?: string;
  out?: string;
} = {}): Promise<string> => {
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, genBuildConfigSource(manifest, {
    dwebEnabled: true, channel: 'preview', browser: 'chrome',
  }));
  // why: build-config is one of two identity leaves. Stamp only after its
  // target facts exist so every `gen:dev` caller gets one matching runtime
  // identity instead of needing a second, easy-to-forget command.
  const digest = await writeControllerBuildIdentity(resolve(dirname(out), '..'));
  console.log(`wrote ${out} (manifest=${manifestFile})`);
  return digest;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  await writeDevBuildConfig({
    manifestFile: String(args.manifest ?? DEV_MANIFEST),
    out: String(args.out ?? DEV_OUT),
  });
};

if (import.meta.main) await main();
