// Shared shaping for the per-lane test-count badges.
//
// peerd's coverage is spread across surfaces that no single number describes:
// the Bun suite (badges/functional-tests.json), the in-browser suite run under
// Chrome AND under Gecko, and the live side-panel E2E lane. Each of those runs
// in its own CI job, drops a machine-readable summary, and hands the totals
// here to become a committed Shields endpoint under badges/.
//
// why committed + drift-checked rather than a live service: the same CI job
// that RAN the lane diffs the regenerated badge, so an advertised count is
// always evidence from a real run instead of a hand-maintained inventory that
// silently rots. Same contract the functional badge already lives under.
//
// why a pure core: the counts are what CI gates on, so the arithmetic and the
// refusal to advertise a partial run have to be unit-testable with no browser
// in the room (tests/meta/test-badges.test.ts).

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './lib.ts';

/** Env var each browser harness writes its summary JSON to when asked. */
export const SUMMARY_ENV = 'PEERD_TEST_SUMMARY';

export interface SuiteTotals {
  passed: number;
  failed: number;
  total: number;
}

export interface ShieldsBadge {
  schemaVersion: 1;
  label: string;
  message: string;
  color: string;
  /** simple-icons slug Shields renders on the label side (chrome, firefox, bun). */
  namedLogo?: string;
  logoColor?: string;
}

/**
 * Icon each lane wears in the README, so the row reads as browsers and runners
 * at a glance instead of five identical gray plates.
 *
 * why white: Shields draws the logo on the dark label half, where a brand's own
 * color (Chrome's blue-red-yellow, Firefox's orange) muddies into the gray at
 * badge scale. Monochrome also keeps the README inside the house rule that
 * color is carried by the brand marks, not by chrome around them.
 */
export const laneLogo = (namedLogo: string): Pick<ShieldsBadge, 'namedLogo' | 'logoColor'> => ({
  namedLogo,
  logoColor: 'white',
});

const wholeNumber = (value: unknown, field: string): number => {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`test summary field "${field}" is not a whole count: ${String(value)}`);
  }
  return value as number;
};

/**
 * Read a browser harness summary into totals.
 *
 * why the executed === total check: a sharded or `only=`-filtered run produces
 * a perfectly valid summary for a SUBSET of the graph. Minting a badge from
 * one would advertise partial coverage as the whole suite, which is the exact
 * dishonesty these badges exist to prevent. Refuse instead.
 */
export const parseSuiteSummary = (raw: string): SuiteTotals => {
  const summary = JSON.parse(raw);
  const passed = wholeNumber(summary?.passed, 'passed');
  const failed = wholeNumber(summary?.failed, 'failed');
  const total = wholeNumber(summary?.total, 'total');
  if (total < 1) throw new Error('test summary reports an empty test graph');
  if (passed + failed !== total) {
    throw new Error(
      `test summary covers ${passed + failed} of ${total} registered tests; `
      + 'refusing to badge a partial run',
    );
  }
  return { passed, failed, total };
};

/** Shields endpoint for one browser lane: "938/938 passing". */
export const suiteBadge = (
  label: string,
  totals: SuiteTotals,
  namedLogo?: string,
): ShieldsBadge => ({
  schemaVersion: 1,
  label,
  message: `${totals.passed}/${totals.total} passing`,
  color: totals.failed === 0 ? 'brightgreen' : 'red',
  ...(namedLogo ? laneLogo(namedLogo) : {}),
});

export interface E2eTotals {
  states: number;
  checksPassed: number;
  checksTotal: number;
}

/** Read the E2E verify runner's result.json summary block. */
export const parseE2eReport = (raw: string): E2eTotals => {
  const report = JSON.parse(raw);
  const states = wholeNumber(report?.summary?.states, 'summary.states');
  const checksTotal = wholeNumber(report?.summary?.checksTotal, 'summary.checksTotal');
  const checksFailed = wholeNumber(report?.summary?.checksFailed, 'summary.checksFailed');
  if (states < 1 || checksTotal < 1) throw new Error('E2E report drove no states');
  if (checksFailed > checksTotal) throw new Error('E2E report failed more checks than it ran');
  return { states, checksPassed: checksTotal - checksFailed, checksTotal };
};

/** Shields endpoint for the E2E lane: "330/330 checks, 42 states". */
export const e2eBadge = (
  label: string,
  totals: E2eTotals,
  namedLogo?: string,
): ShieldsBadge => ({
  schemaVersion: 1,
  label,
  message: `${totals.checksPassed}/${totals.checksTotal} checks, ${totals.states} states`,
  color: totals.checksPassed === totals.checksTotal ? 'brightgreen' : 'red',
  ...(namedLogo ? laneLogo(namedLogo) : {}),
});

