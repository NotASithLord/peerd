// peerd packaging — the single entry point for the 2-channel × 2-browser
// artifact matrix (spec §5). "Packaging" here is NOT a bundler pass — the
// extension is vanilla JS with no build step. Packaging an artifact means:
//
//   1. stage a copy of extension/
//   2. prune what the channel must not ship:
//        both channels: tests/, eval/, peerd-distributed/demo/, manifest.json
//        store:         peerd-distributed/ ENTIRELY, and the dweb
//                       loader is swapped for the stub-only template —
//                       the boundary is structural, not tree-shaken
//   3. generate shared/channel-config.js (channel flag + CHANNEL_DEFAULTS)
//   4. generate the manifest for (channel, browser)
//   5. zip to artifacts/peerd-<channel>-<browser>.{zip,xpi}
//   6. store artifacts: run the no-dweb-strings verifier
//   7. preview artifacts: sign when credentials are present (packaging/sign.ts)
//
// Invocation:
//   bun run package -- --channel=store --browser=chrome
//   bun run package:all
//   flags: --no-sign (skip signing even if keys exist), --skip-verify

import { cpSync, rmSync, mkdirSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join, relative, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  REPO_ROOT, EXTENSION_DIR, ARTIFACTS_DIR,
  CHANNELS, BROWSERS, type Channel, type Browser,
  readVersion, parseArgs,
} from './lib.ts';
import { generateManifest } from './gen-manifest.ts';
import { genChannelConfigSource } from './gen-channel-config.ts';
import { verifyStoreArtifact } from './verify-store-artifact.ts';
import { signPreviewArtifact } from './sign.ts';

const STORE_LOADER_TEMPLATE = join(REPO_ROOT, 'packaging', 'templates', 'dweb-loader.store.js');

// Paths (relative to extension/) that never ship in ANY artifact.
const PRUNE_ALWAYS = ['tests', 'eval', 'manifest.json', 'shared/channel-config.js'];
// Additionally pruned from store artifacts: the entire dweb module,
// plus the system-prompt paragraph that describes it (the loader inserts
// it only when DWEB_ENABLED — a store prompt must make no
// dweb claims).
const PRUNE_STORE = ['peerd-distributed', 'peerd-provider/system-prompt-dweb.txt'];

const shouldCopy = (src: string, channel: Channel): boolean => {
  const rel = relative(EXTENSION_DIR, src);
  if (rel === '') return true;
  if (basename(src) === '.DS_Store') return false;
  // why: .d.ts sidecars (e.g. vendor/browser-polyfill.d.ts) are dev-only
  // type tooling — tsc reads them at check time; the browser loads the .js
  // and ignores them. They must never ship in either artifact.
  if (src.endsWith('.d.ts')) return false;
  const pruned = channel === 'store' ? [...PRUNE_ALWAYS, ...PRUNE_STORE] : PRUNE_ALWAYS;
  return !pruned.some((p) => rel === p || rel.startsWith(p + '/'));
};

export const packageArtifact = async (
  { channel, browser, version, sign = true, verify = true }:
  { channel: Channel; browser: Browser; version: string; sign?: boolean; verify?: boolean },
): Promise<string> => {
  const staging = join(ARTIFACTS_DIR, 'staging', `${channel}-${browser}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  cpSync(EXTENSION_DIR, staging, {
    recursive: true,
    filter: (src) => shouldCopy(src, channel),
  });

  // Channel-specific generated/swapped files. The store loader swap is a
  // wholesale committed-file replacement (packaging/templates/), never a text
  // transform — what ships is exactly what's reviewable in the repo.
  writeFileSync(join(staging, 'shared', 'channel-config.js'), genChannelConfigSource(channel));
  if (channel === 'store') {
    copyFileSync(STORE_LOADER_TEMPLATE, join(staging, 'shared', 'dweb-loader.js'));
  }

  const manifest = generateManifest({ channel, browser, version });
  writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  // Package. AMO takes .xpi (a zip); Chrome Web Store takes .zip; the
  // Chrome preview .crx is produced from the zip by the signing step.
  const ext = browser === 'firefox' ? 'xpi' : 'zip';
  const artifact = join(ARTIFACTS_DIR, `peerd-${channel}-${browser}.${ext}`);
  rmSync(artifact, { force: true });
  // -X: no platform extra fields, keeps artifacts reproducible-ish.
  execFileSync('zip', ['-q', '-r', '-X', artifact, '.'], { cwd: staging });

  console.log(`built ${relative(REPO_ROOT, artifact)} (${channel}/${browser} v${version})`);

  if (channel === 'store' && verify) {
    await verifyStoreArtifact(artifact);
  }
  if (channel === 'preview' && sign) {
    await signPreviewArtifact({ browser, artifact, version });
  }
  return artifact;
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const version = readVersion();
  const sign = args['no-sign'] !== true;
  const verify = args['skip-verify'] !== true;
  mkdirSync(ARTIFACTS_DIR, { recursive: true });

  const pairs: Array<[Channel, Browser]> = [];
  if (args.all === true || (!args.channel && !args.browser)) {
    for (const c of CHANNELS) for (const b of BROWSERS) pairs.push([c, b]);
  } else {
    const channel = String(args.channel) as Channel;
    const browser = String(args.browser ?? 'chrome') as Browser;
    if (!CHANNELS.includes(channel)) throw new Error(`bad --channel=${channel}`);
    if (!BROWSERS.includes(browser)) throw new Error(`bad --browser=${browser}`);
    pairs.push([channel, browser]);
  }

  for (const [channel, browser] of pairs) {
    await packageArtifact({ channel, browser, version, sign, verify });
  }
  console.log('done.');
};

if (import.meta.main) await main();
