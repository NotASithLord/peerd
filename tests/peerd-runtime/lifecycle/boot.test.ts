// Lifecycle boot — the SW-eviction sequence over storage that survives it.
// Simulates eviction the way the contract defines it (§2.1): durable
// storage persists, memory does not — a second boot over the same storage
// IS the eviction, and must settle what the first generation left behind.

import { describe, test, expect } from 'bun:test';
import {
  makeLifecycleBoot, GENERATION_KEY,
} from '../../../extension/peerd-runtime/lifecycle/boot.js';
import { OPERATION_STATES } from '../../../extension/peerd-runtime/lifecycle/operation-state.js';

const S = OPERATION_STATES;

const makeStorage = () => {
  const map = new Map<string, unknown>();
  return {
    get: async (k: string) => structuredClone(map.get(k)),
    set: async (k: string, v: unknown) => { map.set(k, structuredClone(v)); },
  };
};

const boot = (storage = makeStorage(), extra: Record<string, unknown> = {}) => {
  let n = 0;
  return makeLifecycleBoot({
    storage,
    nonce: () => `nonce-${n += 1}-xxxx`,
    now: () => 1000 + n,
    ...extra,
  });
};

describe('generation continuity', () => {
  test('each boot mints a monotonically newer generation, persisted before reconcile', async () => {
    const storage = makeStorage();
    const first = await boot(storage).init();
    const second = await boot(storage).init();
    expect(first.generation.seq).toBe(1);
    expect(second.generation.seq).toBe(2);
    expect(second.generation.id).not.toBe(first.generation.id);
    expect(((await storage.get(GENERATION_KEY)) as { seq: number }).seq).toBe(2);
  });
});

describe('the eviction matrix over durable storage', () => {
  // One tool from every retry class, killed at a characteristic phase
  // (§16.3): the first generation records the phase, the second boot must
  // settle each to the contract's terminal state.
  test('a second boot settles every orphan to its class-correct terminal state', async () => {
    const storage = makeStorage();
    const gen1 = boot(storage);
    const { generation } = await gen1.init();
    const log = gen1.operationLog;

    const begin = (operationId: string, retryClass: string) => log.begin({
      operationId, sessionId: 'sess-1', toolName: `tool-${retryClass}`,
      retryClass, generationId: generation.id,
    });

    // Class B read: killed after dispatch.
    await begin('op-b', 'B');
    await log.transition('op-b', S.RUNNING);
    await log.markDispatched('op-b');
    // Class C write: killed before dispatch.
    await begin('op-c', 'C');
    await log.transition('op-c', S.RUNNING);
    // Class D: killed after dispatch, no ack.
    await begin('op-d', 'D');
    await log.transition('op-d', S.RUNNING);
    await log.markDispatched('op-d');
    // Class E: killed after dispatch — THE case.
    await begin('op-e', 'E');
    await log.transition('op-e', S.RUNNING);
    await log.markDispatched('op-e');
    // Class E: killed during the approval prompt.
    await begin('op-e2', 'E');
    await log.transition('op-e2', S.RUNNING);
    await log.transition('op-e2', S.AWAITING_USER);
    // Class F resource: killed mid-registration.
    await begin('op-f', 'F');
    await log.transition('op-f', S.RUNNING);

    // ---- the eviction: same storage, fresh boot ----
    const gen2 = boot(storage);
    const { plan } = await gen2.init();
    expect(plan.transitions.length).toBe(6);

    const state = async (id: string) => (await gen2.operationLog.get(id))!.state;
    expect(await state('op-b')).toBe(S.INTERRUPTED);      // retryable read
    expect(await state('op-c')).toBe(S.INTERRUPTED);      // idempotent write
    expect(await state('op-d')).toBe(S.OUTCOME_UNKNOWN);  // verify first
    expect(await state('op-e')).toBe(S.OUTCOME_UNKNOWN);  // never auto-retry
    expect(await state('op-e2')).toBe(S.INTERRUPTED);     // approval died with the generation
    expect(await state('op-f')).toBe(S.INTERRUPTED);      // recreate, no continuation
  });

  test('a third boot finds nothing left to settle (reconcile is idempotent)', async () => {
    const storage = makeStorage();
    const gen1 = boot(storage);
    const { generation } = await gen1.init();
    await gen1.operationLog.begin({
      operationId: 'op-1', sessionId: 's', toolName: 't',
      retryClass: 'E', generationId: generation.id,
    });
    await boot(storage).init();
    const { plan } = await boot(storage).init();
    expect(plan.transitions.length).toBe(0);
  });
});

