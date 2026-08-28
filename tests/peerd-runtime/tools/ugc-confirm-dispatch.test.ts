// security-arc issue 242, the WIRING half: the dispatcher's forced UGC-zone
// confirmation.
//
// The pure predicate (ugcWriteConfirm) has its own exhaustive suite in
// tests/peerd-runtime/actor/ugc-registry.test.ts. This file tests the thing that
// suite cannot: that the dispatcher actually ASKS, on the real dispatch path,
// with confirmations toggled OFF — which is the product default and therefore
// the only configuration in which this protection means anything.
//
// The seam under test is small but load-bearing in three places:
//   1. the override — confirmActions:false must NOT suppress the prompt
//   2. liveTabUrl — the zone is read from the tab NOW, not from the turn-start
//      pin, so a same-origin SPA hop into an issue is still caught
//   3. the attribution — the ruleId reaches the lineage reason and both audit
//      events, so a user can see WHY they were asked

import { describe, test, expect, afterEach } from 'bun:test';
import { createExplicitToolFixture } from './explicit-tool-fixture';

const ISSUE = 'https://github.com/acme/widget/issues/7';
const REPO_ROOT = 'https://github.com/acme/widget';

type Prompt = Record<string, any>;

/**
 * A dispatch context in the PRODUCT DEFAULT posture: Act mode, confirmations
 * OFF. `tabUrl` is what a live tabs.get() would return; `pinUrl` is the
 * turn-start stamp. Passing them differently is how the SPA-hop case is
 * expressed.
 */
const makeCtx = (over: {
  pinUrl?: string | null,
  tabUrl?: string | null,
  tabsThrows?: boolean,
  answer?: string,
  confirmActions?: boolean,
} = {}) => {
  const prompts: Prompt[] = [];
  const audits: any[] = [];
  const pinUrl = over.pinUrl === undefined ? ISSUE : over.pinUrl;
  const ctx: any = {
    audit: async (e: any) => { audits.push(e); },
    confirm: async (p: Prompt) => { prompts.push(p); return over.answer ?? 'yes_once'; },
    session: { sessionId: 's' },
    permission: { mode: 'act', confirmActions: over.confirmActions ?? false },
    activeTab: pinUrl === null ? undefined : { id: 42, url: pinUrl },
    tabs: {
      get: async () => {
        if (over.tabsThrows) throw new Error('tab is gone');
        return { url: over.tabUrl === undefined ? pinUrl : over.tabUrl };
      },
    },
  };
  return { ctx, prompts, audits };
};

const tool = (over: any = {}) => ({
  name: 'click', description: 'd', primitive: 'tab', sideEffect: 'write',
  schema: { type: 'object', properties: {} },
  // The origin gate calls this unconditionally; an empty list keeps the denylist
  // out of these tests, which are about the confirmation step alone.
  origins: () => [],
  execute: async () => ({ ok: true, content: 'clicked' }),
  ...over,
});

const fixture = createExplicitToolFixture();
const dispatchToolCall = fixture.dispatch;
const setFixtureTool = fixture.set;

const run = (ctx: any, name = 'click', args: any = {}) =>
  dispatchToolCall({ id: 't1', name, args } as any, ctx) as Promise<any>;

afterEach(fixture.clear);

describe('UGC-zone forced confirmation (issue 242) — the override', () => {
  test('a write on a UGC page confirms EVEN WITH confirmActions OFF', async () => {
    setFixtureTool(tool() as any);
    const { ctx, prompts } = makeCtx();
    const r = await run(ctx);
    expect(prompts.length).toBe(1);
    expect(r.ok).toBe(true);
  });

  test('the same write on a NON-UGC page of the same host does not confirm', async () => {
    // The registry matches on PATH: the repo root is not attacker-authorable.
    // This is the test that proves the prompt is targeted rather than blanket —
    // a confirm that fires everywhere is one users train themselves to dismiss.
    setFixtureTool(tool() as any);
    const { ctx, prompts } = makeCtx({ pinUrl: REPO_ROOT });
    const r = await run(ctx);
    expect(prompts.length).toBe(0);
    expect(r.ok).toBe(true);
  });

  test('a READ on a UGC page does not confirm', async () => {
    // Reading the issue is the whole point of sending an actor there. Only the
    // authenticated WRITE surface is what an injected comment wants to drive.
    setFixtureTool(tool({ name: 'read_page', sideEffect: 'read' }) as any);
    const { ctx, prompts } = makeCtx();
    await run(ctx, 'read_page');
    expect(prompts.length).toBe(0);
  });

  test('NAVIGATION away from a UGC page does not confirm', async () => {
    // Deliberately exempt: leaving is how the actor finishes, and nagging on
    // ordinary link-following is how a security prompt gets trained away.
    setFixtureTool(tool({ name: 'navigate' }) as any);
    setFixtureTool(tool({ name: 'open_tab', sideEffect: 'mutate_external' }) as any);
    const a = makeCtx();
    await run(a.ctx, 'navigate');
    const b = makeCtx();
    await run(b.ctx, 'open_tab');
    expect(a.prompts.length).toBe(0);
    expect(b.prompts.length).toBe(0);
  });

  test('a non-tab primitive on a UGC page does not confirm', async () => {
    // The user can be sitting on a GitHub issue while the agent writes a file in
    // a Notebook. That tab's session is not the authority being borrowed.
    setFixtureTool(tool({ name: 'js_write_file', primitive: 'notebook' }) as any);
    const { ctx, prompts } = makeCtx();
    await run(ctx, 'js_write_file');
    expect(prompts.length).toBe(0);
  });

  test('a memory tool is not double-prompted (selfConfirms already asks)', async () => {
    setFixtureTool(tool({ name: 'remember', primitive: 'memory' }) as any);
    const { ctx, prompts } = makeCtx();
    await run(ctx, 'remember');
    expect(prompts.length).toBe(0);
  });
});

