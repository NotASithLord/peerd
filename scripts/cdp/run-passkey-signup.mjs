#!/usr/bin/env bun
// Keep the package.json command stable while the importable lane owns the
// deterministic contract and physical implementation.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import {
  REPORT_PATH, runPackagedPasskeySignup,
} from './passkey-signup-lane.mjs';

const options = {
  ...(process.env.PEERD_ACCEPTANCE_SOURCE_ROOT
    ? { sourceRoot: resolve(process.env.PEERD_ACCEPTANCE_SOURCE_ROOT) } : {}),
  ...(process.env.PEERD_ACCEPTANCE_ARTIFACT_ROOT
    ? { artifactRoot: resolve(process.env.PEERD_ACCEPTANCE_ARTIFACT_ROOT) } : {}),
  ...(process.env.PEERD_ACCEPTANCE_REPORT_PATH
    ? { reportPath: resolve(process.env.PEERD_ACCEPTANCE_REPORT_PATH) } : {}),
};
const reportPath = options.reportPath
  ?? (options.artifactRoot
    ? join(options.artifactRoot, 'e2e', 'passkey-signup-report.json')
    : REPORT_PATH);
const failurePath = join(dirname(reportPath), 'passkey-signup-failure.json');

runPackagedPasskeySignup({ ...options, reportPath }).then((report) => {
  console.log(JSON.stringify(report, null, 2));
}).catch((error) => {
  mkdirSync(dirname(failurePath), { recursive: true });
  const failure = {
    schema: 3,
    ok: false,
    at: new Date().toISOString(),
    error: error?.stack || String(error),
    evidence: error?.passkeyEvidence ?? null,
  };
  writeFileSync(failurePath, `${JSON.stringify(failure, null, 2)}\n`);
  console.error('[passkey-signup]', failure.error);
  console.error(`[passkey-signup] failure evidence: ${resolve(failurePath)}`);
  process.exit(1);
});
