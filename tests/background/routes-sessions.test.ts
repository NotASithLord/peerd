import { describe, test, expect } from 'bun:test';
import {
  makeSessionKernelRoutes,
  makeSessionRoutes,
} from '../../extension/background/routes/sessions.js';
import { makeAgentSendCustody } from '../../extension/peerd-egress/background.js';

// session/agent/composer/actor routes — moved verbatim. Pin the slash-command
// short-circuits in agent/send, the vault gates, actor list-filtering, and
// the no-active-session guards.

const baseDeps = (over: any = {}) => {
  const calls: any = { runInit: 0, goal: [], halted: [], system: [], tools: [], turns: [], sequence: [] };
  return {
    calls,
    deps: {
      vault: { isLocked: () => false },
      auditLog: { append: async () => {}, list: async () => [] },
      pushState: async () => { calls.sequence.push('publish'); },
      sessions: {
        list: async () => [
          { sessionId: 'a', messages: [{ when: 1 }], createdAt: 0, provider: 'p', model: 'm', toolManifest: null },
          { sessionId: 'sub', kind: 'spawned', messages: [], createdAt: 0 },
        ],
        get: async (id: string) => (id === 'a' ? { sessionId: 'a', depth: 2, messages: [] } : null),
      },
      sessionCache: { sessionGet: async () => 'a' },
      turnSlots: { stop: () => true },
      makeAgentSendCustody,
      manifestLabel: () => null,
      buildToolContext: async () => ({}),
      applyComposer: async ({ text }: any) => ({ text: `${text}!`, refs: [], command: null }),
      commandSources: { list: async () => [{ name: 'c', description: 'd' }] },
      prepareUserAttachmentsWithDocs: async ({ text }: any) => ({ text, attachments: [] }),
      runAgentTurn: async (a: any) => { calls.turns.push(a); },
      runInit: async () => { calls.runInit += 1; },
      startGoalRun: async (req: any) => { calls.sequence.push('start'); calls.goal.push(req); },
      haltGoalRun: (sid: string) => { calls.halted.push(sid); },
      ensureSession: async () => 'a',
      actorRecoveryReady: async () => true,
      handleSystemCommand: async (a: string) => { calls.system.push(a); },
      handleToolsCommand: async (a: string) => { calls.tools.push(a); },
      postChatNote: () => {},
      spawnActor: async (req: any) => ({ ran: req.task, depth: req.parentDepth }),
      requestReview: async (req: any) => ({ reviewed: true, depth: req.parentDepth }),
      appClient: { listFiles: async () => ['a.js', { path: 'b.js' }] },
      browser: { tabs: { query: async () => [
        { id: 1, title: 'Allowed', url: 'https://ok.com/p', active: true },
        { id: 2, title: 'Blocked', url: 'https://evil.com/x', active: false },
        { id: 3, title: 'Settings', url: 'chrome://settings', active: false },
      ] } },
      originOfTabUrl: (u: string) => { try { return new URL(u).origin; } catch { return ''; } },
      matchesDenylist: (host: string, pats: string[]) => pats.includes(host),
      denylistStore: { patterns: () => ['evil.com'] },
      ...over,
    },
  };
};

const sendId = (suffix: string) =>
  `send.${Date.now().toString(36)}.${suffix.padEnd(20, '0')}`;
