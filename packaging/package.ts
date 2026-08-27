// peerd packaging — the single entry point for the 2-channel × 2-browser
// artifact matrix (spec §5). Source development stays buildless and the
// extension/ tree runs directly in the browser. Packaging an artifact means:
//
//   1. stage a copy of extension/
//   2. prune what the channel must not ship:
//        both channels: tests/ and checked-in generated files
//        store:         eval/
//        dweb-disabled: peerd-distributed/ entirely; the loader and two cold
//                       route factories are swapped for committed fail-closed
//                       templates. This covers store packages and Firefox
//                       until it has a mesh host.
//   3. generate shared/channel-config.js (channel flag + CHANNEL_DEFAULTS)
//   4. generate the manifest for (channel, browser)
//   5. compact authored modules in the static SW/offscreen cold graphs
//      (module graph/names/vendor bytes preserved; staging copy only)
//   6. bundle an already-selected native Chrome kernel into one import-free file
//   7. zip to artifacts/peerd-<channel>-<browser>.{zip,xpi}
//   8. store artifacts: run the no-dweb-strings verifier
//   9. preview artifacts: sign when credentials are present (packaging/sign.ts)
//
// Invocation:
//   bun run package -- --channel=store --browser=chrome
//   bun run package:all
//   flags: --no-sign (skip signing even if keys exist), --skip-verify,
//          --no-minify (diagnostic artifact; release commands never use it)

import {
  cpSync, rmSync, mkdirSync, writeFileSync, copyFileSync, existsSync,
  readdirSync, statSync, utimesSync, chmodSync, realpathSync,
} from 'node:fs';
import { join, relative, basename, dirname, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import {
  REPO_ROOT, ARTIFACTS_DIR, STORE_LOADER_TEMPLATE,
  DWEB_ROUTES_DISABLED_TEMPLATE, DWEB_SELF_ROUTES_DISABLED_TEMPLATE,
  DEBUGGER_UNAVAILABLE_TEMPLATE,
  CHANNELS, BROWSERS, type Channel, type Browser,
  readVersion, parseArgs,
} from './lib.ts';
import { generateManifest } from './gen-manifest.ts';
import { genBuildConfigSource } from './gen-build-config.ts';
import { dwebEnabledForTarget, genChannelConfigSource } from './gen-channel-config.ts';
import { verifyStoreArtifact } from './verify-store-artifact.ts';
import { signPreviewArtifact } from './sign.ts';
import { buildWebTarget } from './package-web.ts';
import {
  assertColdArtifactBudgets,
  formatArtifactMinifyReport,
  minifyColdArtifactModules,
} from './minify-artifact-js.ts';
import {
  CONTROLLER_BUILD_ENTRIES,
  writeControllerBuildIdentity,
} from './controller-build-identity.ts';
import {
  assertNativeChromeBundleRatchet,
  bundleChromeNativeKernel,
  isChromeNativeKernelEntry,
} from './bundle-chrome-native-kernel.ts';

// Paths (relative to extension/) that never ship in ANY artifact.
// why eval/ is NOT here: the home page's Lab (home/eval-section.js) imports
// eval/ at module load, so pruning it from a channel 404s home.js's import
// graph and black-screens the home tab. The Lab is a dev tool, so it's pruned
// from STORE only (below), and eval-section lazy-loads it + degrades gracefully
// when absent — so store's home still mounts.
const PRUNE_ALWAYS = [
  'tests', 'manifest.json', 'shared/channel-config.js', 'shared/build-config.js',
];
// The home Lab is a preview-only dev tool. Dweb source and prompt text are
// separately pruned from every artifact without a working mesh host.
const PRUNE_STORE = ['eval'];
const PRUNE_DWEB = [
  'peerd-distributed', 'peerd-provider/system-prompt-dweb.txt',
  'offscreen/dweb-base.js', 'offscreen/dweb-custody-host.js',
  'offscreen/dweb-self.js', 'offscreen/dweb-transfer-host.js',
];
const PRUNE_PREVIEW_CHROME = [
  'background/kernel-preview-addon.js', 'background/vault-kernel-preview.js',
];

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

const shouldCopy = (
  extensionDir: string,
  src: string,
  channel: Channel,
  browser: Browser,
): boolean => {
  const rel = relative(extensionDir, src);
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
    ...(channel === 'preview' && browser === 'chrome' ? [] : PRUNE_PREVIEW_CHROME),
  ];
  return !pruned.some((p) => rel === p || rel.startsWith(p + '/'));
};

