// Generate badges/e2e-chrome.json from the live side-panel E2E lane
// (scripts/cdp/run-e2e-verify.mjs --functional): the REAL unpacked extension in
// Chrome, driven through every functional state in scripts/cdp/states.mjs.
//
// why this lane gets a number of its own: it is the only seam where the service
// worker, the port, the vault and the agent loop run end to end, and it counts
// CHECKS rather than test cases, so the honest unit is "states driven and
// assertions passed" and not a test-file tally.
//
// The visual states are excluded on purpose (--functional matches CI's e2e
// job): their reference is computed from the merge base per run, so they have
// no stable pass count to advertise.
//
// Run: bun run gen:badge:e2e   (needs Chrome for Testing: bun run e2e:chrome)

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './lib.ts';
import { e2eBadge, parseE2eReport, runLane, writeBadge } from './test-badges.ts';

export const E2E_BADGE = 'e2e-chrome.json';
export const E2E_LABEL = 'E2E (side panel)';

/** The verify runner writes its structured verdict here, not to the scratch dir. */
const E2E_REPORT = join('scripts', 'cdp', 'artifacts', 'result.json');

const generate = () => {
  const totals = parseE2eReport(runLane(
    'side-panel E2E suite',
    ['scripts/cdp/run-e2e-verify.mjs', '--functional'],
    () => readFileSync(join(REPO_ROOT, E2E_REPORT), 'utf8'),
  ));
  const badge = e2eBadge(E2E_LABEL, totals, 'googlechrome');
  console.log(`wrote ${writeBadge(E2E_BADGE, badge)} - ${badge.message}`);
};

if (import.meta.main) generate();
