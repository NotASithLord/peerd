// script — the fence decision matrix over formatRunResult (design 1a) and the
// value-spill footer (1b), plus the workspace opt/spill plumbing through the
// tool's execute. The fence rule under test: a run that touched egress, actors,
// OR the durable workspace is wrapped UNCONDITIONALLY (workspace files are not
// reliably agent-authored — an earlier run may have persisted fetched bytes),
// with an origin label naming every source that applied; pure-compute output
// stays raw. Tool-authored status lines (over-budget nudge, spill footer) ride
// OUTSIDE the fence.

import { describe, test, expect } from 'bun:test';
import { formatRunResult, runIsFenced, runOriginLabel, scriptTool } from '../../../extension/peerd-runtime/tools/defs/script.js';
import { makeEngineRoutes } from '../../../extension/background/routes/engine.js';

const run = (over: Record<string, unknown> = {}) => ({
  durationMs: 5, value: 'out', ...over,
});

const FENCE = '<untrusted_web_content';

const MATRIX: Array<[Record<string, unknown>, boolean, string]> = [
  [{}, false, 'script'],
  [{ usedEgress: true }, true, 'script (fetched web content)'],
  [{ usedActors: true }, true, 'script (actor replies)'],
  [{ usedWorkspace: true }, true, 'script (workspace files)'],
  [{ usedEgress: true, usedActors: true }, true, 'script (fetched web content + actor replies)'],
  [{ usedEgress: true, usedWorkspace: true }, true, 'script (fetched web content + workspace files)'],
  [{ usedActors: true, usedWorkspace: true }, true, 'script (actor replies + workspace files)'],
  [{ usedEgress: true, usedActors: true, usedWorkspace: true }, true, 'script (fetched web content + actor replies + workspace files)'],
];

describe('formatRunResult — fence decision matrix', () => {
  for (const [flags, fenced, label] of MATRIX) {
    test(`flags ${JSON.stringify(flags)} → fenced=${fenced} (${label})`, () => {
      expect(runIsFenced(run(flags) as any)).toBe(fenced);
      expect(runOriginLabel(run(flags) as any)).toBe(label);
      const out = formatRunResult('return 1', run(flags) as any);
      if (fenced) {
        expect(out).toContain(`origin="${label}"`);
        expect(out).toContain(FENCE);
      } else {
        expect(out).not.toContain(FENCE);
      }
    });
  }

  test('a workspace run with NO body (no value/console/error) needs no fence', () => {
    const out = formatRunResult('await peerd.self.writeFile("a","b")', run({ usedWorkspace: true, value: undefined }) as any);
    expect(out).not.toContain(FENCE);
  });

  test('the over-budget nudge is tool-authored and rides OUTSIDE the fence', () => {
    const out = formatRunResult('x', run({ usedWorkspace: true, workspaceOverBudget: true }) as any);
    const afterFence = out.split('</untrusted_web_content>')[1];
    expect(afterFence).toContain('[WORKSPACE OVER BUDGET');
  });

  test('the value-spill footer names the key + read_run_cache, outside the fence', () => {
    const out = formatRunResult('x', run({ usedEgress: true }) as any, { key: 'run:tu-9', total: 123_456 });
    const afterFence = out.split('</untrusted_web_content>')[1];
    expect(afterFence).toContain('read_run_cache');
    expect(afterFence).toContain('"run:tu-9"');
    expect(afterFence).toContain('123456');
  });

  test('no spill → no footer (page_code and existing callers unchanged)', () => {
    expect(formatRunResult('x', run() as any)).not.toContain('read_run_cache');
  });

  test('the generic code-op trace is host-shaped and outside any output fence', () => {
    const out = formatRunResult('x', run({
      usedEgress: true,
      codeTrace: [{ seq: 1, bridge: 'page', method: 'snapshot', outcome: 'ok', ms: 4 }],
    }) as any);
    expect(out).toContain('[CODE OPS]\n#1 page.snapshot → ok (4ms)');
    expect(out.indexOf('[CODE OPS]')).toBeLessThan(out.indexOf(FENCE));
  });
});

