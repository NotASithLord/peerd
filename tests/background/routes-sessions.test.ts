import { describe, test, expect } from 'bun:test';
import { makeSessionRoutes } from '../../extension/background/routes/sessions.js';

// session/agent/composer/subagent routes — moved verbatim. Pin the slash-command
// short-circuits in agent/send, the vault gates, subagent list-filtering, and
// the no-active-session guards.

const baseDeps = (over: any = {}) => {
  const calls: any = { runInit: 0, goal: [], halted: [], system: [], tools: [], turns: [] };
  return {
    calls,
    deps: {
      vault: { isLocked: () => false },
      auditLog: { append: async () => {}, list: async () => [] },
      sessions: {
        list: async () => [
          { sessionId: 'a', messages: [{ when: 1 }], createdAt: 0, provider: 'p', model: 'm', toolManifest: null },
          { sessionId: 'sub', kind: 'subagent', messages: [], createdAt: 0 },
        ],
        get: async (id: string) => (id === 'a' ? { sessionId: 'a', depth: 2, messages: [] } : null),
      },
      sessionCache: { sessionGet: async () => 'a' },
      turnSlots: { stop: () => true },
      manifestLabel: () => null,
      buildToolContext: async () => ({}),
      applyComposer: async ({ text }: any) => ({ text: `${text}!`, refs: [], command: null }),
      commandSources: { list: async () => [{ name: 'c', description: 'd' }] },
      prepareUserAttachments: ({ text }: any) => ({ text, attachments: [] }),
      runAgentTurn: async (a: any) => { calls.turns.push(a); },
      runInit: async () => { calls.runInit += 1; },
      startGoalRun: async (req: any) => { calls.goal.push(req); },
      haltGoalRun: (sid: string) => { calls.halted.push(sid); },
      ensureSession: async () => 'a',
      handleSystemCommand: async (a: string) => { calls.system.push(a); },
      handleToolsCommand: async (a: string) => { calls.tools.push(a); },
      postChatNote: () => {},
      spawnSubagent: async (req: any) => ({ ran: req.task, depth: req.parentDepth }),
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
    expect(calls.turns.length).toBe(0);
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
  test('plain message runs a turn with composer-expanded text', async () => {
    const { deps, calls } = baseDeps();
    expect(await makeSessionRoutes(deps)['agent/send']({ text: 'hello' })).toEqual({ ok: true });
    expect(calls.turns[0].userText).toBe('hello!');
  });
  test('invalid attachment batch fails closed', async () => {
    const { deps } = baseDeps({ prepareUserAttachments: () => { throw new Error('bad file'); } });
    expect(await makeSessionRoutes(deps)['agent/send']({ text: 'hi', attachments: [{}] })).toEqual({ ok: false, error: 'bad file' });
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
  test('session/list filters out subagents', async () => {
    const { deps } = baseDeps();
    const res = await makeSessionRoutes(deps)['session/list']();
    expect(res.sessions.map((s: any) => s.sessionId)).toEqual(['a']);
  });
  test('session/list locked → locked', async () => {
    const { deps } = baseDeps({ vault: { isLocked: () => true } });
    expect(await makeSessionRoutes(deps)['session/list']()).toEqual({ ok: false, error: 'locked' });
  });
  test('session/get requires an id', async () => {
    const { deps } = baseDeps();
    expect(await makeSessionRoutes(deps)['session/get']({ sessionId: '' })).toEqual({ ok: false, error: 'sessionId-required' });
  });
  test('session/get unknown → session-not-found', async () => {
    const { deps } = baseDeps();
    expect(await makeSessionRoutes(deps)['session/get']({ sessionId: 'zzz' })).toEqual({ ok: false, error: 'session-not-found' });
  });
  test('composer/files maps to paths; [] when locked', async () => {
    const { deps } = baseDeps();
    expect(await makeSessionRoutes(deps)['composer/files']()).toEqual({ ok: true, files: ['a.js', 'b.js'] });
    const locked = baseDeps({ vault: { isLocked: () => true } }).deps;
    expect(await makeSessionRoutes(locked)['composer/files']()).toEqual({ ok: true, files: [] });
  });
  test('composer/tabs flags denylisted + unsupported-scheme tabs as blocked', async () => {
    const { deps } = baseDeps();
    const res = await makeSessionRoutes(deps)['composer/tabs']();
    const byId = Object.fromEntries(res.tabs.map((t: any) => [t.id, t]));
    expect(byId[1].blocked).toBe(false);                 // https://ok.com
    expect(byId[2].blocked).toBe(true);                  // denylisted host
    expect(byId[3].blocked).toBe(true);                  // chrome:// scheme
    expect(byId[1]).toMatchObject({ origin: 'https://ok.com', active: true });
  });
});

describe('subagent + review spawn', () => {
  test('subagent/spawn requires a task', async () => {
    const { deps } = baseDeps();
    expect(await makeSessionRoutes(deps)['subagent/spawn']({ task: '  ' })).toEqual({ ok: false, error: 'task-required' });
  });
  test('subagent/spawn inherits parent depth', async () => {
    const { deps } = baseDeps();
    expect(await makeSessionRoutes(deps)['subagent/spawn']({ task: 'go' })).toEqual({ ok: true, result: { ran: 'go', depth: 2 } });
  });
  test('subagent/spawn no active session', async () => {
    const { deps } = baseDeps({ sessionCache: { sessionGet: async () => null } });
    expect(await makeSessionRoutes(deps)['subagent/spawn']({ task: 'go' })).toEqual({ ok: false, error: 'no-active-session' });
  });
  test('review/run passes parent depth through', async () => {
    const { deps } = baseDeps();
    expect(await makeSessionRoutes(deps)['review/run']({ diff: 'd' })).toEqual({ ok: true, result: { reviewed: true, depth: 2 } });
  });
});
