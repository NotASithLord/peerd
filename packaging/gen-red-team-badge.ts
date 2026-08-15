// Generate badges/red-team.json by running the red-team scenario catalog
// (tests/red-team/) against the real defense code.
//
// why this lane deserves its own number: the other badges say the code works.
// This one says the code holds while something hostile pushes on it, which is
// the claim SECURITY.md and docs/security/THREAT-MODEL.md actually make. Each
// scenario casts one adversary from the threat model as code and records
// whether the defense blocked every probe.
//
// It reuses the same CATALOG that gates CI in tests/red-team/red-team.test.ts
// and publishes docs/security/RED-TEAM-RESULTS.md via `bun run red-team:report`,
// so the badge cannot disagree with either.
//
// Run: bun run gen:badge:red-team   (pure Bun, no browser)

import { CATALOG } from '../tests/red-team/index.ts';
import { runScenario } from '../tests/red-team/harness.ts';
import { redTeamBadge, tallyRedTeam, writeBadge } from './test-badges.ts';

export const RED_TEAM_BADGE = 'red-team.json';
export const RED_TEAM_LABEL = 'Red Team';

const generate = async () => {
  const totals = tallyRedTeam(await Promise.all(CATALOG.map(runScenario)));
  const badge = redTeamBadge(RED_TEAM_LABEL, totals, 'bun');
  // why fail loudly rather than publish a red badge: a leaked probe is a
  // security regression, and the gate for it is the test suite, not a color.
  if (totals.probesBlocked !== totals.probes) {
    console.error(`\n${totals.probes - totals.probesBlocked} red-team probe(s) LEAKED. `
      + 'Run `bun run red-team:report` for the matrix.');
    process.exit(1);
  }
  console.log(`wrote ${writeBadge(RED_TEAM_BADGE, badge)} - ${badge.message}`);
};

if (import.meta.main) await generate();
