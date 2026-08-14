// Generate badges/functional-tests.json from the same Bun test run that gates
// main. The committed Shields endpoint is drift-checked in CI, so its x/x is
// evidence from the suite rather than a hand-maintained test inventory.

import { spawnSync } from 'node:child_process';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from './lib.ts';

export interface FunctionalTestTotals {
  passed: number;
  total: number;
  failures: number;
  skipped: number;
}

const integerAttribute = (attributes: string, name: string): number => {
  const match = attributes.match(new RegExp(`\\b${name}="(\\d+)"`));
  return match ? Number(match[1]) : 0;
};

/** Read Bun's top-level JUnit aggregate without double-counting nested suites. */
export const parseFunctionalTestReport = (xml: string): FunctionalTestTotals => {
  const root = xml.match(/<testsuites\b([^>]*)>/);
  if (!root) throw new Error('Bun JUnit report has no <testsuites> aggregate');
  const total = integerAttribute(root[1], 'tests');
  const failures = integerAttribute(root[1], 'failures') + integerAttribute(root[1], 'errors');
  const skipped = integerAttribute(root[1], 'skipped');
  const passed = total - failures - skipped;
  if (total < 1 || passed < 0) throw new Error('Bun JUnit report has invalid aggregate counts');
  return { passed, total, failures, skipped };
};

export const functionalTestBadge = (totals: FunctionalTestTotals) => ({
  schemaVersion: 1,
  label: 'Functional Tests',
  message: `${totals.passed}/${totals.total} passing`,
  color: totals.passed === totals.total ? 'brightgreen' : 'red',
});

export const failedFunctionalTests = (xml: string): string[] => {
  const failed: string[] = [];
  for (const testCase of xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g)) {
    if (!/<(?:failure|error)\b/.test(testCase[2] ?? '')) continue;
    const name = testCase[1].match(/\bname="([^"]+)"/)?.[1];
    if (name) failed.push(name);
  }
  return failed;
};

const generate = () => {
  const scratch = mkdtempSync(join(tmpdir(), 'peerd-functional-tests-'));
  const junitPath = join(scratch, 'results.xml');
  try {
    const run = spawnSync(process.execPath, [
      'test', './tests', '--timeout', '15000', '--reporter=junit',
      `--reporter-outfile=${junitPath}`,
    ], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
    });
    if (run.status !== 0) {
      try {
        const report = readFileSync(junitPath, 'utf8');
        const totals = parseFunctionalTestReport(report);
        console.error(`functional tests: ${totals.passed}/${totals.total} passed`);
        for (const name of failedFunctionalTests(report)) console.error(`failed: ${name}`);
      } catch { /* the exit itself remains the authoritative failure */ }
      throw new Error(`functional test suite exited with status ${run.status ?? 'unknown'}`);
    }
    const totals = parseFunctionalTestReport(readFileSync(junitPath, 'utf8'));
    const badge = functionalTestBadge(totals);
    const outDir = join(REPO_ROOT, 'badges');
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'functional-tests.json'), `${JSON.stringify(badge, null, 2)}\n`);
    console.log(`wrote badges/functional-tests.json - ${badge.message}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

if (import.meta.main) generate();
