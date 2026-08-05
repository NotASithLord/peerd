// Versioned stores + migration (§11) — forward-only, restart-safe,
// idempotent, refuse-newer fails read-only, failure preserves the original
// with a diagnostic id, undeclared field drops fail the run.

import { describe, test, expect } from 'bun:test';
import {
  classifyStoreVersion, guardStore, runMigration,
} from '../../../extension/peerd-runtime/lifecycle/store-version.js';

describe('classification', () => {
  test('the five classes', () => {
    expect(classifyStoreVersion({ found: 3, supported: 3 })).toBe('current');
    expect(classifyStoreVersion({ found: 2, supported: 3 })).toBe('migratable');
    expect(classifyStoreVersion({ found: 4, supported: 3 })).toBe('newer');
    expect(classifyStoreVersion({ found: 1, supported: 3, oldestMigratable: 2 })).toBe('unsupported');
    expect(classifyStoreVersion({ found: 'v3' as any, supported: 3 })).toBe('malformed');
    expect(classifyStoreVersion({ found: -1, supported: 3 })).toBe('malformed');
  });
});

describe('the downgrade contract: newer schemas fail read-only', () => {
  test('a newer profile is refused for mutation, never reinterpreted as empty or corrupt', () => {
    const guard = guardStore({ store: 'sessions', found: 9, supported: 3 });
    expect(guard.mode).toBe('read-only');
    expect(guard.versionClass).toBe('newer');
    expect(guard.reason).toContain('newer than this peerd supports');
    expect(guard.diagnosticId).toBe('store-sessions-newer-v9');
  });

  test('malformed versions also fail closed with a diagnostic, original retained', () => {
    const guard = guardStore({ store: 'vault', found: undefined, supported: 2 });
    expect(guard.mode).toBe('read-only');
    expect(guard.diagnosticId).toBe('store-vault-malformed-version');
  });

  test('current and migratable open normally', () => {
    expect(guardStore({ store: 's', found: 2, supported: 2 }).mode).toBe('read-write');
    expect(guardStore({ store: 's', found: 1, supported: 2 }).mode).toBe('migrate');
  });
});

const steps = [
  {
    from: 1, to: 2, drops: ['old'],
    migrate: (d: Record<string, unknown>) => { const { old, ...rest } = d; return { ...rest, renamed: old }; },
  },
  {
    from: 2, to: 3, drops: ['legacy'],
    migrate: (d: Record<string, unknown>) => { const { legacy, ...rest } = d; return { ...rest, count: 0 }; },
  },
];