export interface RedTeamTotals {
  scenarios: number;
  scenariosHeld: number;
  probes: number;
  probesBlocked: number;
}

/**
 * Tally a red-team catalog run.
 *
 * why probes and not scenarios alone: a scenario is a whole adversary from the
 * threat model and bundles dozens of individual hostile probes, so "14/14
 * scenarios" understates the work by an order of magnitude. Both numbers ride
 * the badge, matching the sentence docs/security/RED-TEAM-RESULTS.md already
 * publishes.
 */
export const tallyRedTeam = (
  ran: { result: { held: boolean; probes: { blocked: boolean }[] } }[],
): RedTeamTotals => {
  if (ran.length < 1) throw new Error('red-team catalog ran no scenarios');
  const probes = ran.flatMap((scenario) => scenario.result.probes);
  if (probes.length < 1) throw new Error('red-team catalog recorded no probes');
  return {
    scenarios: ran.length,
    scenariosHeld: ran.filter((scenario) => scenario.result.held).length,
    probes: probes.length,
    probesBlocked: probes.filter((probe) => probe.blocked).length,
  };
};

/** Shields endpoint for the red-team lane: "221/221 probes, 14/14 scenarios". */
export const redTeamBadge = (
  label: string,
  totals: RedTeamTotals,
  namedLogo?: string,
): ShieldsBadge => ({
  schemaVersion: 1,
  label,
  message: `${totals.probesBlocked}/${totals.probes} probes, `
    + `${totals.scenariosHeld}/${totals.scenarios} scenarios`,
  // why red on ANY leak: a probe that got through is a defense regression, and
  // a badge is the worst possible place to average that away.
  color: totals.probesBlocked === totals.probes && totals.scenariosHeld === totals.scenarios
    ? 'brightgreen'
    : 'red',
  ...(namedLogo ? laneLogo(namedLogo) : {}),
});

/** Pull both numbers out of a lane badge's "938/938 passing" message. */
export const badgeCounts = (badge: ShieldsBadge): { passed: number; total: number } => {
  const match = /^(\d+)\/(\d+) passing$/.exec(badge.message);
  if (!match) throw new Error(`not a lane badge message: ${JSON.stringify(badge.message)}`);
  return { passed: Number(match[1]), total: Number(match[2]) };
};

/**
 * Lane badges must be internally coherent: a real graph, and no more passes
 * than tests.
 *
 * why NOT an equality check across the two in-browser lanes: an earlier version
 * of this gate asserted Chrome and Gecko share one denominator, and CI
 * disproved it on the first run. A few tests register only where a live service
 * worker answers (`chrome.runtime.sendMessage`), so the Chrome harness
 * registers a slightly larger graph than the Gecko harness does. What actually
 * matters is that each lane EXECUTES every test it registered, and each harness
 * already asserts exactly that for itself before writing a summary. Comparing
 * the two totals would only encode a coincidence as a rule.
 */
export const laneCountProblem = (
  lanes: { file: string; badge: ShieldsBadge }[],
): string | null => {
  for (const lane of lanes) {
    const { passed, total } = badgeCounts(lane.badge);
    if (total < 1) return `${lane.file} advertises an empty test graph`;
    if (passed > total) {
      return `${lane.file} advertises ${passed} passing out of ${total} tests`;
    }
  }
  return null;
};

/** Write one Shields endpoint under badges/ and return its repo path. */
export const writeBadge = (fileName: string, badge: ShieldsBadge): string => {
  const outDir = join(REPO_ROOT, 'badges');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, fileName), `${JSON.stringify(badge, null, 2)}\n`);
  return `badges/${fileName}`;
};

/**
 * Run a harness to completion and return what it recorded.
 *
 * stdio is inherited on purpose: these lanes take minutes and their own
 * diagnostics (failing test names, shard progress) are what a red CI log is
 * read for. The badge is a by-product of the run, never a replacement for it.
 */
export const runLane = (
  label: string,
  argv: string[],
  readSummary: (scratch: string) => string,
): string => {
  const scratch = mkdtempSync(join(tmpdir(), 'peerd-test-badge-'));
  try {
    const run = spawnSync(process.execPath, argv, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: 'inherit',
      env: { ...process.env, [SUMMARY_ENV]: join(scratch, 'summary.json') },
    });
    if (run.status !== 0) {
      throw new Error(`${label} exited with status ${run.status ?? 'unknown'}`);
    }
    return readSummary(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

/** The default reader: the summary file the lane's harness just wrote. */
export const summaryFile = (scratch: string): string => readFileSync(join(scratch, 'summary.json'), 'utf8');
