// Prewalk policy core (extension/peerd-runtime/loop/prewalk.js).
// Pins: executor resolution (pin → provider fast default → nothing), arming
// (no-op when the executor IS the chat model), the swap gate's exact firing
// conditions (planning phase + committed todos + a successful non-exempt
// mutating call), and the planning→executing transition.

import { describe, test, expect } from 'bun:test';
import {
  resolvePrewalkExecutor, armPrewalk, shouldPrewalkSwap, markPrewalkSwapped,
  PREWALK_EXEMPT_TOOLS, PREWALK_NUDGE,
  ENGINE_ACTOR_KINDS, isEngineActorKind, shouldEngineActorSwap,
} from '../../extension/peerd-runtime/loop/prewalk.js';

const anthropic = { name: 'anthropic', defaultRunnerModel: 'claude-haiku-4-5' };
const session = { provider: 'anthropic', model: 'claude-opus-4-8' };
const NOW = 1_752_600_000_000;

const armed = () => {
  const state = armPrewalk(session, { provider: 'anthropic', model: 'claude-haiku-4-5' }, NOW);
  if (!state) throw new Error('expected an armed state');
  return state;
};

describe('resolvePrewalkExecutor', () => {
  test('explicit pin wins; provider fast default is the fallback', () => {
    expect(resolvePrewalkExecutor({
      settings: { prewalkExecutorModel: 'claude-sonnet-5' }, provider: anthropic,
    })).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5' });
    expect(resolvePrewalkExecutor({ settings: { prewalkExecutorModel: '' }, provider: anthropic }))
      .toEqual({ provider: 'anthropic', model: 'claude-haiku-4-5' });
  });

  test('nothing usable → null (no provider, or no default and no pin)', () => {
    expect(resolvePrewalkExecutor({})).toBeNull();
    expect(resolvePrewalkExecutor({ provider: { name: 'ollama' } })).toBeNull();
  });
});

describe('armPrewalk', () => {
  test('captures planner + executor and opens in planning phase', () => {
    expect(armed()).toEqual({
      phase: 'planning',
      plannerProvider: 'anthropic', plannerModel: 'claude-opus-4-8',
      executorProvider: 'anthropic', executorModel: 'claude-haiku-4-5',
      armedAt: NOW,
    });
  });

  test('no-op when the executor IS the session model, or inputs are missing', () => {
    expect(armPrewalk({ provider: 'anthropic', model: 'claude-haiku-4-5' },
      { provider: 'anthropic', model: 'claude-haiku-4-5' }, NOW)).toBeNull();
    expect(armPrewalk(session, null, NOW)).toBeNull();
    expect(armPrewalk({}, { provider: 'anthropic', model: 'claude-haiku-4-5' }, NOW)).toBeNull();
  });
});

describe('shouldPrewalkSwap — the gate', () => {
  const base = { prewalk: armed(), todosCount: 3, toolName: 'message_actor', sideEffect: 'write', ok: true };

  test('fires on a successful mutating call once the plan is committed', () => {
    expect(shouldPrewalkSwap(base)).toBe(true);
    expect(shouldPrewalkSwap({ ...base, sideEffect: 'mutate_external', toolName: 'dweb_share' })).toBe(true);
    expect(shouldPrewalkSwap({ ...base, sideEffect: 'destructive', toolName: 'vm_delete' })).toBe(true);
  });

  test('holds while any condition is missing', () => {
    expect(shouldPrewalkSwap({ ...base, prewalk: null })).toBe(false);
    expect(shouldPrewalkSwap({ ...base, prewalk: markPrewalkSwapped(armed(), NOW) })).toBe(false); // already executing
    expect(shouldPrewalkSwap({ ...base, todosCount: 0 })).toBe(false);   // no committed plan yet
    expect(shouldPrewalkSwap({ ...base, ok: false })).toBe(false);       // the action FAILED — not evidence
    expect(shouldPrewalkSwap({ ...base, sideEffect: 'read' })).toBe(false);
    expect(shouldPrewalkSwap({ ...base, sideEffect: undefined })).toBe(false); // unknown tool — fail closed
  });

  test('recon/bookkeeping writes are exempt by name', () => {
    for (const name of ['open_tab', 'remember', 'actor_cancel', 'todo_init', 'complete_goal']) {
      expect(PREWALK_EXEMPT_TOOLS.has(name)).toBe(true);
      expect(shouldPrewalkSwap({ ...base, toolName: name, sideEffect: 'write' })).toBe(false);
    }
  });
});

describe('markPrewalkSwapped', () => {
  test('flips the phase, stamps the time, keeps the models', () => {
    const swapped = markPrewalkSwapped(armed(), NOW + 5);
    expect(swapped.phase).toBe('executing');
    expect(swapped.swappedAt).toBe(NOW + 5);
    expect(swapped.plannerModel).toBe('claude-opus-4-8');
    expect(swapped.executorModel).toBe('claude-haiku-4-5');
  });
});

describe('engine-actor prewalk helpers', () => {
  const armed = { phase: 'planning', plannerProvider: 'anthropic', plannerModel: 'claude-opus-4-8', executorProvider: 'anthropic', executorModel: 'claude-haiku-4-5', armedAt: NOW } as const;

  test('the engine actor kinds are exactly VM/Notebook/Pod/App (not web/dweb)', () => {
    expect([...ENGINE_ACTOR_KINDS].sort()).toEqual(['app', 'notebook', 'pod', 'webvm']);
    expect(isEngineActorKind('webvm')).toBe(true);
    expect(isEngineActorKind('notebook')).toBe(true);
    expect(isEngineActorKind('app')).toBe(true);
    expect(isEngineActorKind('web')).toBe(false);   // already cheap — not armed
    expect(isEngineActorKind('dweb')).toBe(false);
    expect(isEngineActorKind(undefined)).toBe(false);
  });

  test('swaps only PAST the first turn (a prior assistant exists) and not already on the executor', () => {
    // First turn: no prior assistant → stay on the frontier planner.
    expect(shouldEngineActorSwap({ prewalk: armed, hasPriorAssistant: false, provider: 'anthropic', model: 'claude-opus-4-8' })).toBe(false);
    // Second turn: prior assistant exists, still on planner → swap.
    expect(shouldEngineActorSwap({ prewalk: armed, hasPriorAssistant: true, provider: 'anthropic', model: 'claude-opus-4-8' })).toBe(true);
    // Already on the executor → no-op.
    expect(shouldEngineActorSwap({ prewalk: armed, hasPriorAssistant: true, provider: 'anthropic', model: 'claude-haiku-4-5' })).toBe(false);
    // No prewalk → never.
    expect(shouldEngineActorSwap({ prewalk: null, hasPriorAssistant: true, provider: 'anthropic', model: 'claude-opus-4-8' })).toBe(false);
  });
});

describe('PREWALK_NUDGE', () => {
  test('teaches plan→todo→act and never mentions models or swapping', () => {
    expect(PREWALK_NUDGE).toContain('todo_init');
    expect(PREWALK_NUDGE).toContain('validation');
    // The handoff is the harness's business — the transcript must not hint
    // that a different model takes over.
    expect(PREWALK_NUDGE.toLowerCase()).not.toContain('model');
    expect(PREWALK_NUDGE.toLowerCase()).not.toContain('swap');
    expect(PREWALK_NUDGE.toLowerCase()).not.toContain('cheap');
  });
});