describe('runMigration — the happy chain', () => {
  test('runs forward, preserves unknown fields, stamps only on success', () => {
    const result = runMigration({
      store: 'sessions',
      data: { old: 'x', legacy: true, mystery: 'keep-me' },
      fromVersion: 1, toVersion: 3, steps,
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.version).toBe(3);
    expect(result.data.mystery).toBe('keep-me'); // unknown field survived
    expect(result.data.renamed).toBe('x');
    expect(result.completedSteps).toEqual([2, 3]);
  });

  test('already-current input is a no-op success (idempotent rerun)', () => {
    const result = runMigration({
      store: 'sessions', data: { a: 1 }, fromVersion: 3, toVersion: 3, steps,
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.version).toBe(3);
    expect(result.data).toEqual({ a: 1 });
  });

  test('restart-safety: a checkpoint resumes past completed steps', () => {
    // The v1→v2 step already ran before the interruption; the rerun must
    // skip it (rerunning it would misread already-migrated data).
    const result = runMigration({
      store: 'sessions',
      data: { renamed: 'x', legacy: true, mystery: 'keep-me' },
      fromVersion: 1, toVersion: 3, steps, checkpointVersion: 2,
    });
    if (!result.ok) throw new Error(result.reason);
    expect(result.completedSteps).toEqual([3]);
    expect(result.data.renamed).toBe('x');
    expect(result.data.mystery).toBe('keep-me');
  });
});

describe('runMigration — failure preserves the original', () => {
  const original = { old: 'x', legacy: true };

  test('a throwing step returns the ORIGINAL data and a deterministic diagnostic', () => {
    const result = runMigration({
      store: 'skills', data: original, fromVersion: 1, toVersion: 3,
      steps: [{ from: 1, to: 2, migrate: () => { throw new Error('boom'); } }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.data).toEqual(original);
    expect(result.diagnosticId).toBe('migrate-skills-step-v1-threw');
    expect(result.failedStep).toEqual({ from: 1, to: 2 });
  });

  test('an undeclared field drop fails the run — silent discard is structurally impossible', () => {
    const result = runMigration({
      store: 'memory', data: { keep: 1, quietly_dropped: 2 },
      fromVersion: 1, toVersion: 2,
      steps: [{ from: 1, to: 2, migrate: ({ keep }) => ({ keep }) }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnosticId).toBe('migrate-memory-step-v1-dropped-quietly_dropped');
    expect(result.data).toEqual({ keep: 1, quietly_dropped: 2 });
  });

  test('setting a key to undefined is a drop too — it would vanish at the persistence layer', () => {
    const result = runMigration({
      store: 'memory', data: { keep: 1, erased: 2 },
      fromVersion: 1, toVersion: 2,
      steps: [{ from: 1, to: 2, migrate: (d: Record<string, unknown>) => ({ ...d, erased: undefined }) }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnosticId).toBe('migrate-memory-step-v1-dropped-erased');
  });

  test('a step mutating a NESTED object cannot corrupt the caller\'s original', () => {
    const data = { settings: { theme: 'dark' } };
    const result = runMigration({
      store: 'settings', data, fromVersion: 1, toVersion: 2,
      steps: [{
        from: 1, to: 2,
        migrate: (d: Record<string, unknown>) => {
          (d.settings as Record<string, unknown>).theme = 'CLOBBERED';
          throw new Error('boom after mutation');
        },
      }],
    });
    expect(result.ok).toBe(false);
    expect(data.settings.theme).toBe('dark'); // original untouched at depth
  });

  test('a malformed checkpoint fails closed instead of re-running or NaN-ing the cursor', () => {
    const result = runMigration({
      store: 's', data: { a: 1 }, fromVersion: 1, toVersion: 3, steps,
      checkpointVersion: Number.NaN,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnosticId).toBe('migrate-s-malformed-checkpoint');
    expect(result.resumeFrom).toBe(1);
  });

  test('downgrade is refused', () => {
    const result = runMigration({
      store: 'audit', data: original, fromVersion: 5, toVersion: 3, steps,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.diagnosticId).toBe('migrate-audit-downgrade-v5');
  });

  test('backward or gapped chains are refused', () => {
    const backward = runMigration({
      store: 's', data: original, fromVersion: 1, toVersion: 2,
      steps: [{ from: 2, to: 1, migrate: (d: Record<string, unknown>) => d }],
    });
    expect(backward.ok).toBe(false);

    const gapped = runMigration({
      store: 's', data: original, fromVersion: 1, toVersion: 3,
      steps: [{ from: 2, to: 3, migrate: (d: Record<string, unknown>) => d }],
    });
    expect(gapped.ok).toBe(false);
    if (gapped.ok) return;
    expect(gapped.reason).toContain('no migration step from v1');
  });

  test('malformed payloads and versions fail closed, data untouched', () => {
    for (const data of [null, 'string', 42, ['array']]) {
      const result = runMigration({
        store: 's', data, fromVersion: 1, toVersion: 2, steps,
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.data).toBe(data);
    }
    const badVersion = runMigration({
      store: 's', data: {}, fromVersion: '1' as any, toVersion: 2, steps,
    });
    expect(badVersion.ok).toBe(false);
  });

  test('a step returning a non-record fails, original retained', () => {
    const result = runMigration({
      store: 's', data: original, fromVersion: 1, toVersion: 2,
      steps: [{ from: 1, to: 2, migrate: () => null as any }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.data).toEqual(original);
  });
});
