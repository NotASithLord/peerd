// Pure core for the supply-chain badges and the action-pin gate.
//
// Three facts about how code gets INTO peerd, each derived from repo state
// rather than asserted in prose:
//
//   1. runtime npm dependencies. The extension ships none. package.json has no
//      `dependencies` at all, and packaging/package.ts stages extension/
//      verbatim without ever resolving a node_modules path, so the build-time
//      tree cannot reach a user. A number that must stay 0.
//   2. vendored files. Third-party runtime code lives in extension/vendor/ and
//      ships verbatim, so every byte is pinned by SHA-256 in vendor.lock.json
//      and check-vendor.ts fails on any divergence.
//   3. GitHub Action pins. A major tag is a mutable ref the publisher can move,
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

/** npm packages the SHIPPED extension depends on at runtime. Must be zero. */
export const countRuntimeDependencies = (packageJson: unknown): number => {
  const dependencies = (packageJson as { dependencies?: Record<string, string> })?.dependencies;
  if (dependencies !== undefined && typeof dependencies !== 'object') {
    throw new Error('package.json "dependencies" is not an object');
  }
  return Object.keys(dependencies ?? {}).length;
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

export const runtimeDepsBadge = (count: number): ShieldsBadge => ({
  schemaVersion: 1,
  label: 'Runtime npm deps',
  message: String(count),
  // why red at one: the invariant is not "few", it is "none". Any number
  // other than zero means npm code can reach an installed extension.
  color: count === 0 ? 'brightgreen' : 'red',
  ...laneLogo('npm'),
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
