// @ts-check
// Subagent orchestrator — end-to-end with the REAL runUserTurn loop and
// the REAL session store. Only the model is mocked. This is the
// integration the Bun unit tests can't run (they mock the loop): a spawn
// actually creates a child session, drives a turn through the loop, and
// returns the final assistant text.

import { describe, it, expect } from '../../framework.js';
import {
  makeSpawnSubagent, createSessionStore, runUserTurn,
} from '/peerd-runtime/index.js';
import { makeMockIdb } from '../../mocks/idb.js';

/** @typedef {import('/peerd-provider/format/from-anthropic.js').ProviderEvent} ProviderEvent */
/** @typedef {import('/peerd-runtime/sessions/types.js').Session} Session */
/** @typedef {Parameters<typeof makeSpawnSubagent>[0]} SpawnDeps */

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
  /** @type {SpawnDeps} */
  const deps = /** @type {SpawnDeps} */ (/** @type {unknown} */ ({
    sessions,
    runUserTurn,
    callModel: () => mockTextStream('child result text'),
    getSecret: async () => 'sk-test',
    safeFetch: async () => new Response('ok'),
    appendAudit: async (/** @type {any} */ e) => { audits.push(e); },
    buildToolContext: async () => ({ session: {}, audit: async () => {} }),
    dispatchToolCall: async () => ({ ok: true, content: 'ran' }),
    renderSystemPrompt: async () => 'system prompt',
    getToolDescriptors: () => [],
    now: () => (t += 10),
    ...overrides,
  }));
  return { sessions, audits, deps };
};

describe('subagent orchestrator — e2e with real loop', () => {
  it('spawns a child session and returns its final assistant text', async () => {
    const { sessions, deps } = buildDeps();
    const parent = await sessions.create();

    const spawn = makeSpawnSubagent(deps);
    const out = await spawn({ task: 'summarize X', parentSessionId: parent.sessionId, parentDepth: 0 });

    expect(out.result).toBe('child result text');
    expect(out.depth).toBe(1);
    expect(typeof out.sessionId).toBe('string');   // non-null: a real child id

    // The child is a real persisted subagent session with parentage.
    const child = present(await sessions.get(id(out.sessionId)));
    expect(child.kind).toBe('subagent');
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
    const spawn = makeSpawnSubagent(deps);

    const out = await spawn({ task: 't', parentSessionId: parent.sessionId, parentDepth: 5 });
    expect(out.refused).toBe(true);
    expect(out.sessionId).toBe(null);
    expect(audits.some((a) => a.type === 'subagent_refused')).toBe(true);
    // Only the parent exists; no child was written.
    const all = await sessions.list();
    expect(all.length).toBe(1);
  });

  it('tags loop audits with parentage so the trail reads from any level', async () => {
    const { sessions, deps, audits } = buildDeps();
    const parent = await sessions.create();
    const spawn = makeSpawnSubagent(deps);
    const out = await spawn({ task: 't', parentSessionId: parent.sessionId });

    // The loop's own session_started audit flows through the tagged
    // appendAudit, so it carries parentSessionId + depth.
    const started = audits.find((a) => a.type === 'session_started');
    expect(started?.details?.parentSessionId).toBe(parent.sessionId);
    expect(started?.details?.subagentSessionId).toBe(out.sessionId);
    expect(started?.details?.depth).toBe(1);
  });

  it('two-level recursion deepens depth correctly', async () => {
    const { sessions, deps } = buildDeps();
    const parent = await sessions.create();
    const spawn = makeSpawnSubagent(deps);

    const level1 = await spawn({ task: 'a', parentSessionId: parent.sessionId, parentDepth: 0 });
    expect(level1.depth).toBe(1);
    const level2 = await spawn({ task: 'b', parentSessionId: id(level1.sessionId), parentDepth: level1.depth });
    expect(level2.depth).toBe(2);
    const grandchild = present(await sessions.get(id(level2.sessionId)));
    expect(grandchild.parentSessionId).toBe(level1.sessionId);
    expect(grandchild.depth).toBe(2);
  });
});
