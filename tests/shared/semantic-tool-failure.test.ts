import { describe, expect, test } from 'bun:test';
import { normalizeSemanticToolFailure } from '../../extension/shared/semantic-tool-failure.js';
import { semanticCallAuditEntry } from '../../extension/background/semantic-call-audit.js';

describe('semantic tool failure parity', () => {
  test('the same unstamped pre-effect throw is known and retryable on every semantic owner', () => {
    const failure = new Error('semantic fixture failed');
    const main = normalizeSemanticToolFailure(failure, { effectCount: 0 });
    const actor = normalizeSemanticToolFailure(failure, { effectCount: 0 });
    expect(main).toEqual(actor);
    expect(main).toMatchObject({
      error: 'semantic fixture failed', outcomeKnown: true, retryable: true,
    });
    expect(semanticCallAuditEntry({
      sessionId: 'main', callId: 'same-call', label: 'fixture_tool',
      result: { ok: false, is_error: true, ...main },
    })).toMatchObject({
      type: 'tool_failed', details: { outcome: 'semantic-failure', outcomeKnown: true },
    });
    expect(semanticCallAuditEntry({
      sessionId: 'actor', callId: 'same-call', label: 'fixture_tool',
      result: { ok: false, is_error: true, ...actor },
    })).toMatchObject({
      type: 'tool_failed', details: { outcome: 'semantic-failure', outcomeKnown: true },
    });
  });

  test('an unstamped throw after authority started is unknown and nonretryable', () => {
    expect(normalizeSemanticToolFailure(new Error('relay vanished'), { effectCount: 1 }))
      .toMatchObject({ outcomeKnown: false, retryable: false });
  });

  test('explicit host knowledge wins on either side of the effect boundary', () => {
    const known = Object.assign(new Error('known refusal'), {
      code: 'known-refusal', outcomeKnown: true, retryable: false,
    });
    expect(normalizeSemanticToolFailure(known, { effectCount: 1 })).toMatchObject({
      code: 'known-refusal', outcomeKnown: true, retryable: false,
    });
    const unknown = Object.assign(new Error('host lost'), { outcomeKnown: false });
    expect(normalizeSemanticToolFailure(unknown, { effectCount: 0 })).toMatchObject({
      outcomeKnown: false, retryable: false,
    });
  });
});
