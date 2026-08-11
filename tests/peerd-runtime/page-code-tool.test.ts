// PR #119 — the page_code tool. It runs the code-surface web actor's script in
// the headless worker, under a FIXED capability profile (page + compute only)
// and carrying the actor's OWN session as the trusted owner id (the page bridge
// keys the owned tab off it, SW-side). These pin that contract without a worker:
// caps are never caller-supplied, the owner id is ctx.session's, and a ctx with
// no session fails closed (the page surface is never anonymous).

import { describe, test, expect, mock } from 'bun:test';
import { pageCodeTool, PAGE_CODE_CAPS } from '../../extension/peerd-runtime/tools/defs/page-code.js';

const RESULT = { value: 'ok', consoleOutput: [], durationMs: 5, error: null };

const ctxWith = (over: object = {}) => {
  const execHeadless = mock(async (_code: string, _opts: object) => RESULT);
  const scriptRuns = {
    mintRunId: mock(() => 'run-page-1'), register: mock(() => {}), release: mock(() => {}),
  };
  const ctx = { session: { sessionId: 's-web-1' }, jsOffscreenClient: { execHeadless }, scriptRuns, ...over };
  return { ctx, execHeadless };
};

describe('page_code — the code-REPL action tool', () => {
  test('the locked profile is page + compute only (no egress / subagent / opfs)', () => {
    expect(PAGE_CODE_CAPS).toEqual({ page: true, egress: false, subagent: false, opfs: false });
  });

  test('runs the script with the FIXED caps + the actor session as owner (not caller-supplied)', async () => {
    const { ctx, execHeadless } = ctxWith();
    const out = await pageCodeTool.execute({ code: 'await page.goto("https://example.com"); return 1' }, ctx as any);
    expect(out.ok).toBe(true);
    expect(execHeadless).toHaveBeenCalledTimes(1);
    const [code, opts] = execHeadless.mock.calls[0];
    expect(code).toContain('page.goto');
    // caps are the tool's constant — a script cannot widen them.
    expect((opts as any).caps).toEqual(PAGE_CODE_CAPS);
    // owner is the ctx session id — the SW route resolves the owned tab from it.
    expect((opts as any).ownerSessionId).toBe('s-web-1');
    expect((opts as any).runId).toBe('run-page-1');
  });

  test('fails closed with no actor session — the page surface is never anonymous', async () => {
    const { ctx, execHeadless } = ctxWith({ session: undefined });
    const out = await pageCodeTool.execute({ code: 'return 1' }, ctx as any);
    expect(out).toEqual({ ok: false, error: 'page_code_requires_actor_session' });
    expect(execHeadless).not.toHaveBeenCalled();
  });

  test('empty code is rejected; a missing client is reported, not thrown', async () => {
    const empty = await pageCodeTool.execute({ code: '' }, ctxWith().ctx as any);
    expect(empty).toEqual({ ok: false, error: 'code_required' });
    const noClient = await pageCodeTool.execute({ code: 'return 1' }, { session: { sessionId: 's1' } } as any);
    expect(noClient).toEqual({ ok: false, error: 'page_code_unavailable' });
  });

  test('returns host-captured page policies even when code returns another value', async () => {
    const browserPolicy = {
      reason: 'protected_child_navigation', outcome: 'not_run', child: 'closed', retryable: false,
    };
    const { ctx } = ctxWith({
      jsOffscreenClient: {
        execHeadless: async () => ({ ...RESULT, value: 'discarded click result', browserPolicies: [browserPolicy] }),
      },
    });
    const out: any = await pageCodeTool.execute({ code: 'await page.click("#open"); return 1' }, ctx as any);
    expect(out.browserChildPolicyNotices).toEqual([browserPolicy]);
    expect(out.content).not.toContain('protected_child_navigation');
  });

  test('propagates a terminal inner page policy to the outer actor turn', async () => {
    const { ctx } = ctxWith({
      jsOffscreenClient: {
        execHeadless: async () => ({
          ...RESULT, endTurn: true, endTurnContent: 'Finish signing in in the open tab.',
        }),
      },
    });
    expect(await pageCodeTool.execute({ code: 'await page.goto("https://idp.test")' }, ctx as any)).toEqual({
      ok: false,
      error: 'page_code_ended_for_host_policy',
      content: 'Finish signing in in the open tab.',
      endTurn: true,
      outcomeKind: 'effect-completed',
    });
  });

  test('preserves a pre-effect form refusal through the outer actor turn', async () => {
    const { ctx } = ctxWith({
      jsOffscreenClient: {
        execHeadless: async () => ({
          ...RESULT,
          endTurn: true,
          endTurnContent: 'This form submits to another site. Nothing was submitted.',
          endTurnOutcomeKind: 'pre-effect-failure',
        }),
      },
    });
    expect(await pageCodeTool.execute({ code: 'await page.click("#send")' }, ctx as any)).toEqual({
      ok: false,
      error: 'page_code_ended_for_host_policy',
      content: 'This form submits to another site. Nothing was submitted.',
      endTurn: true,
      outcomeKind: 'pre-effect-failure',
    });
  });

  test('is a web-primitive, write-effect tool that names no static origins', () => {
    expect(pageCodeTool.name).toBe('page_code');
    expect(pageCodeTool.primitive).toBe('web');
    expect(pageCodeTool.sideEffect).toBe('write');
    expect(pageCodeTool.origins?.({}, {} as any)).toEqual([]);
  });
});
