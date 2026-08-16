// Pure core for the supply-chain badges and the action-pin gate.
//
// Three facts about how code gets INTO peerd, each derived from repo state
// rather than asserted in prose:
//
//   1. vendored files. Third-party runtime code lives in extension/vendor/ and
//      ships verbatim, so every byte is pinned by SHA-256 in vendor.lock.json
//      and check-vendor.ts fails on any divergence.
//   2. GitHub Action pins. A major tag is a mutable ref the publisher can move,
//      which means arbitrary code in release CI. Every third-party action is
//      pinned to a full commit SHA.
//
// why these three and not a "hardened" plate: each is a count a gate already
// enforces, so the badge is evidence. A badge asserting a posture would be the
// thing this repo's badge convention exists to avoid.

import { laneLogo, type ShieldsBadge } from './test-badges.ts';

/** A full 40-hex commit SHA, the only ref shape that cannot be moved. */
export const SHA_PIN = /^[0-9a-f]{40}$/;

export interface ActionUse {
  file: string;
  line: number;
  uses: string;
  action: string;
  ref: string;
  pinned: boolean;
}

export interface ActionPinScan {
  uses: ActionUse[];
  /** Distinct owner/repo actions, pinned only when EVERY use of them is a SHA. */
  actions: { action: string; pinned: boolean }[];
  unpinned: ActionUse[];
}

/**
 * Find every third-party action reference in a set of workflow sources.
 *
 * Local composite actions (`./.github/actions/x`) and docker refs are skipped:
 * a relative path is this repo's own code, already covered by review, and has
 * no upstream tag anyone could move.
 */
export const scanActionPins = (
  sources: { file: string; text: string }[],
): ActionPinScan => {
  const uses: ActionUse[] = [];
  for (const source of sources) {
    source.text.split('\n').forEach((rawLine, index) => {
      // `- uses: owner/repo@ref # v1.2.3` or `uses: owner/repo/path@ref`
      const match = /^\s*(?:-\s*)?uses:\s*(\S+)/.exec(rawLine);
      if (!match) return;
      const reference = match[1];
      if (reference.startsWith('./') || reference.startsWith('docker://')) return;
      const at = reference.lastIndexOf('@');
      const action = at === -1 ? reference : reference.slice(0, at);
      const ref = at === -1 ? '' : reference.slice(at + 1);
      uses.push({
        file: source.file,
        line: index + 1,
        uses: reference,
        action,
        ref,
        pinned: SHA_PIN.test(ref),
      });
    });
  }
  const names = [...new Set(uses.map((use) => use.action))].sort();
  return {
    uses,
    actions: names.map((action) => ({
      action,
      // One unpinned use taints the action: the mutable ref is reachable.
      pinned: uses.filter((use) => use.action === action).every((use) => use.pinned),
    })),
    unpinned: uses.filter((use) => !use.pinned),
  };
};

/** Files carrying a SHA-256 in extension/vendor/vendor.lock.json. */
export const countVendorLockedFiles = (lock: unknown): number => {
  const files = (lock as { files?: Record<string, string> })?.files;
  if (!files || typeof files !== 'object') {
    throw new Error('vendor.lock.json has no "files" map');
  }
  const count = Object.keys(files).length;
  if (count < 1) throw new Error('vendor.lock.json pins no files');
  return count;
};

/**
 * Toolchains that would make source development depend on compilation.
 *
 * Kept as name PREFIXES so a scoped or plugin package (@babel/core,
 * vite-plugin-x, rollup-plugin-y) is caught by the same entry.
 */
export const BUILD_TOOLCHAINS = Object.freeze([
  'webpack', 'rollup', 'esbuild', 'vite', 'parcel', 'browserify',
  '@babel/', 'babel-', '@swc/', 'swc-', 'terser', 'uglify',
]);

export interface BuildStepScan { offenders: string[] }

/**
 * Prove the no-development-build-step invariant from the toolchain.
 *
 * Three conditions would break the direct source loop: a bundler/transpiler
 * dependency, a `build` script, or a TypeScript config that emits. tsc runs as
 * a checker only. Release packaging may compact its disposable staging copy
 * with Bun's built-in parser, but extension/ itself is never generated.
 */
export const scanBuildStep = (
  packageJson: unknown,
  tsconfigText: string,
): BuildStepScan => {
  const pkg = packageJson as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  const offenders: string[] = [];
  const declared = [
    ...Object.keys(pkg?.dependencies ?? {}),
    ...Object.keys(pkg?.devDependencies ?? {}),
  ];
  for (const name of declared) {
    const hit = BUILD_TOOLCHAINS.find((tool) => name.startsWith(tool));
    if (hit) offenders.push(`dependency "${name}" is a bundler or transpiler`);
  }
  // A runtime dependency is the same claim from the other side: it would mean
  // npm code reaching an installed extension. Packaging never resolves a
  // node_modules path into the staged artifact. This lived on its own badge until it
  // folded in here; the fact still needs a gate even without a plate on the
  // README.
  for (const name of Object.keys(pkg?.dependencies ?? {})) {
    offenders.push(`"${name}" is a RUNTIME dependency; the shipped extension takes none`);
  }
  if (pkg?.scripts && Object.hasOwn(pkg.scripts, 'build')) {
    offenders.push('package.json declares a "build" script');
  }
  // Comment-tolerant: tsconfig.json here is heavily commented JSONC.
  if (!/"noEmit"\s*:\s*true/.test(tsconfigText)) {
    offenders.push('tsconfig.json does not set noEmit: true, so tsc could emit');
  }
  return { offenders };
};

export const buildStepBadge = (scan: BuildStepScan): ShieldsBadge => ({
  schemaVersion: 1,
  label: 'Dev build step',
  message: scan.offenders.length === 0 ? 'none (source-direct)' : 'present',
  color: scan.offenders.length === 0 ? 'brightgreen' : 'red',
  ...laneLogo('javascript'),
});

export const vendorIntegrityBadge = (files: number): ShieldsBadge => ({
  schemaVersion: 1,
  label: 'Vendored code',
  message: `${files} files SHA-256 pinned`,
  color: 'brightgreen',
  ...laneLogo('javascript'),
});

export const actionsPinnedBadge = (scan: ActionPinScan): ShieldsBadge => {
  const total = scan.actions.length;
  const pinned = scan.actions.filter((action) => action.pinned).length;
  if (total < 1) throw new Error('no third-party actions found to report');
  return {
    schemaVersion: 1,
    label: 'Actions',
    message: `${pinned}/${total} SHA-pinned`,
    color: pinned === total ? 'brightgreen' : 'red',
    ...laneLogo('githubactions'),
  };
};
