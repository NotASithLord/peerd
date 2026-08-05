// Design 5 — the script tool's sub-model lane: the caps.provider MINT (the
// actorsOn pattern — only when the code references peerd.provider, with the
// delegation-sized wall-clock and a registered owner-bound runId) and the
// fence-safe [MODEL CALLS] meter line in formatRunResult.

import { describe, test, expect } from 'bun:test';
import { scriptTool, formatRunResult } from '../../../extension/peerd-runtime/tools/defs/script.js';
import {
  ACTORS_JOB_DEFAULT_TIMEOUT_MS,
} from '../../../extension/peerd-runtime/actor/actors-api.js';

const makeScriptRuns = () => {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  return {
    calls,
    mintRunId: (sid: string) => { calls.push({ fn: 'mintRunId', args: [sid] }); return `run-${sid}`; },
    register: (...args: unknown[]) => { calls.push({ fn: 'register', args }); },
    abort: () => {},
    release: (...args: unknown[]) => { calls.push({ fn: 'release', args }); },
    opsFor: () => [],
  };
};

const run = async (code: string, ctxOver: Record<string, unknown> = {}) => {
  let seen: Record<string, unknown> | null = null;
  const scriptRuns = makeScriptRuns();
  const ctx = {
    session: { sessionId: 's1' },
    jsOffscreenClient: {
      execHeadless: async (_code: string, opts: Record<string, unknown>) => {
        seen = opts;
        return { durationMs: 1, value: 'ok' };
      },
    },
    scriptRuns,
    ...ctxOver,
  };
  const result = await scriptTool.execute({ code }, ctx as any);
  return { result, opts: seen as Record<string, unknown> | null, scriptRuns };
};

describe('script — the caps.provider mint (design 5)', () => {
  test('code referencing peerd.provider mints the cap, an owner-bound runId, and the delegation wall-clock', async () => {
    const { result, opts, scriptRuns } = await run('const r = await peerd.provider.call({ prompt: "x" }); return r.text;');
    expect(result.ok).toBe(true);
    expect(opts?.caps).toEqual({ subagent: false, provider: true });
    expect(opts?.ownerSessionId).toBe('s1');
    expect(opts?.runId).toBe('run-s1');
    expect(opts?.timeoutMs).toBe(ACTORS_JOB_DEFAULT_TIMEOUT_MS);
    // registered with the OWNER (the relay's foreign-run check), released after
    const reg = scriptRuns.calls.find((c) => c.fn === 'register');
    expect(reg?.args[2]).toBe('s1');
    expect(scriptRuns.calls.some((c) => c.fn === 'release')).toBe(true);
    // no actors surface minted — provider alone never grants delegation
    expect(opts?.actors).toBeUndefined();
  });

  test('a pure-compute run is Stop-bound but mints no actor/provider capability', async () => {
    const { opts, scriptRuns } = await run('return 6 * 7;');
    expect(opts?.caps).toEqual({ subagent: false });
    expect(opts?.runId).toBe('run-s1');
    expect(opts?.timeoutMs).toBe(30_000);
    const reg = scriptRuns.calls.find((c) => c.fn === 'register');
    expect(reg?.args[3]).toEqual({ actors: false, provider: false });
    expect(scriptRuns.calls.some((c) => c.fn === 'release')).toBe(true);
  });

  test('an actor/spawned session cannot mint the cap (the SW route refuses it anyway)', async () => {
    for (const kind of ['actor', 'spawned']) {
      const { opts } = await run(
        'return peerd.provider;',
        { session: { sessionId: 's1', kind } },
      );
      expect(opts?.caps).toEqual({ subagent: false });
      expect(opts?.runId).toBe('run-s1');
    }
  });
});

