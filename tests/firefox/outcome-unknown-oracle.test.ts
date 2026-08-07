import { describe, expect, test } from 'bun:test';
import {
  advisesCheckingBeforeRetry,
  hasAmbiguousOutcomeWarning,
  hasOutcomeUnknownState,
} from '../../scripts/firefox/outcome-unknown-oracle.mjs';

describe('Firefox unknown-outcome runtime oracle', () => {
  test('keys routing to the durable lifecycle state instead of prose', () => {
    expect(hasOutcomeUnknownState('outcome_unknown: details')).toBe(true);
    expect(hasOutcomeUnknownState(JSON.stringify({ content: 'outcome_unknown: details' }))).toBe(true);
    expect(hasOutcomeUnknownState('This action may have completed.')).toBe(false);
  });

  test.each([
    'This action may have completed, but peerd did not receive confirmation.',
    'peerd cannot confirm whether the actor ran or completed.',
    'The actor did not complete cleanly. Its outcome is unknown.',
  ])('recognizes ambiguous-outcome warning semantics: %s', (message) => {
    expect(hasAmbiguousOutcomeWarning(message)).toBe(true);
  });

  test.each([
    'Check the target before repeating it.',
    'Check the requested action before trying again.',
    'Verify the external state before retrying.',
  ])('recognizes the recovery action without pinning one sentence: %s', (message) => {
    expect(advisesCheckingBeforeRetry(message)).toBe(true);
  });

  test('does not mistake a definite not-run result for an ambiguous outcome', () => {
    const message = 'This operation was not run. It is safe to retry.';
    expect(hasOutcomeUnknownState(message)).toBe(false);
    expect(hasAmbiguousOutcomeWarning(message)).toBe(false);
    expect(advisesCheckingBeforeRetry(message)).toBe(false);
  });
});