// The tool's execute: workspace opt-in rides as workspaceSessionId (a TRUSTED
// job param derived from ctx.session — never from the model beyond the boolean),
// and an overflowing value spills to ctx.runCache stamped with the owning
// session + the run's fence state.
describe('scriptTool.execute — workspace opt + value spill', () => {
  const bigValue = 'v'.repeat(10_000);

  const ctxWith = (over: Record<string, unknown> = {}, result: Record<string, unknown> = {}) => {
    const seen: { opts?: any, put?: any } = {};
    const ctx = {
      session: { sessionId: 'chat-1' },
      jsOffscreenClient: {
        execHeadless: async (_code: string, opts: object) => {
          seen.opts = opts;
          return { durationMs: 1, value: 'small', ...result };
        },
      },
      runCache: { put: async (rec: object) => { seen.put = rec; } },
      toolUseId: 'tu-42',
      ...over,
    };
    return { ctx, seen };
  };

  test('workspace:true passes workspaceSessionId = the session id', async () => {
    const { ctx, seen } = ctxWith();
    await scriptTool.execute({ code: 'return 1', workspace: true }, ctx as any);
    expect(seen.opts.workspaceSessionId).toBe('chat-1');
  });

  test('workspace absent → no workspaceSessionId in the job opts', async () => {
    const { ctx, seen } = ctxWith();
    await scriptTool.execute({ code: 'return 1' }, ctx as any);
    expect(seen.opts.workspaceSessionId).toBeUndefined();
  });

  test('a spawned/actor session is refused the workspace (no teardown event → the subtree would leak)', async () => {
    for (const kind of ['spawned', 'actor']) {
      const { ctx, seen } = ctxWith({ session: { sessionId: 'child-1', kind } });
      await scriptTool.execute({ code: 'return 1', workspace: true }, ctx as any);
      expect(seen.opts.workspaceSessionId).toBeUndefined();
    }
  });

  test('a workspace run mints a runId (Stop plumbing) even without actors code', async () => {
    const registered: string[] = [];
    const released: string[] = [];
    const scriptRuns = {
      mintRunId: (sid: string) => `scriptrun-${sid}-1`,
      register: (runId: string) => { registered.push(runId); },
      abort: () => {},
      release: (runId: string) => { released.push(runId); },
      opsFor: () => [],
    };
    const { ctx, seen } = ctxWith({ scriptRuns });
    await scriptTool.execute({ code: 'return 1', workspace: true }, ctx as any);
    expect(seen.opts.runId).toBe('scriptrun-chat-1-1');
    expect(seen.opts.actors).toBeUndefined();          // workspace alone never grants delegation
    expect(registered).toEqual(['scriptrun-chat-1-1']);
    expect(released).toEqual(['scriptrun-chat-1-1']);  // the finally path unwinds it
  });

  test('a pure-compute run gets a runId so Stop can terminate its worker', async () => {
    const registered: unknown[][] = [];
    const released: string[] = [];
    const { ctx, seen } = ctxWith({
      scriptRuns: {
        mintRunId: () => 'x',
        register: (...args: unknown[]) => { registered.push(args); },
        abort: () => {},
        release: (runId: string) => { released.push(runId); },
        opsFor: () => [],
      },
    });
    await scriptTool.execute({ code: 'return 1' }, ctx as any);
    expect(seen.opts.runId).toBe('x');
    expect(seen.opts.caps).toEqual({ subagent: false });
    expect(registered[0]?.[3]).toEqual({ actors: false, egress: true, provider: false });
    expect(released).toEqual(['x']);
  });

  test('an ordinary script egress run forwards its owner through the job into the SW route', async () => {
    const live = new Map<string, { owner: string, signal?: AbortSignal, caps: Record<string, boolean> }>();
    let fetched = false;
    let jobOpts: any;
    let relayResult: any;
    const scriptRuns = {
      mintRunId: () => 'egress-run',
      register: (runId: string, signal: AbortSignal | undefined, owner: string, caps: Record<string, boolean>) => {
        live.set(runId, { owner, signal, caps });
      },
      ownerFor: (runId: string) => live.get(runId)?.owner,
      allows: (runId: string, cap: string) => live.get(runId)?.caps[cap] === true,
      admitOp: () => true,
      signalFor: (runId: string) => live.get(runId)?.signal,
      abort: () => {},
      release: (runId: string) => { live.delete(runId); },
      opsFor: () => [],
    };
    const routes = makeEngineRoutes({
      vmHttpFetch: async () => { fetched = true; return { ok: true, status: 200 }; },
      applyWebExtract: async (response: any) => response,
      scriptRuns,
      isOffscreenSender: (sender: any) => sender?.url === 'offscreen',
    });
    const ctx = {
      session: { sessionId: 'chat-1' },
      scriptRuns,
      toolUseId: 'tu-egress',
      jsOffscreenClient: {
        execHeadless: async (_code: string, opts: any) => {
          jobOpts = opts;
          relayResult = await (routes['sw/web-fetch'] as any)({
            url: 'https://example.com', runId: opts.runId,
            ownerSessionId: opts.ownerSessionId,
          }, { url: 'offscreen' });
          return { durationMs: 1, value: relayResult };
        },
      },
    };
    await scriptTool.execute({ code: 'return await peerd.egress.fetch("https://example.com")' }, ctx as any);
    expect(jobOpts.ownerSessionId).toBe('chat-1');
    expect(relayResult).toMatchObject({ ok: true, status: 200 });
    expect(fetched).toBe(true);
    expect(live.size).toBe(0);
  });

  test('Stop aborts a pure-compute worker, not just actor/provider runs', async () => {
    const controller = new AbortController();
    const aborted: string[] = [];
    let finish: (value: any) => void = () => {};
    const scriptRuns = {
      mintRunId: () => 'pure-run', register: () => {}, abort: () => {},
      release: () => {}, opsFor: () => [],
    };
    const { ctx } = ctxWith({
      abortSignal: controller.signal,
      scriptRuns,
      jsOffscreenClient: {
        execHeadless: () => new Promise((resolve) => { finish = resolve; }),
        abortHeadless: async (runId: string) => { aborted.push(runId); },
      },
    });
    const pending = scriptTool.execute({ code: 'for (;;) {}' }, ctx as any);
    await Promise.resolve();
    controller.abort();
    expect(aborted).toEqual(['pure-run']);
    finish({ durationMs: 1, value: undefined, error: 'job aborted (Stop)' });
    await pending;
  });

  test('an overflowing value spills to runCache stamped with session + fence state, and the result carries the footer', async () => {
    const { ctx, seen } = ctxWith({}, { value: bigValue, usedWorkspace: true });
    const r = await scriptTool.execute({ code: 'return big', workspace: true }, ctx as any);
    expect(r.ok).toBe(true);
    expect(seen.put).toMatchObject({
      key: 'run:tu-42', ownerSessionId: 'chat-1',
      fenced: true, originLabel: 'script (workspace files)',
    });
    expect(seen.put.text.length).toBeGreaterThan(10_000);   // the FULL serialized value
    if (r.ok) expect(r.content).toContain('read_run_cache');
  });

  test('a small value does not spill', async () => {
    const { ctx, seen } = ctxWith();
    await scriptTool.execute({ code: 'return 1' }, ctx as any);
    expect(seen.put).toBeUndefined();
  });

  test('a pure-compute overflow spills UNFENCED (the agent\'s own bytes)', async () => {
    const { ctx, seen } = ctxWith({}, { value: bigValue });
    await scriptTool.execute({ code: 'return big' }, ctx as any);
    expect(seen.put).toMatchObject({ fenced: false, originLabel: 'script' });
  });

  test('a failed spill still returns the capped result (best-effort)', async () => {
    const { ctx } = ctxWith({ runCache: { put: async () => { throw new Error('idb dead'); } } }, { value: bigValue });
    const r = await scriptTool.execute({ code: 'return big' }, ctx as any);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.content).toContain('[VALUE TRUNCATED');
      expect(r.content).not.toContain('read_run_cache');
    }
  });
});