/**
 * Replace the two cold route factories only where the target has no mesh host.
 * Whole committed files keep this package boundary reviewable and deterministic.
 */
export const applyDwebDisabledTemplates = (
  staging: string,
  channel: Channel,
  browser: Browser,
): boolean => {
  if (dwebEnabledForTarget(channel, browser)) return false;
  copyFileSync(STORE_LOADER_TEMPLATE, join(staging, 'shared', 'dweb-loader.js'));
  copyFileSync(
    DWEB_ROUTES_DISABLED_TEMPLATE,
    join(staging, 'background', 'routes', 'dweb.js'),
  );
  copyFileSync(
    DWEB_SELF_ROUTES_DISABLED_TEMPLATE,
    join(staging, 'background', 'routes', 'dweb-self.js'),
  );
  return true;
};

export const packageArtifact = async (
  {
    channel, browser, version, sign = true, verify = true, minify = true,
    sourceRoot = REPO_ROOT, artifactRoot = ARTIFACTS_DIR,
    coldBudgetMode = 'enforce',
  }:
  {
    channel: Channel;
    browser: Browser;
    version: string;
    sign?: boolean;
    verify?: boolean;
    minify?: boolean;
    /** Repository-root input tree. Packaging code/tooling still comes from
     *  the caller's checkout; extension/manifests/default settings come from
     *  this immutable source tree. */
    sourceRoot?: string;
    /** Isolated output root for staging, archives, and optional signatures. */
    artifactRoot?: string;
    /** Base artifacts in an interleaved comparison are measured, not allowed
     *  to fail today's candidate ceiling. Candidate/release builds enforce. */
    coldBudgetMode?: 'enforce' | 'measure-only';
  },
): Promise<string> => {
  const canonicalPath = (input: string): string => {
    let existing = resolve(input);
    const missing: string[] = [];
    while (!existsSync(existing)) {
      const parent = dirname(existing);
      if (parent === existing) break;
      missing.unshift(basename(existing));
      existing = parent;
    }
    return resolve(realpathSync(existing), ...missing);
  };
  const resolvedSourceRoot = canonicalPath(sourceRoot);
  const resolvedArtifactRoot = canonicalPath(artifactRoot);
  const extensionDir = join(resolvedSourceRoot, 'extension');
  const manifestsDir = join(resolvedSourceRoot, 'manifests');
  const defaultSettingsFile = join(resolvedSourceRoot, 'packaging', 'default-settings.mjs');
  const isWithinOrEqual = (parent: string, child: string): boolean =>
    child === parent || child.startsWith(`${parent}${sep}`);
  const legacyDefaultRoots = resolvedSourceRoot === canonicalPath(REPO_ROOT)
    && resolvedArtifactRoot === canonicalPath(ARTIFACTS_DIR);
  if (!legacyDefaultRoots
      && (isWithinOrEqual(resolvedSourceRoot, resolvedArtifactRoot)
        || isWithinOrEqual(resolvedArtifactRoot, resolvedSourceRoot))) {
    throw new Error('explicit sourceRoot and artifactRoot must be disjoint (no ancestor overlap)');
  }
  for (const required of [extensionDir, manifestsDir, defaultSettingsFile]) {
    if (!existsSync(required)) throw new Error(`package source root is incomplete: missing ${required}`);
  }
  if (!['enforce', 'measure-only'].includes(coldBudgetMode)) {
    throw new Error(`unknown coldBudgetMode ${coldBudgetMode}`);
  }
  // This escape hatch exists only to observe an immutable historical base.
  // Normal/current-tree and normal/release output paths can never bypass the
  // checked-in absolute package ratchet.
  if (coldBudgetMode === 'measure-only'
      && (resolvedSourceRoot === canonicalPath(REPO_ROOT)
        || resolvedArtifactRoot === canonicalPath(ARTIFACTS_DIR))) {
    throw new Error('measure-only cold budgets require isolated historical source and artifact roots');
  }

  const staging = join(resolvedArtifactRoot, 'staging', `${channel}-${browser}`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });

  cpSync(extensionDir, staging, {
    recursive: true,
    filter: (src) => shouldCopy(extensionDir, src, channel, browser),
  });

  // Channel-specific generated/swapped files. Disabled dweb surfaces use
  // wholesale committed-file replacements (packaging/templates/), never text
  // transforms; what ships is exactly what's reviewable in the repo.
  const sourceDefaults = (await import(pathToFileURL(defaultSettingsFile).href)).defaults;
  if (!sourceDefaults || typeof sourceDefaults !== 'object') {
    throw new Error(`package source default settings are invalid: ${defaultSettingsFile}`);
  }
  writeFileSync(
    join(staging, 'shared', 'channel-config.js'),
    genChannelConfigSource(channel, browser, sourceDefaults),
  );
  applyDwebDisabledTemplates(staging, channel, browser);
  // CDP is a package-time capability, not a runtime grant: Store Chrome and
  // every Firefox artifact remove the debugger permission in gen-manifest.
  // Shipping the 50+ KiB pool and its custody/registry graph in those targets
  // can therefore only delay cold listener registration; advancedAutomationOn
  // is permanently false there. Swap the whole reviewed module for the exact
  // unavailable implementation rather than applying a brittle text transform.
  if (channel === 'store' || browser === 'firefox') {
    copyFileSync(
      DEBUGGER_UNAVAILABLE_TEMPLATE,
      join(staging, 'background', 'debugger-pool.js'),
    );
  }

  const manifest = generateManifest({ channel, browser, version, manifestsDir });
  writeFileSync(
    join(staging, 'shared', 'build-config.js'),
    genBuildConfigSource(manifest, {
      dwebEnabled: dwebEnabledForTarget(channel, browser),
      channel,
      browser,
    }),
  );
  writeFileSync(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

  const chromeBackgroundEntry = browser === 'chrome'
    ? manifest.background?.service_worker : null;
  const nativeChromeKernel = isChromeNativeKernelEntry(chromeBackgroundEntry);

  if (minify) {
    const report = await minifyColdArtifactModules(staging, browser, channel);
    if (coldBudgetMode === 'enforce') {
      assertColdArtifactBudgets(report);
    }
    console.log(formatArtifactMinifyReport(report));
    if (coldBudgetMode === 'enforce' && nativeChromeKernel) {
      console.log('cold graph budget: package no-growth ratchet');
    }
    if (coldBudgetMode === 'measure-only') {
      console.log('cold graph budget: measure-only historical base (candidate ratchet not applied)');
    }
  }

  // Bind the private semantic-controller channel to the exact target bytes.
  // This must happen after pruning/minification: hashing the authored source
  // would allow a stale host from a different packaged artifact to handshake.
  const canStampController = CONTROLLER_BUILD_ENTRIES.every((entry) => existsSync(join(staging, entry)))
    && existsSync(join(staging, 'shared', 'controller-build.js'));
  if (canStampController) {
    await writeControllerBuildIdentity(staging);
  } else if (coldBudgetMode === 'measure-only') {
    console.log('controller build identity: absent from historical base; no candidate stamp injected');
  } else {
    throw new Error('candidate artifact is missing the complete controller build-identity graph');
  }

  if (minify && nativeChromeKernel) {
    const bundled = await bundleChromeNativeKernel(staging, chromeBackgroundEntry);
    if (coldBudgetMode === 'enforce') {
      assertNativeChromeBundleRatchet(chromeBackgroundEntry, bundled);
    }
    console.log(`bundled native Chrome kernel ${bundled.bytes} bytes (${bundled.inputs.length} staged inputs; ${bundled.inputSha256})`);
  }

  // Package. AMO takes .xpi (a zip); Chrome Web Store takes .zip; the
  // Chrome preview .crx is produced from the zip by the signing step.
  const ext = browser === 'firefox' ? 'xpi' : 'zip';
  mkdirSync(resolvedArtifactRoot, { recursive: true });
  const artifact = join(resolvedArtifactRoot, `peerd-${channel}-${browser}.${ext}`);
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
    await verifyStoreArtifact(artifact, { sourceRoot: resolvedSourceRoot });
  }
  if (channel === 'preview' && sign) {
    await signPreviewArtifact({
      browser, artifact, version, artifactRoot: resolvedArtifactRoot, stagingDir: staging,
    });
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
