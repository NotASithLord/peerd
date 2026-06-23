import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The goal-run connect-time replay (#3/#4) lives in service-worker.js's
// onConnect handler, which can't be imported under bun (no chrome/browser
// globals) — so, like offscreen-gate.test.ts, assert against the SOURCE TEXT.
// The behavioral half (WHAT activeStates() returns) is pinned in
// goal-runner.test.ts; this pins that onConnect actually REPLAYS it to the
// freshly-connected port, mirroring the pendingConfirm replay right above it.
// Without the replay, a panel that reopened (or reconnected after an SW
// respawn) shows no Goal bar / Stop for a run still driving — reverting the
// onConnect loop fails the assertions here.
const src = readFileSync(
  join(import.meta.dir, '../../extension/background/service-worker.js'),
  'utf8',
);

describe('service worker — goal-run replay on port (re)connect (#3/#4)', () => {
  test('onConnect replays every live goal run to the fresh surface', () => {
    expect(src).toMatch(/goalRunner\?\.activeStates\?\.\(\)/);
    // the replay posts each active-run event to THIS port (not a broadcast)
    expect(src).toMatch(/for \(const ev of \(goalRunner\?\.activeStates[\s\S]{0,160}?port\.postMessage\(ev\)/);
  });
});
