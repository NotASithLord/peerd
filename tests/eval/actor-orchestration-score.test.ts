import { describe, expect, test } from 'bun:test';
import {
  ACTOR_ORCHESTRATION_SCENARIOS, decideActorMessagingContract,
  MIN_MODEL_REPETITIONS, protocolSmokeRows,
} from '../../extension/eval/actor-orchestration-score.js';

const qualifiedRows = () => {
  const smoke = protocolSmokeRows();
  const expand = (rows: typeof smoke.messageRows) => rows.flatMap((row) =>
    Array.from({ length: MIN_MODEL_REPETITIONS }, (_, index) => ({
      ...row,
      pairId: `${row.scenario}-${index}`,
      tokens: row.turns * 100,
      elapsedMs: row.turns * 250,
    })));
  return {
    evidence: {
      provider: 'fixture-provider', model: 'fixture-model',
      promptRevision: 'abc123', repetitions: MIN_MODEL_REPETITIONS,
    },
    messageRows: expand(smoke.messageRows),
    codeRows: expand(smoke.codeRows),
  };
};

describe('actor orchestration paired decision', () => {
  test('protocol smoke covers the full matrix but cannot authorize removal', () => {
    const rows = protocolSmokeRows();
    expect(rows.messageRows.map((row) => row.scenario)).toEqual([...ACTOR_ORCHESTRATION_SCENARIOS]);
    expect(rows.codeRows.map((row) => row.scenario)).toEqual([...ACTOR_ORCHESTRATION_SCENARIOS]);
    const result = decideActorMessagingContract({ evidenceKind: 'protocol-smoke', ...rows });
    expect(result.removable).toBe(false);
    expect(result.evidenceQualified).toBe(false);
    expect(result.decision).toBe('retain-message-actor-scalar-shortcut');
    expect(result.observed.compoundTurnReduction).toBeGreaterThanOrEqual(0.2);
  });

  test('model evidence removes only when reliability is noninferior and compound turns improve', () => {
    const rows = qualifiedRows();
    expect(decideActorMessagingContract({ evidenceKind: 'model', ...rows }).removable).toBe(true);
    rows.codeRows[0].success = false;
    expect(decideActorMessagingContract({ evidenceKind: 'model', ...rows }).removable).toBe(false);
  });

  test('an incomplete paired matrix fails closed', () => {
    const rows = qualifiedRows();
    rows.codeRows.pop();
    const result = decideActorMessagingContract({ evidenceKind: 'model', ...rows });
    expect(result.removable).toBe(false);
    expect(result.reason).toContain('total row count');
  });

  test('undeclared padding cannot poison the aggregate used by the removal rule', () => {
    const rows = qualifiedRows();
    for (const row of rows.codeRows.filter((candidate) => candidate.scenario === 'parallel')) {
      row.success = false;
    }
    expect(decideActorMessagingContract({ evidenceKind: 'model', ...rows }).removable).toBe(false);

    // If qualification checked only the declared per-scenario subsets, enough
    // failing padding on the message arm could make the worse code arm look
    // noninferior because aggregation consumes every row.
    rows.messageRows.push(...Array.from({ length: 100 }, (_, index) => ({
      scenario: `padding-${index}`,
      success: false,
      turns: 5,
      tokens: 500,
      elapsedMs: 1_000,
      innerOps: 1,
      recovered: null,
      pairId: `padding-${index}`,
    })));
    const padded = decideActorMessagingContract({ evidenceKind: 'model', ...rows });
    expect(padded.removable).toBe(false);
    expect(padded.evidenceQualified).toBe(false);
    expect(padded.reason).toContain('undeclared scenario');
  });

  test('recovery fields are valid only on the partial-failure scenario', () => {
    const rows = qualifiedRows();
    for (const row of rows.codeRows.filter((candidate) => candidate.scenario === 'retry-partial-failure')) {
      row.recovered = false;
    }
    expect(decideActorMessagingContract({ evidenceKind: 'model', ...rows }).removable).toBe(false);

    // Meaningless recovery flags on easier scenarios must neither qualify nor
    // poison the aggregate that the contract decision reports.
    for (const row of rows.messageRows.filter((candidate) => candidate.scenario !== 'retry-partial-failure')) {
      row.recovered = false;
    }
    for (const row of rows.codeRows.filter((candidate) => candidate.scenario !== 'retry-partial-failure')) {
      row.recovered = true;
    }
    const poisoned = decideActorMessagingContract({ evidenceKind: 'model', ...rows });
    expect(poisoned.evidenceQualified).toBe(false);
    expect(poisoned.removable).toBe(false);
    expect(poisoned.observed.message.recoveryRate).toBe(1);
    expect(poisoned.observed.code.recoveryRate).toBe(0);
  });

  test('protocol rows cannot be relabeled model evidence without real metrics and provenance', () => {
    const rows = protocolSmokeRows();
    const result = decideActorMessagingContract({ evidenceKind: 'model', ...rows });
    expect(result.removable).toBe(false);
    expect(result.evidenceQualified).toBe(false);
    expect(result.reason).toContain('provenance');
  });
});
