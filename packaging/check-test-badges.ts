// Every committed coverage badge is a well-formed Shields endpoint carrying a
// coherent count.
//
//   bun run check:badges
//
// why a check that runs no browser: the real gate on each count is the CI job
// that ran the lane and diffed its regenerated badge. This one is the cheap
// structural floor underneath that, so a malformed or hand-edited endpoint
// fails in milliseconds instead of rendering as a broken image on the README.
//
// It deliberately does NOT compare the Chrome and Gecko totals against each
// other. See laneCountProblem in test-badges.ts: those two lanes register
// slightly different graphs on purpose.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './lib.ts';
import { GECKO_BADGE } from './gen-gecko-test-badge.ts';
import { INBROWSER_CHROME_BADGE } from './gen-inbrowser-test-badge.ts';
import { E2E_BADGE } from './gen-e2e-badge.ts';
import { RED_TEAM_BADGE } from './gen-red-team-badge.ts';
import { laneCountProblem, type ShieldsBadge } from './test-badges.ts';

/** Badges whose message is a "N/M passing" browser-lane count. */
const LANE_BADGES = [INBROWSER_CHROME_BADGE, GECKO_BADGE];

/** Every committed badge, lane or not, that must parse as a Shields endpoint. */
const ALL_BADGES = [
  ...LANE_BADGES, E2E_BADGE, RED_TEAM_BADGE, 'functional-tests.json', 'tscheck.json',
];

const readBadge = (file: string): ShieldsBadge => {
  const badge = JSON.parse(readFileSync(join(REPO_ROOT, 'badges', file), 'utf8'));
  if (badge?.schemaVersion !== 1 || typeof badge.label !== 'string'
    || typeof badge.message !== 'string' || typeof badge.color !== 'string') {
    throw new Error(`badges/${file} is not a Shields endpoint {schemaVersion,label,message,color}`);
  }
  return badge;
};

const check = () => {
  const badges = ALL_BADGES.map((file) => ({ file: `badges/${file}`, badge: readBadge(file) }));
  const problem = laneCountProblem(
    badges.filter((entry) => LANE_BADGES.some((file) => entry.file.endsWith(file))),
  );
  if (problem) {
    console.error(`\ncheck:badges FAILED: ${problem}.`);
    console.error('Regenerate that lane (bun run gen:badge:inbrowser, or');
    console.error('FIREFOX_PATH=... bun run gen:badge:gecko) and commit it.');
    process.exit(1);
  }
  for (const entry of badges) console.log(`  ${entry.file}: ${entry.badge.message}`);
  console.log(`test badges OK (${badges.length} well-formed endpoints)`);
};

if (import.meta.main) check();
