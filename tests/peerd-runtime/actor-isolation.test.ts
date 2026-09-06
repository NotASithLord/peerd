import { describe, expect, test } from 'bun:test';
import {
  actorIsolationCapability,
  actorIsolationForTurn,
  actorIsolationRefusal,
  actorIsolationSpawnRefusal,
  actorIsolationTemporarilyUnavailable,
  filterByActorIsolation,
  actorIsolationPromptBlock,
} from '../../extension/peerd-runtime/actor/isolation.js';

describe('actor isolation capability', () => {
  test('prefers the Chrome offscreen worker host', () => {
    expect(actorIsolationCapability({ offscreenWorker: true, backgroundPageWorker: true })).toEqual({
      status: 'available', host: 'offscreen-document-worker', reason: null, retryable: false,
    });
  });

  test('uses a direct background-page worker on Firefox', () => {
    expect(actorIsolationCapability({ offscreenWorker: false, backgroundPageWorker: true })).toEqual({
      status: 'available', host: 'background-page-worker', reason: null, retryable: false,
    });
  });

  test('fails closed with stable no-side-effect fields', () => {
    const unsupported = actorIsolationCapability({ offscreenWorker: false, backgroundPageWorker: false });
    expect(actorIsolationRefusal(unsupported)).toMatchObject({
      ok: false,
      code: 'actor_isolation_unavailable',
      performed: false,
      targetRead: false,
      targetChanged: false,
      retryable: false,
    });
  });

  test('can report a binding that was resolved before startup failed', () => {
    const unsupported = actorIsolationCapability({ offscreenWorker: false, backgroundPageWorker: false });
    expect(actorIsolationRefusal(unsupported, { targetRead: true, targetChanged: true })).toMatchObject({
      performed: false,
      targetRead: true,
      targetChanged: true,
    });
  });

  test('shapes a spawn refusal without a child session or side effect', () => {
    const unsupported = actorIsolationCapability({ offscreenWorker: false, backgroundPageWorker: false });
    expect(actorIsolationSpawnRefusal(unsupported, 2)).toEqual({
      result: 'Actors were not run because this browser cannot provide the required isolated worker.',
      sessionId: null,
      toolCalls: 0,
      durationMs: 0,
      depth: 3,
      refused: true,
    });
  });

  test('marks a host failure as a distinct retryable state', () => {
    const available = actorIsolationCapability({ offscreenWorker: false, backgroundPageWorker: true });
    const failed = actorIsolationTemporarilyUnavailable(available, new Error('worker import failed'));
    expect(actorIsolationRefusal(failed)).toMatchObject({
      code: 'actor_isolation_temporarily_unavailable', retryable: true,
    });
    expect(failed.host).toBe('background-page-worker');
  });
});

describe('actor isolation exposure', () => {
  const tools = ['message_actor', 'actor_create', 'actor_list', 'read_memory']
    .map((name) => ({ name }));

  test('removes actor execution tools but keeps inventory', () => {
    const unavailable = actorIsolationCapability({ offscreenWorker: false, backgroundPageWorker: false });
    expect(filterByActorIsolation(tools, unavailable).map((tool) => tool.name)).toEqual(['actor_list', 'read_memory']);
    expect(actorIsolationPromptBlock(unavailable)).toContain('Do not open or resolve an actor target');
    expect(actorIsolationPromptBlock(unavailable)).not.toContain('Try again');
  });

  test('leaves tools present without exposing host details when available', () => {
    const available = actorIsolationCapability({ offscreenWorker: false, backgroundPageWorker: true });
    expect(filterByActorIsolation(tools, available)).toEqual(tools);
    expect(actorIsolationPromptBlock(available)).toBe('');
  });

  test('tells the model that only the user should retry a temporary failure', () => {
    const available = actorIsolationCapability({ offscreenWorker: false, backgroundPageWorker: true });
    const failed = actorIsolationTemporarilyUnavailable(available, new Error('worker import failed'));
    expect(actorIsolationPromptBlock(failed)).toContain('Try again control');
    expect(actorIsolationPromptBlock(failed)).not.toContain('worker import failed');
  });

  test('keeps an unavailable turn unavailable after recovery, but sees a live failure', () => {
    const available = actorIsolationCapability({ offscreenWorker: false, backgroundPageWorker: true });
    const unavailable = actorIsolationTemporarilyUnavailable(available, new Error('worker failed'));
    expect(actorIsolationForTurn(unavailable, available)).toBe(unavailable);
    expect(actorIsolationForTurn(available, unavailable)).toBe(unavailable);
  });
});
