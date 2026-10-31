import { describe, test, expect } from 'bun:test';
import {
  createEngineAuthorityGuards, engineAuthorityMismatch,
} from '../../extension/background/engine-process.js';

const guards = (ctx: any, signal?: AbortSignal) => createEngineAuthorityGuards({
  label: 'VM', actorType: 'webvm', binding: { operation: 'turn.vm.run' }, ctx, signal,
});

describe('engine authority guards', () => {
  test('a mismatch is outcome-known, non-retryable and names the kind', () => {
    expect(engineAuthorityMismatch('Pod')).toMatchObject({
      message: 'Pod authority mismatch', outcomeKnown: true, retryable: false,
    });
  });

  test('only the exact admitted operation passes', () => {
    const { requireOperation } = guards({});
    expect(() => requireOperation('turn.vm.run')).not.toThrow();
    expect(() => requireOperation('turn.vm.destroy')).toThrow('VM authority mismatch');
  });

  test('an actor of this kind is pinned to its own instance', () => {
    const { boundId, requireBound } = guards({ actorType: 'webvm', actorInstanceId: 'vm-1' });
    expect(boundId).toBe('vm-1');
    expect(() => requireBound('vm-1')).not.toThrow();
    expect(() => requireBound('vm-2')).toThrow('VM authority mismatch');
    expect(() => requireBound(undefined)).toThrow('VM authority mismatch');
  });

  test('an actor of another kind, or no actor, is not pinned by this kind', () => {
    for (const ctx of [{}, { actorType: 'notebook', actorInstanceId: 'nb-1' }, null]) {
      const { boundId, requireBound } = guards(ctx);
      expect(boundId).toBeNull();
      expect(() => requireBound('anything')).not.toThrow();
    }
  });

  test('a stopped run cannot begin a mutation', () => {
    const controller = new AbortController();
    const { requireLive } = guards({}, controller.signal);
    expect(() => requireLive()).not.toThrow();
    controller.abort();
    try { requireLive(); throw new Error('expected refusal'); }
    catch (error: any) {
      expect(error).toMatchObject({
        message: 'VM operation stopped before mutation',
        outcomeKnown: true, outcomeKind: 'pre-effect-failure', retryable: false,
      });
    }
  });

  test('no signal means live', () => {
    expect(() => guards({}).requireLive()).not.toThrow();
  });
});
