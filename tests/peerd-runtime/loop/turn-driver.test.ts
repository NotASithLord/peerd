// turn-driver — the agent turn driver extracted from the service worker.
// These tests exist BECAUSE of the extraction: maybeAutoResume's guard logic
// was previously unreachable without a real browser (it lived inline in the SW
// closure). Now it's a factory of injected deps, so the early-return gates can
// be exercised with fakes — values in, behavior out.
//
// We test only the guard paths that bail BEFORE runAgentTurn (setting off,
// no session, vault locked, session busy, not-resumable); the resume path
// itself drives a full turn and belongs to the e2e harness.

import { test, expect } from 'bun:test';
import { makeTurnDriver } from '/peerd-runtime/loop/turn-driver.js';

/** Minimal deps maybeAutoResume touches; the rest stay undefined (never invoked). */
const deps = (/** @type {any} */ over: any = {}) => ({
  settingsStore: { get: () => ({ autoResumeInterruptedTurns: true }) },
  vault: { isLocked: () => false },
  turnSlots: { isBusy: () => false },
  sessions: { get: async () => ({ sessionId: 's1' }) },
  detectInterruptedTurn: () => ({ resumable: false }),
  auditLog: { append: async () => {} },
  postChatNote: () => {},
  ...over,
});

test('makeTurnDriver returns the two entry points', () => {
  const d = makeTurnDriver(deps());
  expect(typeof d.runAgentTurn).toBe('function');
  expect(typeof d.maybeAutoResume).toBe('function');
});

test('maybeAutoResume no-ops when the setting is off (never reads the session)', async () => {
  let read = false;
  const d = makeTurnDriver(deps({
    settingsStore: { get: () => ({ autoResumeInterruptedTurns: false }) },
    sessions: { get: async () => { read = true; return {}; } },
  }));
  await d.maybeAutoResume('s1');
  expect(read).toBe(false);
});

test('maybeAutoResume no-ops on a null sessionId', async () => {
  let read = false;
  const d = makeTurnDriver(deps({ sessions: { get: async () => { read = true; return {}; } } }));
  await d.maybeAutoResume(null);
  expect(read).toBe(false);
});

test('maybeAutoResume no-ops when the vault is locked', async () => {
  let read = false;
  const d = makeTurnDriver(deps({
    vault: { isLocked: () => true },
    sessions: { get: async () => { read = true; return {}; } },
  }));
  await d.maybeAutoResume('s1');
  expect(read).toBe(false);
});

test('maybeAutoResume no-ops when the session is already streaming', async () => {
  let read = false;
  const d = makeTurnDriver(deps({
    turnSlots: { isBusy: () => true },
    sessions: { get: async () => { read = true; return {}; } },
  }));
  await d.maybeAutoResume('s1');
  expect(read).toBe(false);
});

test('maybeAutoResume no-ops when a Goal run owns the session (no double-drive)', async () => {
  let read = false;
  const d = makeTurnDriver(deps({
    // The goal loop re-drives its own interrupted turn on resume; auto-resume
    // must bail BEFORE reading the session so the two can't contend the slot.
    goalActiveFor: (sid: string) => sid === 's1',
    sessions: { get: async () => { read = true; return {}; } },
  }));
  await d.maybeAutoResume('s1');
  expect(read).toBe(false);
});

test('maybeAutoResume does not resume a turn that is not resumable', async () => {
  let noted = false;
  const d = makeTurnDriver(deps({
    detectInterruptedTurn: () => ({ resumable: false }),
    postChatNote: () => { noted = true; },
  }));
  await d.maybeAutoResume('s1');
  // The "Resuming…" note fires only on the resume path — its absence proves
  // the guard bailed before runAgentTurn was entered.
  expect(noted).toBe(false);
});
