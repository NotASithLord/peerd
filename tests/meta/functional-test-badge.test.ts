import { describe, expect, test } from 'bun:test';
import {
  failedFunctionalTests, functionalTestBadge, parseFunctionalTestReport,
} from '../../packaging/gen-functional-test-badge.ts';

describe('functional test badge', () => {
  test('reads only the top-level Bun JUnit aggregate', () => {
    const report = `<?xml version="1.0"?>
      <testsuites tests="12" failures="1" errors="1" skipped="2">
        <testsuite tests="12" failures="1" skipped="2">
          <testsuite tests="5" failures="1" skipped="1"></testsuite>
        </testsuite>
      </testsuites>`;
    expect(parseFunctionalTestReport(report)).toEqual({
      passed: 8, total: 12, failures: 2, skipped: 2,
    });
  });

  test('renders an x/x passing Shields endpoint for a green suite', () => {
    expect(functionalTestBadge({ passed: 42, total: 42, failures: 0, skipped: 0 })).toEqual({
      schemaVersion: 1,
      label: 'Functional Tests',
      message: '42/42 passing',
      color: 'brightgreen',
    });
  });

  test('names failed cases without echoing the full suite log', () => {
    const report = `<testsuites tests="2" failures="1" skipped="0">
      <testsuite><testcase name="green" />
      <testcase name="red"><failure message="nope" /></testcase></testsuite>
    </testsuites>`;
    expect(failedFunctionalTests(report)).toEqual(['red']);
  });
});