describe('script — the actors mint is refused on an inbound (untrusted) turn (INV-5)', () => {
  const actorsCtx = () => ({ messageActor: () => {} });

  test('baseline: a chat turn referencing `actors` mints the delegation surface', async () => {
    const { opts } = await run('await actors.ask("web", "x");', actorsCtx());
    expect(opts?.actors).toBe(true);
    expect(opts?.ownerSessionId).toBe('s1');
  });

  test('a trusted spawned actor gets code parity when message_actor survived narrowing', async () => {
    const { opts, scriptRuns } = await run('return (await actors.ask("vm-1", "run tests")).reply;', {
      ...actorsCtx(),
      session: { sessionId: 'spawn-1', kind: 'spawned' },
      toolAllow: new Set(['script', 'message_actor']),
    });
    expect(opts?.actors).toBe(true);
    expect(opts?.ownerSessionId).toBe('spawn-1');
    expect(opts?.runId).toBe('run-spawn-1');
    expect(opts?.caps).toEqual({ subagent: false });
    const reg = scriptRuns.calls.find((c) => c.fn === 'register');
    expect(reg?.args[3]).toEqual({ actors: true, provider: false });
  });

  test('every script disables hidden peerd.runtime.runAgent, even without actors code', async () => {
    const { opts } = await run('return peerd.runtime.runAgent({ task: "escape" });', {
      session: { sessionId: 'spawn-1', kind: 'spawned' },
      toolAllow: new Set(['script']),
    });
    expect(opts?.caps).toEqual({ subagent: false });
    expect(opts?.runId).toBe('run-spawn-1');
  });

  test('a spawned actor without message_actor cannot recover delegation through script', async () => {
    const { opts, scriptRuns } = await run('return await actors.list();', {
      session: { sessionId: 'spawn-1', kind: 'spawned' },
      toolAllow: new Set(['script']),
    });
    expect(opts?.actors).toBeUndefined();
    const reg = scriptRuns.calls.find((c) => c.fn === 'register');
    expect(reg?.args[3]).toEqual({ actors: false, provider: false });
  });

  test('a chat manifest that removes message_actor cannot recover it through script', async () => {
    const { opts } = await run('await actors.ask("web", "x");', {
      ...actorsCtx(), toolAllow: new Set(['script']),
    });
    expect(opts?.actors).toBeUndefined();
  });

  test('a bound environment actor remains non-delegating even if a malformed ctx carries the closure', async () => {
    const { opts } = await run('await actors.ask("web", "x");', {
      ...actorsCtx(), session: { sessionId: 'actor-1', kind: 'actor' },
    });
    expect(opts?.actors).toBeUndefined();
  });

  test('an INBOUND turn does NOT mint the actors surface — the second door through the inbound wall is closed', async () => {
    // The sender gate refuses a DIRECT message_actor on an inbound turn; the
    // script tool must not hand that same delegation reach through a relay that
    // never carried the flag. ctx.inbound is folded SW-side (trusted); the fix
    // fails closed at the mint so no surface is ever advertised.
    const { opts, scriptRuns } = await run('await actors.ask("site:https://mail.example.com", "x");', {
      ...actorsCtx(), inbound: true,
    });
    expect(opts?.actors).toBeUndefined();
    // It still gets a Stop-bound run, with no delegation authority.
    const reg = scriptRuns.calls.find((c) => c.fn === 'register');
    expect(reg?.args[3]).toEqual({ actors: false, provider: false });
  });
});

describe('formatRunResult — the [MODEL CALLS] meter line', () => {
  test('a provider-using run always shows the host-counted meter, fence-free', () => {
    const out = formatRunResult('code', {
      durationMs: 5, value: 'v', usedProvider: true, providerCalls: 3, providerTokens: 1234,
    });
    expect(out).toContain('[MODEL CALLS 3 | tokens 1234]');
    expect(out).not.toContain('<untrusted');   // no new fence condition (design 5)
  });

  test('the meter line stays OUTSIDE the fence when the run also touched the web', () => {
    const out = formatRunResult('code', {
      durationMs: 5, value: 'v', usedEgress: true, usedProvider: true, providerCalls: 1, providerTokens: 10,
    });
    const fenceStart = out.indexOf('fetched web content');
    const meterAt = out.indexOf('[MODEL CALLS 1 | tokens 10]');
    expect(meterAt).toBeGreaterThan(-1);
    expect(fenceStart).toBeGreaterThan(meterAt);   // meter renders before the fenced body
  });

  test('a run that never sub-called shows no meter line', () => {
    const out = formatRunResult('code', { durationMs: 5, value: 'v' });
    expect(out).not.toContain('[MODEL CALLS');
  });
});
