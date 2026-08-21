// Multi-profile physical floor for the native, unbundled authority kernel.
// One immutable packaged tree is launched in independent fresh Chrome profiles;
// every sample performs the real PRF ceremony and durable vault commit.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ARTIFACTS_DIR } from '../../packaging/lib.ts';
import { buildVaultKernelArtifact } from './vault-kernel-artifact.mjs';
import { runVaultKernelPasskeyFloor } from './run-vault-kernel-passkey.mjs';

const REPORT_PATH = join(ARTIFACTS_DIR, 'performance', 'vault-kernel-passkey-floor.json');
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const quantile = (values, percentile) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(percentile * sorted.length) - 1)];
};

export async function benchVaultKernelPasskey({ samples = 7 } = {}) {
  if (!Number.isInteger(samples) || samples < 3 || samples > 15) {
    throw new TypeError('vault-kernel-floor-samples-invalid');
  }
  const artifact = await buildVaultKernelArtifact({ browser: 'chrome' });
  const archiveBefore = sha256(artifact.artifact);
  const runs = [];
  for (let sample = 0; sample < samples; sample += 1) {
    const report = await runVaultKernelPasskeyFloor({ artifact, writeReport: false });
    runs.push(Object.freeze({
      sample: sample + 1,
      ...report.timings,
      workerTimingDiagnostic: report.observations.workerTimingDiagnostic,
    }));
  }
  const archiveAfter = sha256(artifact.artifact);
  if (archiveAfter !== archiveBefore || archiveAfter !== artifact.sha256) {
    throw new Error('vault-kernel-floor-artifact-mutated');
  }
  const cta = runs.map((run) => run.ctaEnabledMs);
  const durable = runs.map((run) => run.durableVaultCommitMs);
  const report = Object.freeze({
    schema: 1,
    ok: true,
    claim: 'test-only-packaged-native-kernel-multi-profile-floor',
    samples,
    artifact: Object.freeze({
      sha256: archiveAfter,
      bytes: artifact.artifactBytes,
      graphModules: artifact.graphModules,
      graphBytes: artifact.graphBytes,
    }),
    summary: Object.freeze({
      ctaEnabledMs: Object.freeze({
        min: Math.min(...cta), median: quantile(cta, 0.5), p95: quantile(cta, 0.95),
      }),
      durableVaultCommitMs: Object.freeze({
        min: Math.min(...durable), median: quantile(durable, 0.5),
        p95: quantile(durable, 0.95),
      }),
    }),
    runs: Object.freeze(runs),
  });
  mkdirSync(join(ARTIFACTS_DIR, 'performance'), { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

if (import.meta.main) {
  const samples = Number(process.argv.find((value) => value.startsWith('--samples='))
    ?.split('=')[1] ?? 7);
  try { console.log(JSON.stringify(await benchVaultKernelPasskey({ samples }), null, 2)); }
  catch (error) { console.error(error?.stack ?? error); process.exitCode = 1; }
}
