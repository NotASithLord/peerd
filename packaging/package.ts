// peerd packaging — the single entry point for the 2-channel × 2-browser
// artifact matrix (spec §5). Source development stays buildless and the
// extension/ tree runs directly in the browser. Packaging an artifact means:
//
//   1. stage a copy of extension/
//   2. prune what the channel must not ship:
//        both channels: tests/ and checked-in generated files
//        store:         eval/
//        dweb-disabled: peerd-distributed/ entirely, and the dweb loader is
//                       swapped for the stub-only template. This covers store
//                       packages and Firefox until it has a mesh host.
//   3. generate shared/channel-config.js (channel flag + CHANNEL_DEFAULTS)
//   4. generate the manifest for (channel, browser)
//   5. compact authored modules in the static SW/offscreen cold graphs
//      (module graph/names/vendor bytes preserved; staging copy only)
//   6. zip to artifacts/peerd-<channel>-<browser>.{zip,xpi}
//   7. store artifacts: run the no-dweb-strings verifier
//   8. preview artifacts: sign when credentials are present (packaging/sign.ts)
//
// Invocation:
//   bun run package -- --channel=store --browser=chrome
//   bun run package:all
//   flags: --no-sign (skip signing even if keys exist), --skip-verify,
//          --no-minify (diagnostic artifact; release commands never use it)

import {
  cpSync, rmSync, mkdirSync, writeFileSync, copyFileSync,
  readdirSync, statSync, utimesSync, chmodSync,
} from 'node:fs';
import { join, relative, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  REPO_ROOT, EXTENSION_DIR, ARTIFACTS_DIR, STORE_LOADER_TEMPLATE,
  CHANNELS, BROWSERS, type Channel, type Browser,
  readVersion, parseArgs,
} from './lib.ts';
import { generateManifest } from './gen-manifest.ts';
import { dwebEnabledForTarget, genChannelConfigSource } from './gen-channel-config.ts';
import { verifyStoreArtifact } from './verify-store-artifact.ts';
import { signPreviewArtifact } from './sign.ts';
import { buildWebTarget } from './package-web.ts';
import {
  assertColdArtifactBudgets,
  formatArtifactMinifyReport,
  minifyColdArtifactModules,
} from './minify-artifact-js.ts';

// Paths (relative to extension/) that never ship in ANY artifact.
// why eval/ is NOT here: the home page's Lab (home/eval-section.js) imports
// eval/ at module load, so pruning it from a channel 404s home.js's import
// graph and black-screens the home tab. The Lab is a dev tool, so it's pruned
// from STORE only (below), and eval-section lazy-loads it + degrades gracefully
// when absent — so store's home still mounts.
const PRUNE_ALWAYS = ['tests', 'manifest.json', 'shared/channel-config.js'];
// The home Lab is a preview-only dev tool. Dweb source and prompt text are
// separately pruned from every artifact without a working mesh host.
const PRUNE_STORE = ['eval'];
const PRUNE_DWEB = ['peerd-distributed', 'peerd-provider/system-prompt-dweb.txt'];

// Reproducible artifacts: two builds of the same tree must produce
// byte-identical zips, so a shipped artifact can be independently rebuilt
// and digest-compared against the release (CI builds every matrix cell
// twice and asserts the digests match). Three sources of nondeterminism
// are normalized before zipping:
//   mtimes  — cpSync stamps copy wall-clock time into every staged file,
//             and zip embeds it; every entry is reset to SOURCE_DATE_EPOCH
//             (the reproducible-builds.org convention; the default is an
//             arbitrary fixed date, not a real build time).
//   modes   — a contributor's umask or a stray +x rides into the zip's
//             external attributes; normalize to 0644/0755.
//   order   — `zip -r` walks readdir order; feed it an explicitly sorted
//             entry list instead. TZ is pinned for the zip child because
//             DOS timestamps in zip headers are local time.
// Validated, not coerced: an exported-but-EMPTY SOURCE_DATE_EPOCH is not nullish, so
// `??` doesn't fire and Number('') is 0 — every entry would silently stamp at the 1980
// DOS floor, a rebuilder's digests wouldn't match, and nothing would say why. A
// non-numeric value dies inside utimesSync naming neither the variable nor the cause.
// Both are configuration mistakes that must fail loudly at the source.
const readSourceDateEpoch = (): number => {
  const raw = process.env.SOURCE_DATE_EPOCH;
  if (raw === undefined || raw === '') return 946684800; // 2000-01-01T00:00:00Z
  // 315532800 = 1980-01-01, the earliest timestamp the zip format can represent.
  if (!/^\d+$/.test(raw) || Number(raw) < 315532800) {
    throw new Error(
      `SOURCE_DATE_EPOCH must be a positive integer unix timestamp at or after 315532800 (1980-01-01, the zip format floor); got "${raw}"`,
    );
  }
  return Number(raw);
};
const SOURCE_DATE_EPOCH = readSourceDateEpoch();

