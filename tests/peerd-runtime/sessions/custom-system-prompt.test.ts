// Custom system prompts per session (/system) — the pure surfaces:
//   - session store: create/setCustomSystemPrompt persistence semantics
//     ("unset" is the ABSENT key, never an empty string);
//   - renderSystemPrompt: the <session_instructions> block AUGMENTS the
//     base prompt, never replaces it;
//   - subagent spawn: the parent's instructions are deliberately NOT
//     inherited (a subagent gets only its own task framing).

import { describe, test, expect } from 'bun:test';
import { createSessionStore } from '../../../extension/peerd-runtime/sessions/store.js';
import {
  renderSystemPrompt,
  _setTemplateForTests,
} from '../../../extension/peerd-runtime/loop/system-prompt.js';
import { makeSpawnSubagent } from '../../../extension/peerd-runtime/subagent/spawn.js';
import type { Session } from '../../../extension/peerd-runtime/sessions/types.js';
import type { LoopEvent } from '../../../extension/peerd-runtime/loop/agent-loop.js';

// ---- minimal in-memory IDB (keyed by sessionId, like the real wrapper) ----
const makeIdb = () => {
  const stores = new Map<string, Map<string, any>>();
  const tbl = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name)!;
  };
  return {
    get: async (store: string, key: string) => tbl(store).get(key),
    // Key by the store's keyPath: session_messages records carry `id`,
    // session records carry `sessionId` (v8 per-message store).
    put: async (store: string, val: any) => { tbl(store).set(val.id ?? val.sessionId, val); },
    getAll: async (store: string) => [...tbl(store).values()],
  };
};

const makeStore = () => {
  let i = 0;
  return createSessionStore({
    idb: makeIdb(),
    now: () => 1000,
    makeId: () => `id-${++i}`,
  });
};

describe('session store — customSystemPrompt', () => {
  test('create persists a non-empty block and omits everything else', async () => {
    const store = makeStore();
    const withBlock = await store.create({ customSystemPrompt: 'be terse' });
    expect(withBlock.customSystemPrompt).toBe('be terse');

    const without = await store.create({});
    expect('customSystemPrompt' in without).toBe(false);

    const blank = await store.create({ customSystemPrompt: '   ' });
    expect('customSystemPrompt' in blank).toBe(false);
  });

  test('setCustomSystemPrompt sets, replaces, and CLEARS (key removed, not emptied)', async () => {
    const store = makeStore();
    const s = await store.create({});

    // Session annotation: the inferred return union's "cleared" member
    // lacks the key entirely, so property reads need the typedef's shape.
    const set: Session = await store.setCustomSystemPrompt(s.sessionId, 'always answer in French');
    expect(set.customSystemPrompt).toBe('always answer in French');
    expect((await store.get(s.sessionId))!.customSystemPrompt).toBe('always answer in French');

    const replaced: Session = await store.setCustomSystemPrompt(s.sessionId, 'be brief');
    expect(replaced.customSystemPrompt).toBe('be brief');

    const cleared = await store.setCustomSystemPrompt(s.sessionId, null);
    expect('customSystemPrompt' in cleared).toBe(false);
    const reread = await store.get(s.sessionId);
    expect('customSystemPrompt' in reread!).toBe(false);
  });

  test('whitespace-only text clears rather than persisting noise', async () => {
    const store = makeStore();
    const s = await store.create({ customSystemPrompt: 'x' });
    const cleared = await store.setCustomSystemPrompt(s.sessionId, '   \n ');
    expect('customSystemPrompt' in cleared).toBe(false);
  });

  test('clearing preserves every other field on the record', async () => {
    const store = makeStore();
    const s = await store.create({ provider: 'openrouter', model: 'm-1', customSystemPrompt: 'x' });
    await store.appendMessage(s.sessionId, { role: 'user', content: 'hello', id: 'm1', when: 1 });
    const cleared = await store.setCustomSystemPrompt(s.sessionId, null);
    expect(cleared.provider).toBe('openrouter');
    expect(cleared.model).toBe('m-1');
    expect(cleared.messages.length).toBe(1);
    expect(cleared.title).toBe('hello');
  });
});

