#!/usr/bin/env bun
// Run every side-panel E2E scenario in sequence (each spawns its own Chrome for
// Testing), with a small per-scenario retry for headless-Chrome / CDP-attach
// startup flake. Exit 0 only if all scenarios pass. Used by `bun run
// test:e2e:all` and by CI — one place to register a new scenario.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SCENARIOS = [
  'run-e2e-sidepanel.mjs', // the single-turn smoke
  'run-e2e-goal.mjs',      // the goal-mode autonomous loop
  'run-e2e-stop.mjs',      // Stop a turn mid-flight
  'run-e2e-error.mjs',     // a provider error surfaces + idles
];

let failed = 0;
for (const scenario of SCENARIOS) {
  const path = join(here, scenario);
  let ok = false;
  for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
    if (attempt > 1) console.log(`::warning::e2e ${scenario} attempt ${attempt - 1} failed — retrying`);
    ok = spawnSync('bun', [path], { stdio: 'inherit', env: process.env }).status === 0;
  }
  if (!ok) { console.error(`[e2e] SCENARIO FAILED: ${scenario}`); failed += 1; }
}

console.log(`[e2e] suite: ${SCENARIOS.length - failed}/${SCENARIOS.length} scenarios passed`);
process.exit(failed ? 1 : 0);