const listEntriesSorted = (root: string): string[] =>
  (readdirSync(root, { recursive: true }) as string[])
    .map((p) => p.split('\\').join('/'))
    .sort();

const normalizeStagingForZip = (staging: string): string[] => {
  const entries = listEntriesSorted(staging);
  const stamp = new Date(SOURCE_DATE_EPOCH * 1000);
  for (const rel of ['.', ...entries]) {
    const abs = join(staging, rel);
    chmodSync(abs, statSync(abs).isDirectory() ? 0o755 : 0o644);
    utimesSync(abs, stamp, stamp);
  }
  return entries;
};

const shouldCopy = (src: string, channel: Channel, browser: Browser): boolean => {
  const rel = relative(EXTENSION_DIR, src);
  if (rel === '') return true;
  if (basename(src) === '.DS_Store') return false;
  // why: .d.ts sidecars (e.g. vendor/browser-polyfill.d.ts) are dev-only
  // type tooling — tsc reads them at check time; the browser loads the .js
  // and ignores them. They must never ship in either artifact.
  if (src.endsWith('.d.ts')) return false;
  const pruned = [
    ...PRUNE_ALWAYS,
    ...(channel === 'store' ? PRUNE_STORE : []),
    ...(!dwebEnabledForTarget(channel, browser) ? PRUNE_DWEB : []),
  ];
  return !pruned.some((p) => rel === p || rel.startsWith(p + '/'));
};

export const packageArtifact = async (
  { channel, browser, version, sign = true, verify = true, minify = true }:
  {
    channel: Channel;
    browser: Browser;
    version: string;
    sign?: boolean;
    verify?: boolean;
    minify?: boolean;
  },
): Promise<string> => {
  const staging = join(ARTIFACTS_DIR, 'staging', `${channel}-${browser}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  cpSync(EXTENSION_DIR, staging, {
    recursive: true,
    filter: (src) => shouldCopy(src, channel, browser),
  });

  // Channel-specific generated/swapped files. The store loader swap is a
  // wholesale committed-file replacement (packaging/templates/), never a text
  // transform — what ships is exactly what's reviewable in the repo.
  writeFileSync(join(staging, 'shared', 'channel-config.js'), genChannelConfigSource(channel, browser));
  if (!dwebEnabledForTarget(channel, browser)) {
    copyFileSync(STORE_LOADER_TEMPLATE, join(staging, 'shared', 'dweb-loader.js'));
  }

  const manifest = generateManifest({ channel, browser, version });
  writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  if (minify) {
    const report = await minifyColdArtifactModules(staging, browser);
    assertColdArtifactBudgets(report);
    console.log(formatArtifactMinifyReport(report));
  }

  // Package. AMO takes .xpi (a zip); Chrome Web Store takes .zip; the
  // Chrome preview .crx is produced from the zip by the signing step.
  const ext = browser === 'firefox' ? 'xpi' : 'zip';
  const artifact = join(ARTIFACTS_DIR, `peerd-${channel}-${browser}.${ext}`);
  rmSync(artifact, { force: true });
  // -X strips platform extra fields; -@ takes the sorted entry list on stdin
  // (see normalizeStagingForZip — mtimes/modes/order are already normalized).
  const entries = normalizeStagingForZip(staging);
  execFileSync('zip', ['-q', '-X', artifact, '-@'], {
    cwd: staging,
    input: entries.join('\n') + '\n',
    env: { ...process.env, TZ: 'UTC' },
  });

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
  const minify = args['no-minify'] !== true;
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
    await packageArtifact({ channel, browser, version, sign, verify, minify });
  }
  // --all means EVERY destination: after the 2×2 extension matrix, stage +
  // verify the web target too (a staged library tree, not a zip — no browser
  // or signing axis, so it lives outside the pair loop).
  if (args.all === true || (!args.channel && !args.browser)) {
    await buildWebTarget();
  }
  console.log('done.');
};

if (import.meta.main) await main();