describe('renderSystemPrompt — <session_instructions> augmentation', () => {
  const TEMPLATE = 'BASE-PROMPT date={{DATE}} {{MEMORY_BLOCK}}{{TEMPORAL_BLOCK}}{{SKILLS_BLOCK}}{{WEB_TAB_POLICY}}{{DWEB_BLOCK}}';

  test('appends a delimited block AFTER the full base prompt — never replaces it', async () => {
    _setTemplateForTests(TEMPLATE);
    const out = await renderSystemPrompt({ customSystemPrompt: 'answer like a pirate' });
    expect(out.includes('BASE-PROMPT')).toBe(true);
    expect(out.includes('<session_instructions>')).toBe(true);
    expect(out.includes('answer like a pirate')).toBe(true);
    expect(out.includes('</session_instructions>')).toBe(true);
    // Augmentation: the base text comes first, the block is appended.
    expect(out.indexOf('BASE-PROMPT')).toBeLessThan(out.indexOf('<session_instructions>'));
    // The framing reminds the model the block cannot override the base.
    expect(out.includes('never override')).toBe(true);
  });

  test('omitted / whitespace-only block collapses to nothing', async () => {
    _setTemplateForTests(TEMPLATE);
    const none = await renderSystemPrompt({});
    expect(none.includes('session_instructions')).toBe(false);
    const blank = await renderSystemPrompt({ customSystemPrompt: '  \n ' });
    expect(blank.includes('session_instructions')).toBe(false);
  });

  test('coexists with a subagent taskOverride (instructions first, task after)', async () => {
    // Production never passes both (subagents do not inherit), but the
    // renderer must stay well-defined if a future caller does.
    _setTemplateForTests(TEMPLATE);
    const out = await renderSystemPrompt({ customSystemPrompt: 'be terse', taskOverride: 'do the thing' });
    expect(out.indexOf('<session_instructions>')).toBeLessThan(out.indexOf('<subagent_task>'));
  });
});

describe('renderSystemPrompt — ephemeral <active_tab> reorientation', () => {
  const TEMPLATE = 'BASE-PROMPT {{MEMORY_BLOCK}}{{TEMPORAL_BLOCK}}{{SKILLS_BLOCK}}{{WEB_TAB_POLICY}}{{DWEB_BLOCK}}';

  test('appends the active tab (title + url) after the base, framed as untrusted context', async () => {
    _setTemplateForTests(TEMPLATE);
    const out = await renderSystemPrompt({ activeTab: { url: 'https://example.com/p', title: 'Example Page' } });
    expect(out.includes('<active_tab>')).toBe(true);
    expect(out.includes('https://example.com/p')).toBe(true);
    expect(out.includes('Example Page')).toBe(true);
    expect(out.indexOf('BASE-PROMPT')).toBeLessThan(out.indexOf('<active_tab>'));
    // Orienting CONTEXT, not an instruction / not trusted page content.
    expect(out.toLowerCase().includes('not an instruction')).toBe(true);
  });

  test('collapses to nothing when absent or urlless (home / non-web tab)', async () => {
    _setTemplateForTests(TEMPLATE);
    expect((await renderSystemPrompt({})).includes('active_tab')).toBe(false);
    expect((await renderSystemPrompt({ activeTab: null })).includes('active_tab')).toBe(false);
    expect((await renderSystemPrompt({ activeTab: { url: '' } })).includes('active_tab')).toBe(false);
  });

  test('renders the url even when the title is empty', async () => {
    _setTemplateForTests(TEMPLATE);
    const out = await renderSystemPrompt({ activeTab: { url: 'https://no-title.example/', title: '' } });
    expect(out.includes('https://no-title.example/')).toBe(true);
    expect(out.includes('<active_tab>')).toBe(true);
  });
});

describe('subagent spawn — customSystemPrompt is NOT inherited', () => {
  // Tiny loop stand-in: render the prompt (so the spy fires), finish.
  async function* loop(ctx: any): AsyncGenerator<LoopEvent> {
    await ctx.getSystemPrompt();
    await ctx.sessions.appendMessage(ctx.sessionId, {
      role: 'assistant', content: 'child done', id: 'a1', when: 2,
    });
    yield { type: 'stop', sessionId: ctx.sessionId, messageId: 'a1', stopReason: 'end_turn' };
  }

  test('the child render gets taskOverride only — no parent session instructions', async () => {
    const store = makeStore();
    const parent = await store.create({ customSystemPrompt: 'parent-only secret style guide' });

    const renderCalls: any[] = [];
    const spawn = makeSpawnSubagent({
      sessions: store,
      runUserTurn: loop,
      callModel: async function* () { yield { type: 'message-stop', stopReason: 'end_turn' }; },
      getSecret: async () => 'sk',
      safeFetch: async () => new Response('ok'),
      appendAudit: async () => {},
      buildToolContext: async () => ({ audit: async () => {} }),
      dispatchToolCall: async () => ({ ok: true, content: 'r' }),
      renderSystemPrompt: async (opts: any) => { renderCalls.push(opts); return 'sys'; },
      getToolDescriptors: () => [],
    });

    const out = await spawn({ task: 'summarize X', parentSessionId: parent.sessionId, parentDepth: 0 });

    expect(renderCalls.length).toBe(1);
    expect(renderCalls[0].taskOverride).toBe('summarize X');
    // The inheritance contract: ABSENT, not empty — the parent's /system
    // text must not leak into the child's prompt in any form.
    expect('customSystemPrompt' in renderCalls[0]).toBe(false);

    // And the child SESSION RECORD carries no copy either.
    const child = await store.get(out.sessionId!);
    expect('customSystemPrompt' in child!).toBe(false);
  });
});