describe('notices — both audiences, delivered once', () => {
  test('audit entries append, the user notify fires, and the agent drain is read-once', async () => {
    const storage = makeStorage();
    const audits: Array<Record<string, unknown>> = [];
    const notes: Array<{ sessionId: string, text: string }> = [];
    const gen1 = boot(storage);
    const { generation } = await gen1.init();
    await gen1.operationLog.begin({
      operationId: 'op-e', sessionId: 'sess-9', toolName: 'submit_form',
      retryClass: 'E', generationId: generation.id, });
    await gen1.operationLog.transition('op-e', S.RUNNING);
    await gen1.operationLog.markDispatched('op-e');

    const gen2 = boot(storage, {
      appendAudit: async (e: Record<string, unknown>) => { audits.push(e); },
      notify: (sessionId: string, text: string) => { notes.push({ sessionId, text }); },
    });
    await gen2.init();

    expect(audits.some((e) => e.event === 'lifecycle.generation.sw-changed')).toBe(true);
    expect(audits.some((e) => e.event === 'lifecycle.operation.outcome_unknown')).toBe(true);
    expect(notes.length).toBe(1);
    expect(notes[0]?.sessionId).toBe('sess-9');
    expect(notes[0]?.text).toContain('Recovery for submit_form');
    expect(notes[0]?.text).toContain('Check the target');

    const block = await gen2.drainNoticesFor('sess-9');
    expect(block).toContain('<interruption-recovery>');
    expect(block).toContain('outcome_unknown');
    expect(block).toContain('submit_form');
    // Read-once: drained notices do not repeat on the next turn.
    expect(await gen2.drainNoticesFor('sess-9')).toBe('');
    // Other sessions see nothing.
    expect(await gen2.drainNoticesFor('sess-other')).toBe('');
  });

  test('an actor session\'s notice routes to the parent chat via resolveNoticeSession', async () => {
    const storage = makeStorage();
    const gen1 = boot(storage);
    const { generation } = await gen1.init();
    await gen1.operationLog.begin({
      operationId: 'op-actor', sessionId: 'actor-child-3', actorId: 'web:9',
      toolName: 'click', retryClass: 'E', generationId: generation.id,
    });
    await gen1.operationLog.transition('op-actor', S.RUNNING);
    await gen1.operationLog.markDispatched('op-actor');

    const gen2 = boot(storage, {
      resolveNoticeSession: async (sid: string) =>
        (sid === 'actor-child-3' ? 'root-chat-1' : sid),
    });
    await gen2.init();
    // The notice landed on the ROOT chat — the session that takes turns —
    // not the ephemeral actor child.
    expect(await gen2.drainNoticesFor('actor-child-3')).toBe('');
    const block = await gen2.drainNoticesFor('root-chat-1');
    expect(block).toContain('click');
    expect(block).toContain('outcome_unknown');
  });

  test('concurrent park and drain never lose or resurrect a notice (the queue)', async () => {
    const storage = makeStorage();
    const b = boot(storage);
    await b.init();
    // Interleave heavily: parks for T racing drains of S. Every parked
    // notice must be drained exactly once, no loss, no duplication.
    await b.parkNotice('S', { recoveryRecord: { operationId: 'op-s' }, user: 'notice S' });
    const results = await Promise.all([
      b.parkNotice('T', { recoveryRecord: { operationId: 'op-t1' }, user: 'notice T1' }),
      b.drainNoticesFor('S'),
      b.parkNotice('T', { recoveryRecord: { operationId: 'op-t2' }, user: 'notice T2' }),
      b.drainNoticesFor('S'),
    ]);
    const sDrains = [results[1], results[3]].filter((x) => x !== '');
    expect(sDrains.length).toBe(1); // read-once held under the race
    const tBlock = await b.drainNoticesFor('T');
    expect(tBlock).toContain('notice T1'); // neither park was lost
    expect(tBlock).toContain('notice T2');
    expect(await b.drainNoticesFor('T')).toBe(''); // and delivered once
  });

  test('a resource notice shows its friendly name only to the user', async () => {
    const storage = makeStorage();
    const shown: string[] = [];
    const b = boot(storage, {
      notify: (_sessionId: string, text: string) => { shown.push(text); },
    });
    await b.init();
    await b.parkNotice('chat-a', {
      recoveryRecord: {
        operation: 'app:app-1', recoveryState: 'interrupted',
        resources: [{ kind: 'app', id: 'app-1' }],
      },
      user: 'App "Quarterly review" is no longer running.',
      agent: 'App "app-1" lost its host. Do not claim the runtime resumed.',
    });

    expect(shown).toEqual(['App "Quarterly review" is no longer running.']);
    const block = await b.drainNoticesFor('chat-a');
    expect(block).toContain('App "app-1" lost its host');
    expect(block).not.toContain('Quarterly review');
  });

  test('purgeSession preserves dispatched Class E uncertainty and replaces stale notices', async () => {
    const storage = makeStorage();
    const b = boot(storage);
    const { generation } = await b.init();
    await b.operationLog.begin({
      operationId: 'op-open', sessionId: 'sess-del', toolName: 'submit_form',
      retryClass: 'E', generationId: generation.id,
    });
    await b.operationLog.transition('op-open', S.RUNNING);
    await b.operationLog.markDispatched('op-open');
    await b.parkNotice('sess-del', { recoveryRecord: { operationId: 'op-old' }, user: 'stale' });

    await b.purgeSession('sess-del');
    const notice = await b.drainNoticesFor('sess-del');
    expect(notice).not.toContain('stale');
    expect(notice).toContain('submit_form');
    expect(notice).toContain('outcome_unknown');
    expect(notice).toContain('external-verification');
    expect((await b.operationLog.get('op-open'))!.state).toBe(S.OUTCOME_UNKNOWN);
    // A fresh boot has nothing to resurrect for the deleted session.
    const { plan } = await boot(storage).init();
    expect(plan.transitions.length).toBe(0);
  });

  test('purgeSession cancels pre-dispatch work and preserves completion evidence', async () => {
    const storage = makeStorage();
    const b = boot(storage);
    const { generation } = await b.init();
    await b.operationLog.begin({
      operationId: 'op-before', sessionId: 'sess-del', toolName: 'submit_form',
      retryClass: 'E', generationId: generation.id,
    });
    await b.operationLog.transition('op-before', S.RUNNING);
    await b.operationLog.begin({
      operationId: 'op-complete', sessionId: 'sess-del', toolName: 'click',
      retryClass: 'E', generationId: generation.id,
    });
    await b.operationLog.transition('op-complete', S.RUNNING, {
      dispatched: true, evidence: { kind: 'success-response' },
    });

    await b.purgeSession('sess-del');
    expect((await b.operationLog.get('op-before'))!.state).toBe(S.CANCELLED);
    expect((await b.operationLog.get('op-complete'))!.state).toBe(S.COMPLETED);
    expect(await b.drainNoticesFor('sess-del')).toBe('');
  });

  test('a throwing resolver falls back to the operation\'s own session', async () => {
    const storage = makeStorage();
    const gen1 = boot(storage);
    const { generation } = await gen1.init();
    await gen1.operationLog.begin({
      operationId: 'op-1', sessionId: 'sess-1', toolName: 't',
      retryClass: 'E', generationId: generation.id,
    });
    await gen1.operationLog.transition('op-1', S.RUNNING);
    await gen1.operationLog.markDispatched('op-1');
    const gen2 = boot(storage, {
      resolveNoticeSession: async () => { throw new Error('sessions store down'); },
    });
    await gen2.init();
    expect(await gen2.drainNoticesFor('sess-1')).toContain('outcome_unknown');
  });
});
