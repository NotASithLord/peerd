// Ralph panel formatting helpers — pure values-in/values-out, so they
// live on the bun surface (the Mithril component itself is covered by
// the in-browser tests at extension/tests/unit/sidepanel/).

import { describe, test, expect } from 'bun:test';
import {
  RALPH_ACTIVE_STATUSES,
  isRalphActive,
  ralphStatusLabel,
  formatElapsed,
  formatTaskProgress,
  describeRalphEvent,
  lastRalphNote,
} from '../../extension/sidepanel/components/ralph-format.js';

describe('ralph-format', () => {
  describe('isRalphActive', () => {
    test('planning/building/paused are active; terminals are not', () => {
      for (const s of RALPH_ACTIVE_STATUSES) expect(isRalphActive(s)).toBe(true);
      for (const s of ['idle', 'done', 'halted', 'error', undefined, '']) {
        expect(isRalphActive(s as any)).toBe(false);
      }
    });
  });

  describe('ralphStatusLabel', () => {
    test('maps every LoopState status to a human label', () => {
      expect(ralphStatusLabel('planning')).toBe('running · planning');
      expect(ralphStatusLabel('building')).toBe('running');
      expect(ralphStatusLabel('paused')).toBe('paused');
      expect(ralphStatusLabel('halted')).toBe('stopped');
      expect(ralphStatusLabel('done')).toBe('done');
      expect(ralphStatusLabel('error')).toBe('error');
      expect(ralphStatusLabel('idle')).toBe('idle');
    });

    test('passes unknown statuses through rather than lying', () => {
      expect(ralphStatusLabel('weird')).toBe('weird');
      expect(ralphStatusLabel(undefined)).toBe('unknown');
    });
  });

  describe('formatElapsed', () => {
    const t0 = 1_750_000_000_000;
    test('seconds, minutes+seconds, hours+minutes', () => {
      expect(formatElapsed(t0, t0 + 5_000)).toBe('5s');
      expect(formatElapsed(t0, t0 + 65_000)).toBe('1m 5s');
      expect(formatElapsed(t0, t0 + 59_000)).toBe('59s');
      expect(formatElapsed(t0, t0 + 3_600_000)).toBe('1h 0m');
      expect(formatElapsed(t0, t0 + 3_700_000 + 60_000)).toBe('1h 2m');
    });

    test('clamps negative (clock skew) to 0s', () => {
      expect(formatElapsed(t0, t0 - 10_000)).toBe('0s');
    });
  });

  describe('formatTaskProgress', () => {
    test('done/total with a blocked suffix only when blocked', () => {
      expect(formatTaskProgress({ total: 5, done: 2, blocked: 0 })).toBe('2/5 tasks');
      expect(formatTaskProgress({ total: 5, done: 2, blocked: 1 })).toBe('2/5 tasks · 1 blocked');
    });

    test('null when there is no plan yet', () => {
      expect(formatTaskProgress(null)).toBe(null);
      expect(formatTaskProgress({ total: 0, done: 0 })).toBe(null);
      expect(formatTaskProgress(undefined)).toBe(null);
    });
  });

  describe('describeRalphEvent', () => {
    test('narrates every loop event the driver emits', () => {
      expect(describeRalphEvent({ type: 'ralph/started' })).toBe('run started');
      expect(describeRalphEvent({ type: 'ralph/resumed', iteration: 4 })).toBe('resumed at iteration 4');
      expect(describeRalphEvent({ type: 'ralph/iteration', phase: 'planning' }))
        .toBe('planning pass — drafting the task plan');
      expect(describeRalphEvent({ type: 'ralph/iteration', phase: 'building', title: 'add tests' }))
        .toBe('working on: add tests');
      expect(describeRalphEvent({ type: 'ralph/gates', pass: true })).toBe('gates passed');
      expect(describeRalphEvent({ type: 'ralph/gates', pass: false })).toBe('gates failed');
      expect(describeRalphEvent({ type: 'ralph/committed', title: 'add tests' })).toBe('committed: add tests');
      expect(describeRalphEvent({ type: 'ralph/retry', reason: 'lint failed' })).toBe('retrying: lint failed');
      expect(describeRalphEvent({ type: 'ralph/blocked', reason: 'tests failed' })).toBe('task blocked: tests failed');
      expect(describeRalphEvent({ type: 'ralph/refused', reason: 'requires Act mode with confirmations off' }))
        .toBe('refused: requires Act mode with confirmations off');
      expect(describeRalphEvent({ type: 'ralph/done' })).toBe('plan complete');
      expect(describeRalphEvent({ type: 'ralph/halted' })).toBe('stopped');
      expect(describeRalphEvent({ type: 'ralph/error', error: 'boom' })).toBe('error: boom');
    });

    test('bookkeeping and garbage yield null (skipped by the panel)', () => {
      expect(describeRalphEvent({ type: 'ralph/state', state: {} })).toBe(null);
      expect(describeRalphEvent({ type: 'something/else' })).toBe(null);
      expect(describeRalphEvent(null as any)).toBe(null);
      expect(describeRalphEvent({} as any)).toBe(null);
    });
  });

  describe('lastRalphNote', () => {
    test('walks from the end, skipping non-narrative events', () => {
      const log = [
        { type: 'ralph/started' },
        { type: 'ralph/committed', title: 'task one' },
        { type: 'ralph/state', state: {} }, // bookkeeping — skipped
      ];
      expect(lastRalphNote(log)).toBe('committed: task one');
    });

    test('null on empty or non-array input', () => {
      expect(lastRalphNote([])).toBe(null);
      expect(lastRalphNote(null)).toBe(null);
      expect(lastRalphNote([{ type: 'ralph/state' }])).toBe(null);
    });
  });
});
