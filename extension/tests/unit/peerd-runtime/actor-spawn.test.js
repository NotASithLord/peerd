// @ts-check
// Actor orchestrator — end-to-end with the REAL runUserTurn loop and
// the REAL session store. Only the model is mocked. This is the
// integration the Bun unit tests can't run (they mock the loop): a spawn
// actually creates a child session, drives a turn through the loop, and
// returns the final assistant text. See docs/ACTORS.md.

import { describe, it, expect } from '../../framework.js';
import {
  makeSpawnActor, createSessionStore, runUserTurn,
} from '/peerd-runtime/index.js';
import {
  makeInMemorySessions, runActorLoop,
} from '/peerd-runtime/actor/actor-worker-core.js';
import { makeMockIdb } from '../../mocks/idb.js';

/** @typedef {import('/peerd-provider/format/from-anthropic.js').ProviderEvent} ProviderEvent */
/** @typedef {import('/peerd-runtime/sessions/types.js').Session} Session */
/** @typedef {Parameters<typeof makeSpawnActor>[0]} SpawnDeps */

// why: sessions.get() returns `Session | undefined` and spawn() returns a
// `sessionId: string | null` — both are always concrete in these tests.
// Cast (don't `!`) to keep the prod types honest at the read.
/** @param {Session | undefined} s @returns {Session} */
const present = (s) => /** @type {Session} */ (s);
/** @param {string | null} v @returns {string} */
const id = (v) => /** @type {string} */ (v);

/** @param {string} text @returns {AsyncGenerator<ProviderEvent>} */
async function* mockTextStream(text) {
  yield { type: 'text-delta', text };
  yield { type: 'message-stop', stopReason: 'end_turn' };
}

/** @param {Record<string, any>} [overrides] */
const buildDeps = (overrides = {}) => {
  const idb = makeMockIdb();
  let i = 0;
  const sessions = createSessionStore({ idb, now: () => 1000, makeId: () => `id-${++i}` });
  /** @type {any[]} */
  const audits = [];
  let t = 0;
  const callModel = (/** @type {any} */ _args) => mockTextStream('child result text');
  /** @type {SpawnDeps} */
  const deps = /** @type {SpawnDeps} */ (/** @type {unknown} */ ({
    sessions,
    appendAudit: async (/** @type {any} */ e) => { audits.push(e); },
    renderSystemPromptForChild: async () => 'system prompt',
    runChildOffscreen: async (/** @type {any} */ job, /** @type {any} */ opts = {}) => {
      const workerSessions = makeInMemorySessions({
        sessionId: job.sessionId, provider: job.provider, model: job.model, depth: job.depth,
      });
      const result = await runActorLoop({
        runUserTurn,
        sessions: workerSessions,
        callModel,
        toolDispatch: async () => ({ ok: true, content: 'ran' }),
        getSystemPrompt: () => job.systemPrompt,
        appendAudit: async () => {},
        onEvent: opts.onEvent,
        tools: job.tools ?? [],
      }, {
        sessionId: job.sessionId, userText: job.task, maxSteps: job.maxSteps,
        signal: opts.signal,
      });
      return { ok: true, started: true, ...result };
    },
    getToolDescriptors: () => [],
    now: () => (t += 10),
    ...overrides,
  }));
  return { sessions, audits, deps };
};

describe('actor orchestrator — e2e with real loop', () => {
  it('spawns a child session and returns its final assistant text', async () => {
    const { sessions, deps } = buildDeps();
    const parent = await sessions.create();

    const spawn = makeSpawnActor(deps);
    const out = await spawn({ task: 'summarize X', parentSessionId: parent.sessionId, parentDepth: 0 });

    expect(out.result).toBe('child result text');
    expect(out.depth).toBe(1);
    expect(typeof out.sessionId).toBe('string');   // non-null: a real child id

    // The child is a real persisted actor session with parentage.
    const child = present(await sessions.get(id(out.sessionId)));
    expect(child.kind).toBe('spawned');
    expect(child.parentSessionId).toBe(parent.sessionId);
    expect(child.depth).toBe(1);
    expect(child.task).toBe('summarize X');
    // user task message + assistant reply.
    expect(child.messages.length).toBe(2);
    expect(child.messages[0].role).toBe('user');
    expect(child.messages[0].content).toBe('summarize X');
    expect(child.messages[1].role).toBe('assistant');
    expect(child.messages[1].content).toBe('child result text');
  });

  it('refuses past maxDepth and creates no session', async () => {
    const { sessions, deps, audits } = buildDeps();
    const parent = await sessions.create();
    const spawn = makeSpawnActor(deps);

    const out = await spawn({ task: 't', parentSessionId: parent.sessionId, parentDepth: 5 });
    expect(out.refused).toBe(true);
    expect(out.sessionId).toBe(null);
    expect(audits.some((a) => a.type === 'actor_refused')).toBe(true);
    // Only the parent exists; no child was written.
    const all = await sessions.list();
    expect(all.length).toBe(1);
  });

  it('tags lifecycle audits with parentage so the trail reads from any level', async () => {
    const { sessions, deps, audits } = buildDeps();
    const parent = await sessions.create();
    const spawn = makeSpawnActor(deps);
    const out = await spawn({ task: 't', parentSessionId: parent.sessionId });

    const started = audits.find((a) => a.type === 'actor_ran_isolated');
    expect(started?.details?.parentSessionId).toBe(parent.sessionId);
    expect(started?.details?.actorSessionId).toBe(out.sessionId);
    expect(started?.details?.depth).toBe(1);
  });

  it('two-level recursion deepens depth correctly', async () => {
    const { sessions, deps } = buildDeps();
    const parent = await sessions.create();
    const spawn = makeSpawnActor(deps);

    const level1 = await spawn({ task: 'a', parentSessionId: parent.sessionId, parentDepth: 0 });
    expect(level1.depth).toBe(1);
    const level2 = await spawn({ task: 'b', parentSessionId: id(level1.sessionId), parentDepth: level1.depth });
    expect(level2.depth).toBe(2);
    const grandchild = present(await sessions.get(id(level2.sessionId)));
    expect(grandchild.parentSessionId).toBe(level1.sessionId);
    expect(grandchild.depth).toBe(2);
  });
});