const until = async (predicate: () => boolean, timeoutMs = 1000) => {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('until-timeout');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

test('session/debugBundle is observational', async () => {
  let writes = 0;
  const { deps } = baseDeps({
    auditLog: {
      append: async () => { writes += 1; },
      list: async () => [],
      verify: async () => ({ ok: true }),
    },
    browser: { runtime: { getManifest: () => ({ version: '1.0.0' }) } },
    settingsStore: { get: () => ({ auditLogMaxEntries: 100 }) },
    contextSnapshots: { snapshotsForMany: () => [], limits: () => ({}) },
    assembleDebugBundle: (input: any) => input,
    childSessionIdsOf: () => [],
    CHANNEL: 'store',
  });
  await expect(makeSessionRoutes(deps)['session/debugBundle']({ sessionId: 'a' }))
    .resolves.toMatchObject({ ok: true });
  expect(writes).toBe(0);
});

describe('agent/send slash-command routing', () => {
  test('empty message rejected', async () => {
    const { deps } = baseDeps();
    expect(await makeSessionRoutes(deps)['agent/send']({ text: '   ' })).toEqual({ ok: false, error: 'empty-message' });
  });
  test('/init short-circuits (no turn)', async () => {
    const { deps, calls } = baseDeps();
    expect(await makeSessionRoutes(deps)['agent/send']({ text: '/init' })).toEqual({ ok: true, handled: 'init' });
    expect(calls.runInit).toBe(1);
    expect(calls.turns.length).toBe(0);
  });
  test('goal:true starts an autonomous goal run (no model turn)', async () => {
    const { deps, calls } = baseDeps();
    expect(await makeSessionRoutes(deps)['agent/send']({ text: 'build a drum machine', goal: true }))
      .toEqual({ ok: true, handled: 'goal' });
    expect(calls.goal).toEqual([{ sessionId: 'a', goal: 'build a drum machine' }]);
    expect(calls.sequence).toEqual(['publish', 'start']);
    expect(calls.turns.length).toBe(0);
  });
  test('recovery pending refuses a goal before creating or starting it', async () => {
    let ensured = false;
    const { deps, calls } = baseDeps({
      actorRecoveryReady: async () => false,
      ensureSession: async () => { ensured = true; return 'a'; },
    });
    expect(await makeSessionRoutes(deps)['agent/send']({ text: 'build it', goal: true }))
      .toEqual({ ok: false, error: 'actor-recovery-pending' });
    expect(ensured).toBe(false);
    expect(calls.goal).toEqual([]);
  });
  test('a plain message halts an active goal run (steer-takeover)', async () => {
    const { deps, calls } = baseDeps();
    await makeSessionRoutes(deps)['agent/send']({ text: 'hello' });
    expect(calls.halted).toEqual(['a']);
  });
  test('the steer-takeover AWAITS the durable goal Stop (#60)', async () => {
    // A late-resolving haltGoalRun: the handler must wait for the durable stop
    // to commit (so it can't resurrect on the next unlock) before returning.
    let done = false;
    const { deps } = baseDeps({ haltGoalRun: async () => { await new Promise((r) => setTimeout(r, 20)); done = true; } });
    await makeSessionRoutes(deps)['agent/send']({ text: 'hello' });
    expect(done).toBe(true);
  });
  test('/system and /tools route to their handlers', async () => {
    const { deps, calls } = baseDeps();
    await makeSessionRoutes(deps)['agent/send']({ text: '/system be terse' });
    await makeSessionRoutes(deps)['agent/send']({ text: '/tools research' });
    expect(calls.system).toEqual(['be terse']);
    expect(calls.tools).toEqual(['research']);
  });
  test('/system and /tools receive the exact session admitted by the receipt', async () => {
    const bound: any[] = [];
    const { deps } = baseDeps({
      handleSystemCommand: async (arg: string, sessionId: string | null) => {
        bound.push(['system', arg, sessionId]);
      },
      handleToolsCommand: async (arg: string, sessionId: string | null) => {
        bound.push(['tools', arg, sessionId]);
      },
    });
    await makeSessionRoutes(deps)['agent/send']({
      text: '/system be exact', sessionId: 'a',
    });
    await makeSessionRoutes(deps)['agent/send']({
      text: '/tools research', sessionId: 'a',
    });
    expect(bound).toEqual([
      ['system', 'be exact', 'a'],
      ['tools', 'research', 'a'],
    ]);
  });
  test('recovery pending refuses a model turn without halting its goal', async () => {
    const { deps, calls } = baseDeps({ actorRecoveryReady: async () => false });
    expect(await makeSessionRoutes(deps)['agent/send']({ text: 'hello' }))
      .toEqual({ ok: false, error: 'actor-recovery-pending' });
    expect(calls.turns).toEqual([]);
    expect(calls.halted).toEqual([]);
  });
  test('local slash commands remain available while recovery is pending', async () => {
    const { deps, calls } = baseDeps({ actorRecoveryReady: async () => false });
    expect(await makeSessionRoutes(deps)['agent/send']({ text: '/system be terse' }))
      .toEqual({ ok: true, handled: 'system' });
    expect(calls.system).toEqual(['be terse']);
  });
  test('plain message runs a turn with composer-expanded text', async () => {
    const { deps, calls } = baseDeps();
    expect(await makeSessionRoutes(deps)['agent/send']({ text: 'hello' })).toEqual({ ok: true });
    expect(calls.turns[0].userText).toBe('hello!');
  });
  test('invalid attachment batch fails closed', async () => {
    const { deps } = baseDeps({ prepareUserAttachmentsWithDocs: async () => { throw new Error('bad file'); } });
    expect(await makeSessionRoutes(deps)['agent/send']({ text: 'hi', attachments: [{}] })).toEqual({ ok: false, error: 'bad file' });
  });

  test('one operation id dispatches exactly once across concurrency and worker succession', async () => {
    const stored: Record<string, any> = {};
    const sessionCache = {
      sessionGet: async (key: string) => key === 'currentSessionId' ? 'a' : stored[key],
      sessionSet: async (key: string, value: any) => { stored[key] = structuredClone(value); },
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = baseDeps({
      sessionCache,
      applyComposer: async ({ text }: any) => { await gate; return { text, refs: [], command: null }; },
    });
    const routes = makeSessionRoutes(first.deps);
    const message = { text: 'once', operationId: sendId('concurrent'), sessionId: 'a' };
    const a = routes['agent/send'](message);
    const b = routes['agent/send'](message);
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    const concurrent = await Promise.all([a, b]);
    expect(concurrent.every((result) => result.ok === true
      && result.operationId === message.operationId)).toBe(true);
    expect(first.calls.turns).toHaveLength(1);
    await until(() => stored['agentSendReceipts.v1']?.[message.operationId]?.status === 'settled');

    const successor = baseDeps({ sessionCache });
    await expect(makeSessionRoutes(successor.deps)['agent/send']({
      ...message,
    })).resolves.toEqual({
      ok: true, operationId: message.operationId, duplicate: true,
    });
    expect(successor.calls.turns).toHaveLength(0);

    await expect(makeSessionRoutes(successor.deps)['agent/send']({
      ...message, text: 'altered replay',
    })).resolves.toMatchObject({
      ok: false, error: 'agent-send-operation-id-conflict', outcomeKnown: true,
    });
    expect(successor.calls.turns).toHaveLength(0);
  });

  test('an accepted receipt after worker loss stays unknown and never replays', async () => {
    const operationId = sendId('accepted-worker-loss');
    const stored: Record<string, any> = {};
    const sessionCache = {
      sessionGet: async (key: string) => key === 'currentSessionId' ? 'a' : stored[key],
      sessionSet: async (key: string, value: any) => { stored[key] = structuredClone(value); },
    };
    let release!: () => void;
    const turn = new Promise<void>((resolve) => { release = resolve; });
    const first = baseDeps({
      sessionCache, runAgentTurn: async (args: any) => {
        first.calls.turns.push(args);
        await turn;
      },
    });
    const message = { text: 'do it', operationId, sessionId: 'a' };
    await expect(makeSessionRoutes(first.deps)['agent/send'](message))
      .resolves.toMatchObject({ ok: true, operationId });
    expect(stored['agentSendReceipts.v1'][operationId].status).toBe('accepted');

    const successor = baseDeps({ sessionCache });
    await expect(makeSessionRoutes(successor.deps)['agent/send'](message))
      .resolves.toMatchObject({
        ok: false, operationId, outcomeKnown: false, retryable: false,
      });
    expect(successor.calls.turns).toHaveLength(0);

    release();
    await until(() => stored['agentSendReceipts.v1'][operationId].status === 'settled');
    await expect(makeSessionRoutes(successor.deps)['agent/send']({
      checkOnly: true, operationId, sessionId: 'a',
    })).resolves.toMatchObject({ ok: true, operationId, duplicate: true });
  });

  test('status-only Check never dispatches an absent operation or drops attachments', async () => {
    const { deps, calls } = baseDeps({
      sessionCache: {
        sessionGet: async (key: string) => key === 'currentSessionId' ? 'a' : undefined,
        sessionSet: async () => {},
      },
    });
    const operationId = sendId('attachment-status');
    await expect(makeSessionRoutes(deps)['agent/send']({
      checkOnly: true, operationId, sessionId: 'a',
    })).resolves.toMatchObject({
      ok: false, error: 'agent-send-not-observed', outcomeKnown: false,
    });
    expect(calls.turns).toHaveLength(0);
  });

  test('same id with altered attachments conflicts before a second dispatch', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const stored: Record<string, any> = {};
    const sessionCache = {
      sessionGet: async (key: string) => key === 'currentSessionId' ? 'a' : stored[key],
      sessionSet: async (key: string, value: any) => { stored[key] = structuredClone(value); },
    };
    const first = baseDeps({
      sessionCache,
      applyComposer: async ({ text }: any) => {
        await gate;
        return { text, refs: [], command: null };
      },
    });
    const routes = makeSessionRoutes(first.deps);
    const operationId = sendId('attachment-conflict');
    const original = routes['agent/send']({
      text: 'inspect', operationId, sessionId: 'a',
      attachments: [{ name: 'a.txt', mediaType: 'text/plain', size: 1, data: 'YQ==' }],
    });
    await until(() => stored['agentSendReceipts.v1']?.[operationId]?.status === 'accepted');
    await expect(routes['agent/send']({
      text: 'inspect', operationId, sessionId: 'a', attachments: [],
    })).resolves.toMatchObject({
      ok: false, error: 'agent-send-operation-id-conflict', outcomeKnown: true,
    });
    release();
    await expect(original).resolves.toMatchObject({ ok: true, operationId });
    expect(first.calls.turns).toHaveLength(1);
  });

  test('receipt read failure and corruption fail closed without dispatch', async () => {
    const operationId = sendId('receipt-read-fail');
    const readFailure = baseDeps({
      sessionCache: {
        sessionGet: async (key: string) => {
          if (key === 'currentSessionId') return 'a';
          throw new Error('raw storage failure');
        },
        sessionSet: async () => {},
      },
    });
    await expect(makeSessionRoutes(readFailure.deps)['agent/send']({
      text: 'once', operationId, sessionId: 'a',
    })).resolves.toMatchObject({
      ok: false, error: 'agent-send-receipt-unavailable', outcomeKnown: false,
    });
    expect(readFailure.calls.turns).toHaveLength(0);

    const corrupt = baseDeps({
      sessionCache: {
        sessionGet: async (key: string) => key === 'currentSessionId' ? 'a' : {
          [operationId]: { status: 'settled', result: { ok: true, forged: true } },
        },
        sessionSet: async () => {},
      },
    });
    await expect(makeSessionRoutes(corrupt.deps)['agent/send']({
      text: 'once', operationId, sessionId: 'a',
    })).resolves.toMatchObject({
      ok: false, error: 'agent-send-receipt-unavailable', outcomeKnown: false,
    });
    expect(corrupt.calls.turns).toHaveLength(0);
  });

  test('receipt write loss after a slash effect is unknown and never replays it', async () => {
    const operationId = sendId('settled-write-loss');
    const stored: Record<string, any> = {};
    let writes = 0;
    let effects = 0;
    const sessionCache = {
      sessionGet: async (key: string) => key === 'currentSessionId'
        ? 'a' : structuredClone(stored[key]),
      sessionSet: async (key: string, value: any) => {
        writes += 1;
        if (writes > 1) throw new Error('settled receipt lost');
        stored[key] = structuredClone(value);
      },
    };
    const first = baseDeps({
      sessionCache,
      handleSystemCommand: async () => { effects += 1; },
    });
    const message = {
      text: '/system exact', operationId, sessionId: 'a',
    };
    await expect(makeSessionRoutes(first.deps)['agent/send'](message))
      .resolves.toMatchObject({ ok: false, outcomeKnown: false, operationId });
    expect(effects).toBe(1);
    expect(stored['agentSendReceipts.v1'][operationId].status).toBe('accepted');

    const successor = baseDeps({
      sessionCache,
      handleSystemCommand: async () => { effects += 1; },
    });
    await expect(makeSessionRoutes(successor.deps)['agent/send'](message))
      .resolves.toMatchObject({ ok: false, outcomeKnown: false, operationId });
    expect(effects).toBe(1);
  });

  test('invalid input consumes only its exact fingerprint and cannot become a valid replay', async () => {
    const stored: Record<string, any> = {};
    const sessionCache = {
      sessionGet: async (key: string) => key === 'currentSessionId' ? 'a' : stored[key],
      sessionSet: async (key: string, value: any) => { stored[key] = structuredClone(value); },
    };
    const invalid = baseDeps({
      sessionCache,
      prepareUserAttachmentsWithDocs: async () => { throw new Error('bad attachment'); },
    });
    const operationId = sendId('invalid-input');
    await expect(makeSessionRoutes(invalid.deps)['agent/send']({
      text: 'send file', operationId, sessionId: 'a',
      attachments: [{ name: 'bad.bin', data: 'YmFk' }],
    })).resolves.toMatchObject({ ok: false, error: 'bad attachment', operationId });
    expect(invalid.calls.turns).toHaveLength(0);

    await expect(makeSessionRoutes(invalid.deps)['agent/send']({
      text: 'send file', operationId, sessionId: 'a', attachments: [],
    })).resolves.toMatchObject({
      ok: false, error: 'agent-send-operation-id-conflict', outcomeKnown: true,
    });
    expect(invalid.calls.turns).toHaveLength(0);
  });

  test('full legacy receipt capacity refuses rather than evicting replay evidence', async () => {
    const receipts: Record<string, any> = {};
    for (let index = 0; index < 4096; index += 1) {
      receipts[`legacy-operation-${String(index).padStart(8, '0')}`] = {
        schema: 2, status: index === 0 ? 'accepted' : 'settled',
        fingerprint: 'a'.repeat(64), sessionId: 'a',
        result: index === 0 ? undefined : { ok: true },
        issuedAt: 1, at: index + 1,
      };
    }
    const stored: Record<string, any> = { 'agentSendReceipts.v1': receipts };
    const full = baseDeps({
      sessionCache: {
        sessionGet: async (key: string) => key === 'currentSessionId' ? 'a' : stored[key],
        sessionSet: async (key: string, value: any) => { stored[key] = value; },
      },
    });
    await expect(makeSessionRoutes(full.deps)['agent/send']({
      text: 'new', operationId: sendId('capacity'), sessionId: 'a',
    })).resolves.toMatchObject({
      ok: false, error: 'agent-send-receipt-unavailable', outcomeKnown: false,
    });
    expect(receipts['legacy-operation-00000000'].status).toBe('accepted');
    expect(full.calls.turns).toHaveLength(0);
  });

  test('session pin rejects stale UI state and targets the admitted chat exactly', async () => {
    const mismatch = baseDeps();
    await expect(makeSessionRoutes(mismatch.deps)['agent/send']({
      text: 'wrong chat', operationId: sendId('wrong-chat'), sessionId: 'b',
    })).resolves.toMatchObject({
      ok: false, error: 'agent-send-session-mismatch', outcomeKnown: true,
    });
    expect(mismatch.calls.turns).toHaveLength(0);

    const stored: Record<string, any> = {};
    const pinned = baseDeps({
      sessionCache: {
        sessionGet: async (key: string) => key === 'currentSessionId' ? 'a' : stored[key],
        sessionSet: async (key: string, value: any) => { stored[key] = structuredClone(value); },
      },
    });
    await makeSessionRoutes(pinned.deps)['agent/send']({
      text: 'right chat', operationId: sendId('right-chat'), sessionId: 'a',
    });
    expect(pinned.calls.turns[0].sessionId).toBe('a');
  });

  test('slash-command receipt does not settle before its handler', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const stored: Record<string, any> = {};
    const sessionCache = {
      sessionGet: async (key: string) => key === 'currentSessionId' ? 'a' : stored[key],
      sessionSet: async (key: string, value: any) => { stored[key] = structuredClone(value); },
    };
    const operationId = sendId('slash-await');
    const slash = baseDeps({ sessionCache, runInit: async () => { await gate; } });
    let settled = false;
    const response = makeSessionRoutes(slash.deps)['agent/send']({
      text: '/init', operationId, sessionId: 'a',
    }).then((value: any) => { settled = true; return value; });
    await until(() => stored['agentSendReceipts.v1']?.[operationId]?.status === 'accepted');
    expect(settled).toBe(false);
    release();
    await expect(response).resolves.toMatchObject({ ok: true, handled: 'init', operationId });
  });
});

