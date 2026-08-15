// Generate the three supply-chain badges from repo state.
//
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
  actionsPinnedBadge, buildStepBadge, countVendorLockedFiles,
  scanActionPins, scanBuildStep, vendorIntegrityBadge,
} from './supply-chain.ts';

export const VENDOR_BADGE = 'vendor-integrity.json';
export const ACTIONS_BADGE = 'actions-pinned.json';
export const BUILD_STEP_BADGE = 'no-build.json';

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
  const packageJson = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  const buildStep = scanBuildStep(
    packageJson,
    readFileSync(join(REPO_ROOT, 'tsconfig.json'), 'utf8'),
  );
  // why throw rather than publish a red plate: "no build step" is the premise
  // the whole project rests on (load unpacked, refresh, the browser runs what
  // you wrote). If it stops being true, that is a design decision someone must
  // make deliberately, not a badge quietly turning red.
  if (buildStep.offenders.length > 0) {
    console.error('\nthe no-build-step invariant is broken:');
    for (const offender of buildStep.offenders) console.error(`  ${offender}`);
    process.exit(1);
  }
  const vendorFiles = countVendorLockedFiles(
    JSON.parse(readFileSync(join(REPO_ROOT, 'extension', 'vendor', 'vendor.lock.json'), 'utf8')),
  );
  const scan = scanActionPins(readWorkflows());

  for (const [file, badge] of [
    [BUILD_STEP_BADGE, buildStepBadge(buildStep)],
    [VENDOR_BADGE, vendorIntegrityBadge(vendorFiles)],
    [ACTIONS_BADGE, actionsPinnedBadge(scan)],
  ] as const) {
    console.log(`wrote ${writeBadge(file, badge)} - ${badge.message}`);
  }
};

if (import.meta.main) generate();