describe('UGC-zone forced confirmation — the live tab read', () => {
  test('a same-origin SPA hop INTO a UGC path is caught (pin is stale)', async () => {
    // The regression this exists for: ctx.activeTab is stamped at turn start and
    // re-stamped by navigate(), but clicking from a repo root into an issue moves
    // the page with NO tool call. Classification is path-based, so trusting the
    // pin would silently skip the prompt in exactly the case the rule exists for.
    setFixtureTool(tool() as any);
    const { ctx, prompts } = makeCtx({ pinUrl: REPO_ROOT, tabUrl: ISSUE });
    await run(ctx);
    expect(prompts.length).toBe(1);
  });

  test('a same-origin SPA hop OUT of a UGC path stops confirming', async () => {
    setFixtureTool(tool() as any);
    const { ctx, prompts } = makeCtx({ pinUrl: ISSUE, tabUrl: REPO_ROOT });
    await run(ctx);
    expect(prompts.length).toBe(0);
  });

  test('a failed tabs.get() falls back to the pin and still confirms', async () => {
    // Never throws, never blocks dispatch — and a dead tab must not become a way
    // to skip the prompt.
    setFixtureTool(tool() as any);
    const { ctx, prompts } = makeCtx({ pinUrl: ISSUE, tabsThrows: true });
    const r = await run(ctx);
    expect(prompts.length).toBe(1);
    expect(r.ok).toBe(true);
  });

  test('no tab pinned at all → no confirm, no throw (fail-open)', async () => {
    setFixtureTool(tool() as any);
    const { ctx, prompts } = makeCtx({ pinUrl: null });
    const r = await run(ctx);
    expect(prompts.length).toBe(0);
    expect(r.ok).toBe(true);
  });
});

describe('UGC-zone forced confirmation — what the user and the record see', () => {
  test('the prompt carries the plain-language note', async () => {
    setFixtureTool(tool() as any);
    const { ctx, prompts } = makeCtx();
    await run(ctx);
    expect(prompts[0].note).toContain('written by other people');
    expect(prompts[0].note).toContain('your signed-in access');
  });

  test('an ORDINARY confirm carries no note — the common card is unchanged', async () => {
    setFixtureTool(tool() as any);
    const { ctx, prompts } = makeCtx({ pinUrl: REPO_ROOT, confirmActions: true });
    await run(ctx);
    expect(prompts.length).toBe(1);
    expect(prompts[0].note).toBeUndefined();
  });

  test('the matched ruleId rides the lineage reason and the audit event', async () => {
    setFixtureTool(tool() as any);
    const { ctx, audits } = makeCtx();
    const r = await run(ctx);
    const confirmGate = r.meta.gates.find((g: any) => g.name === 'confirmation');
    expect(confirmGate.reason).toContain('[ugc zone: github-issues-pulls]');
    const confirmed = audits.find((a) => a.type === 'tool_confirmed');
    expect(confirmed.details.ugcZone).toBe('github-issues-pulls');
  });

  test('a rejection blocks the call, and the rejection audit names the zone', async () => {
    let ran = false;
    setFixtureTool(tool({ execute: async () => { ran = true; return { ok: true, content: 'x' }; } }) as any);
    const { ctx, audits } = makeCtx({ answer: 'no' });
    const r = await run(ctx);
    expect(ran).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('gate_blocked:confirmation');
    const rejected = audits.find((a) => a.type === 'tool_rejected');
    expect(rejected.details.ugcZone).toBe('github-issues-pulls');
  });

  test('a broken confirm channel fails CLOSED', async () => {
    let ran = false;
    setFixtureTool(tool({ execute: async () => { ran = true; return { ok: true, content: 'x' }; } }) as any);
    const { ctx } = makeCtx();
    ctx.confirm = async () => { throw new Error('side panel is gone'); };
    const r = await run(ctx);
    expect(ran).toBe(false);
    expect(r.ok).toBe(false);
  });

  test('an aborted run dismisses its confirmation and never executes', async () => {
    let ran = false;
    let promptStarted = () => {};
    const waiting = new Promise<void>((resolve) => { promptStarted = resolve; });
    const controller = new AbortController();
    setFixtureTool(tool({ execute: async () => { ran = true; return { ok: true, content: 'x' }; } }) as any);
    const { ctx } = makeCtx({ pinUrl: REPO_ROOT, confirmActions: true });
    ctx.abortSignal = controller.signal;
    ctx.confirm = async (_prompt: Prompt, signal?: AbortSignal) => {
      promptStarted();
      return new Promise((resolve) => signal?.addEventListener('abort', () => resolve('no'), { once: true }));
    };
    const pending = run(ctx);
    await waiting;
    controller.abort();
    const result = await pending;
    expect(ran).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('aborted');
  });
});
