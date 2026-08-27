// a2a_run's Stop plumbing (#153): the tool must mint + thread a runId so the
// offscreen runner can register the job, wire the dispatch abort signal to
// abortHeadless so Stop terminates the worker promptly, refuse to launch on an
// already-stopped turn, and detach its listener once the run settles. Mirrors
// the message-actor test style: a recording ctx pins what execute() forwards.

import { describe, test, expect } from 'bun:test';
import { a2aRunTool } from '../../../extension/peerd-runtime/tools/defs/a2a-run.js';
import { createDwebToolAuthority } from '../../../extension/background/dweb-tool-authority.js';

const RESULT = { value: 'ok', consoleOutput: [], durationMs: 1, error: null };
const runRegistry = () => ({
  mintRunId: () => 'run-a2a-1', register: () => {}, release: () => {},
});

// Typed `any` (like tests/.../message-actor.test.ts) — the mock only needs the
// slots a2a_run actually reads.
const makeCtx = (over: any = {}) => {
  const seen: { exec?: any; aborts: Array<{ runId: string; owner?: string }> } = { aborts: [] };
  const ctx: any = {
    session: { sessionId: 'dweb-1' },
    dweb: {},
    jsOffscreenClient: {
      execHeadless: async (_code: string, opts: any) => { seen.exec = opts; return RESULT; },
      abortHeadless: async (runId: string, owner?: string) => { seen.aborts.push({ runId, owner }); },
    },
    scriptRuns: runRegistry(),
    ...over,
  };
  return { ctx, seen };
};

const executeA2A = (args: any, ctx: any) => a2aRunTool.execute(args, {
  dwebAuthority: createDwebToolAuthority({
    call: { name: 'a2a_run', args }, ctx, signal: ctx.abortSignal,
  }),
} as any);

describe('a2a_run — Stop plumbing (#153)', () => {
  test('threads a minted runId (+ owner) into the job so the runner can register it', async () => {
    const { ctx, seen } = makeCtx();
    const r = await executeA2A({ code: 'return await mesh.peers();' }, ctx);
    expect(r.ok).toBe(true);
    expect(seen.exec.a2a).toBe(true);
    expect(seen.exec.ownerSessionId).toBe('dweb-1');
    expect(seen.exec.runId).toBe('run-a2a-1');
  });

  test('aborting the turn mid-run calls abortHeadless with the run id + owner', async () => {
    const controller = new AbortController();
    const seen: { exec?: any; aborts: Array<{ runId: string; owner?: string }> } = { aborts: [] };
    const ctx: any = {
      session: { sessionId: 'dweb-1' },
      dweb: {},
      abortSignal: controller.signal,
      jsOffscreenClient: {
        execHeadless: async (_code: string, opts: any) => {
          seen.exec = opts;
          controller.abort();                    // Stop lands while the job is in flight
          await new Promise((r) => setTimeout(r, 5));
          return RESULT;
        },
        abortHeadless: async (runId: string, owner?: string) => { seen.aborts.push({ runId, owner }); },
      },
      scriptRuns: runRegistry(),
    };
    await executeA2A({ code: 'return 1;' }, ctx);
    expect(seen.aborts).toEqual([{ runId: seen.exec.runId, owner: 'dweb-1' }]);
  });

  test('a turn already stopped refuses to launch a worker at all', async () => {
    const controller = new AbortController();
    controller.abort();
    const { ctx, seen } = makeCtx({ abortSignal: controller.signal });
    const r = await executeA2A({ code: 'return 1;' }, ctx);
    expect(r.ok).toBe(false);
    expect(String((r as { error?: string }).error)).toContain('a2a_aborted');
    expect(seen.exec).toBeUndefined();           // no worker was launched
  });

  test('the abort listener detaches after the run — a later Stop cannot abort a finished job', async () => {
    const controller = new AbortController();
    const { ctx, seen } = makeCtx({ abortSignal: controller.signal });
    await executeA2A({ code: 'return 1;' }, ctx);
    controller.abort();                          // fires AFTER the run settled
    await new Promise((r) => setTimeout(r, 5));
    expect(seen.aborts).toEqual([]);
  });
});
