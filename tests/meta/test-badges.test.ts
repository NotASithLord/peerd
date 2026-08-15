import { describe, expect, test } from 'bun:test';
import {
  badgeCounts, e2eBadge, laneCountProblem, parseE2eReport,
  parseSuiteSummary, redTeamBadge, suiteBadge, tallyRedTeam,
} from '../../packaging/test-badges.ts';

const summary = (fields: Record<string, unknown>) => JSON.stringify({
  lane: 'inbrowser-chrome', passed: 938, failed: 0, total: 938, ms: 21_579, ...fields,
});

describe('browser lane test badges', () => {
  test('reads a whole-graph run', () => {
    expect(parseSuiteSummary(summary({}))).toEqual({ passed: 938, failed: 0, total: 938 });
  });

  test('refuses a run that covered only part of the graph', () => {
    // A single Gecko shard: honest counts, but badging them would advertise
    // one eighth of the suite as the whole suite.
    expect(() => parseSuiteSummary(summary({ passed: 117, total: 938 })))
      .toThrow(/117 of 938 registered tests/);
  });

  test('counts a failure against the run rather than shrinking the graph', () => {
    expect(parseSuiteSummary(summary({ passed: 930, failed: 8 })))
      .toEqual({ passed: 930, failed: 8, total: 938 });
  });

  test('refuses counts that are not whole numbers, and empty graphs', () => {
    expect(() => parseSuiteSummary(summary({ passed: 3.5 }))).toThrow(/"passed"/);
    expect(() => parseSuiteSummary(summary({ passed: -1, total: -1 }))).toThrow(/"passed"/);
    expect(() => parseSuiteSummary(summary({ passed: 0, failed: 0, total: 0 })))
      .toThrow(/empty test graph/);
  });

  test('renders x/x passing, red as soon as anything failed', () => {
    expect(suiteBadge('In-Browser (Chrome)', { passed: 938, failed: 0, total: 938 })).toEqual({
      schemaVersion: 1,
      label: 'In-Browser (Chrome)',
      message: '938/938 passing',
      color: 'brightgreen',
    });
    expect(suiteBadge('In-Browser (Gecko)', { passed: 930, failed: 8, total: 938 }).color)
      .toBe('red');
  });

  test('wears the lane engine mark when one is named', () => {
    const chrome = suiteBadge('In-Browser (Chrome)', {
      passed: 1, failed: 0, total: 1,
    }, 'googlechrome');
    expect(chrome.namedLogo).toBe('googlechrome');
    // Monochrome on the dark label half; brand color would muddy at badge scale.
    expect(chrome.logoColor).toBe('white');
    expect(suiteBadge('x', { passed: 1, failed: 0, total: 1 }).namedLogo).toBeUndefined();
  });
});

describe('E2E lane badge', () => {
  const report = (fields: Record<string, unknown>) => JSON.stringify({
    ok: true,
    summary: { states: 41, checksTotal: 306, checksFailed: 0, visualMoved: 0, ...fields },
  });

  test('reports passing checks alongside the states driven', () => {
    expect(parseE2eReport(report({}))).toEqual({ states: 41, checksPassed: 306, checksTotal: 306 });
    expect(e2eBadge('E2E (side panel)', parseE2eReport(report({})))).toEqual({
      schemaVersion: 1,
      label: 'E2E (side panel)',
      message: '306/306 checks, 41 states',
      color: 'brightgreen',
    });
  });

  test('subtracts failed checks and goes red', () => {
    const badge = e2eBadge('E2E (side panel)', parseE2eReport(report({ checksFailed: 1 })));
    expect(badge.message).toBe('305/306 checks, 41 states');
    expect(badge.color).toBe('red');
  });

  test('refuses a report that drove nothing or counts more failures than checks', () => {
    expect(() => parseE2eReport(report({ states: 0 }))).toThrow(/drove no states/);
    expect(() => parseE2eReport(report({ checksFailed: 400 })))
      .toThrow(/failed more checks than it ran/);
  });
});

describe('red team badge', () => {
  const scenario = (probes: boolean[]) => ({
    result: { held: probes.every(Boolean), probes: probes.map((blocked) => ({ blocked })) },
  });

  test('counts probes across scenarios, not just scenarios', () => {
    expect(tallyRedTeam([scenario([true, true, true]), scenario([true, true])])).toEqual({
      scenarios: 2, scenariosHeld: 2, probes: 5, probesBlocked: 5,
    });
  });

  test('renders both numbers and goes red on a single leaked probe', () => {
    const green = redTeamBadge('Red Team', tallyRedTeam([scenario([true, true])]), 'bun');
    expect(green.message).toBe('2/2 probes, 1/1 scenarios');
    expect(green.color).toBe('brightgreen');
    expect(green.namedLogo).toBe('bun');

    const leaked = redTeamBadge('Red Team', tallyRedTeam([scenario([true, false])]));
    expect(leaked.message).toBe('1/2 probes, 0/1 scenarios');
    expect(leaked.color).toBe('red');
  });

  test('refuses a catalog that ran nothing', () => {
    expect(() => tallyRedTeam([])).toThrow(/ran no scenarios/);
    expect(() => tallyRedTeam([scenario([])])).toThrow(/recorded no probes/);
  });
});

describe('lane count coherence', () => {
  const lane = (file: string, message: string) => ({
    file, badge: { schemaVersion: 1 as const, label: file, message, color: 'brightgreen' },
  });

  test('lets the two in-browser lanes carry different totals', () => {
    // Not a coincidence to police: a few tests register only where a live
    // service worker answers, so Chrome registers a larger graph than Gecko.
    expect(laneCountProblem([
      lane('badges/inbrowser-chrome.json', '938/938 passing'),
      lane('badges/inbrowser-gecko.json', '932/932 passing'),
    ])).toBeNull();
  });

  test('rejects a badge claiming more passes than tests, or an empty graph', () => {
    expect(laneCountProblem([lane('badges/inbrowser-gecko.json', '940/932 passing')]))
      .toMatch(/advertises 940 passing out of 932/);
    expect(laneCountProblem([lane('badges/inbrowser-chrome.json', '0/0 passing')]))
      .toMatch(/empty test graph/);
  });

  test('rejects a message that is not a lane count', () => {
    expect(() => badgeCounts({
      schemaVersion: 1, label: 'types', message: '99.7% // @ts-check', color: 'green',
    })).toThrow(/not a lane badge message/);
  });
});