describe('session read routes', () => {
  test('agent/stop audits when a turn was in flight', async () => {
    let audited = false;
    const { deps } = baseDeps({ auditLog: { append: async () => { audited = true; }, list: async () => [] }, turnSlots: { stop: () => true } });
    expect(await makeSessionRoutes(deps)['agent/stop']()).toEqual({ ok: true });
    expect(audited).toBe(true);
  });
  test('agent/stop CASCADES to the chat’s in-flight actors (DESIGN-17 P1)', async () => {
    // The current chat is 'a'; it has two actors in flight. Stop must abort the
    // orchestrator AND both actor slots (an actor runs on its own slot).
    const stopped: string[] = [];
    const { deps } = baseDeps({
      turnSlots: { stop: (sid: string) => { stopped.push(sid); return true; } },
      actorMessaging: { stopActorsFor: (sid: string) => (sid === 'a' ? ['res-1', 'res-2'] : []) },
    });
    expect(await makeSessionRoutes(deps)['agent/stop']()).toEqual({ ok: true });
    expect(stopped).toEqual(['a', 'res-1', 'res-2']);   // orchestrator first, then its actors
  });
  test('agent/stop with no actors only stops the orchestrator', async () => {
    const stopped: string[] = [];
    const { deps } = baseDeps({
      turnSlots: { stop: (sid: string) => { stopped.push(sid); return true; } },
      actorMessaging: { stopActorsFor: () => [] },
    });
    await makeSessionRoutes(deps)['agent/stop']();
    expect(stopped).toEqual(['a']);
  });
  test('session/list filters out spawned', async () => {
    const { deps } = baseDeps();
    const res = await makeSessionKernelRoutes(deps)['session/list']();
    expect(res.sessions.map((s: any) => s.sessionId)).toEqual(['a']);
  });
  test('session/list locked → locked', async () => {
    const { deps } = baseDeps({ vault: { isLocked: () => true } });
    expect(await makeSessionKernelRoutes(deps)['session/list']()).toEqual({ ok: false, error: 'locked' });
  });
  test('session/get requires an id', async () => {
    const { deps } = baseDeps();
    expect(await makeSessionKernelRoutes(deps)['session/get']({ sessionId: '' })).toEqual({ ok: false, error: 'sessionId-required' });
  });
  test('session/get unknown → session-not-found', async () => {
    const { deps } = baseDeps();
    expect(await makeSessionKernelRoutes(deps)['session/get']({ sessionId: 'zzz' })).toEqual({ ok: false, error: 'session-not-found' });
  });
  test('composer/files maps to paths; [] when locked', async () => {
    const { deps } = baseDeps();
    expect(await makeSessionKernelRoutes(deps)['composer/files']()).toEqual({ ok: true, files: ['a.js', 'b.js'] });
    const locked = baseDeps({ vault: { isLocked: () => true } }).deps;
    expect(await makeSessionKernelRoutes(locked)['composer/files']()).toEqual({ ok: true, files: [] });
  });
  test('composer/tabs flags denylisted + unsupported-scheme tabs as blocked', async () => {
    const { deps } = baseDeps();
    const res = await makeSessionKernelRoutes(deps)['composer/tabs']();
    const byId = Object.fromEntries(res.tabs.map((t: any) => [t.id, t]));
    expect(byId[1].blocked).toBe(false);                 // https://ok.com
    expect(byId[2].blocked).toBe(true);                  // denylisted host
    expect(byId[3].blocked).toBe(true);                  // chrome:// scheme
    expect(byId[1]).toMatchObject({ origin: 'https://ok.com', active: true });
  });
});

describe('actor + review spawn', () => {
  test('actor/spawn requires a task', async () => {
    const { deps } = baseDeps();
    expect(await makeSessionRoutes(deps)['actor/spawn']({ task: '  ' })).toEqual({ ok: false, error: 'task-required' });
  });
  test('actor/spawn inherits parent depth', async () => {
    const { deps } = baseDeps();
    expect(await makeSessionRoutes(deps)['actor/spawn']({ task: 'go' })).toEqual({ ok: true, result: { ran: 'go', depth: 2 } });
  });
  test('actor/spawn no active session', async () => {
    const { deps } = baseDeps({ sessionCache: { sessionGet: async () => null } });
    expect(await makeSessionRoutes(deps)['actor/spawn']({ task: 'go' })).toEqual({ ok: false, error: 'no-active-session' });
  });
  test('review/run passes parent depth through', async () => {
    const { deps } = baseDeps();
    expect(await makeSessionRoutes(deps)['review/run']({ diff: 'd' })).toEqual({ ok: true, result: { reviewed: true, depth: 2 } });
  });
});
