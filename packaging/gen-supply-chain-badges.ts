// Generate the three supply-chain badges from repo state.
//
//   badges/runtime-deps.json      npm packages the shipped extension needs
//   badges/vendor-integrity.json  third-party runtime files pinned by SHA-256
//   badges/actions-pinned.json    third-party GitHub Actions at a full SHA
//
// why folded into `bun run gen:dev` rather than a lane of its own: unlike the
// test badges, none of these needs a browser or even a test run. They are pure
// reads of package.json, vendor.lock.json and .github/workflows, so they belong
// with the other generated files whose drift CI already checks in one step.
//
// Run: bun run gen:badge:supply-chain   (folded into `bun run gen:dev`)

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './lib.ts';
import { writeBadge } from './test-badges.ts';
import {
  actionsPinnedBadge, countRuntimeDependencies, countVendorLockedFiles,
  runtimeDepsBadge, scanActionPins, vendorIntegrityBadge,
} from './supply-chain.ts';

export const RUNTIME_DEPS_BADGE = 'runtime-deps.json';
export const VENDOR_BADGE = 'vendor-integrity.json';
export const ACTIONS_BADGE = 'actions-pinned.json';

export const WORKFLOWS_DIR = join(REPO_ROOT, '.github', 'workflows');

/** Every workflow file, as the pin scanner wants them. */
export const readWorkflows = (): { file: string; text: string }[] =>
  readdirSync(WORKFLOWS_DIR)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
    .map((name) => ({
      file: `.github/workflows/${name}`,
      text: readFileSync(join(WORKFLOWS_DIR, name), 'utf8'),
    }));

const generate = () => {
  const runtimeDeps = countRuntimeDependencies(
    JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')),
  );
  const vendorFiles = countVendorLockedFiles(
    JSON.parse(readFileSync(join(REPO_ROOT, 'extension', 'vendor', 'vendor.lock.json'), 'utf8')),
  );
  const scan = scanActionPins(readWorkflows());

  for (const [file, badge] of [
    [RUNTIME_DEPS_BADGE, runtimeDepsBadge(runtimeDeps)],
    [VENDOR_BADGE, vendorIntegrityBadge(vendorFiles)],
    [ACTIONS_BADGE, actionsPinnedBadge(scan)],
  ] as const) {
    console.log(`wrote ${writeBadge(file, badge)} - ${badge.message}`);
  }
};

if (import.meta.main) generate();
