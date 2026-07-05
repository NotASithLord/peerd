// The pure translation core for the orchestrator's `peerd.actors.*` code
// surface (script tool) — the local twin of a2a-api.test.ts. Proves the
// method table (validation, the ask/send split, oneShot passthrough), the
// result shaping (system failures REJECT), and the ops-trace helpers that
// carry the observability contract (fence-safe lines vs fenced error details).

import { describe, test, expect } from 'bun:test';
import {
  actorsCallToOp, shapeActorsResult, actorsMethodDelegates,
  ACTORS_API_METHODS, ACTORS_ASK_MAX_TIMEOUT_MS, ActorsApiError,
  traceEntryStart, renderTraceLines, traceErrorDetails,
} from '../../extension/peerd-runtime/subagent/actors-api.js';

describe('the method table', () => {
  test('exposes exactly list / ask / send — delegation only, no raw tools', () => {
    expect([...ACTORS_API_METHODS].sort()).toEqual(['ask', 'list', 'send']);
    expect(actorsMethodDelegates('ask')).toBe(true);
    expect(actorsMethodDelegates('send')).toBe(true);
    expect(actorsMethodDelegates('list')).toBe(false);
  });

  test('an unknown method throws (the worker call rejects)', () => {
    expect(() => actorsCallToOp({ method: 'spawn', args: {} })).toThrow(ActorsApiError);
    expect(() => actorsCallToOp({ method: undefined })).toThrow(/unknown actors method/);
  });
});

describe('actorsCallToOp — validation', () => {
  test('ask requires to + goal, clamps timeoutMs, passes oneShot through', () => {
    const r = actorsCallToOp({ method: 'ask', args: { to: 'vm-9', goal: 'run pytest', timeoutMs: 999_999, oneShot: true } });
    expect(r).toEqual({ op: 'ask', args: { to: 'vm-9', goal: 'run pytest', timeoutMs: ACTORS_ASK_MAX_TIMEOUT_MS, oneShot: true }, delegates: true });
    expect(() => actorsCallToOp({ method: 'ask', args: { goal: 'x' } })).toThrow(/to/);
    expect(() => actorsCallToOp({ method: 'ask', args: { to: 'vm-9', goal: '  ' } })).toThrow(/goal/);
  });

  test('ask omits absent options (no undefined keys leak to the wire)', () => {
    const r = actorsCallToOp({ method: 'ask', args: { to: 'web', goal: 'find the price' } });
    expect(r.args).toEqual({ to: 'web', goal: 'find the price' });
  });

  test('send requires to + goal; oneShot rides through', () => {
    expect(actorsCallToOp({ method: 'send', args: { to: 'nb-1', goal: 'chart it', oneShot: true } }).args)
      .toEqual({ to: 'nb-1', goal: 'chart it', oneShot: true });
    expect(() => actorsCallToOp({ method: 'send', args: { to: 'nb-1' } })).toThrow(ActorsApiError);
  });

  test('list takes no args', () => {
    expect(actorsCallToOp({ method: 'list' })).toEqual({ op: 'list', args: {}, delegates: false });
  });
});

describe('shapeActorsResult — system failures reject, actor failures return', () => {
  test('a failed op (gate refusal / rate cap / timeout) THROWS with the system reason', () => {
    expect(() => shapeActorsResult('ask', { ok: false, error: 'message_actor: 4 actor messages already in flight…' }))
      .toThrow(/in flight/);
    expect(() => shapeActorsResult('send', { ok: false })).toThrow(/actors.send failed/);
  });

  test('ask shapes { reply, failed } — an actor-level failure RETURNS (script decides)', () => {
    expect(shapeActorsResult('ask', { ok: true, reply: 'pass: 42 tests', failed: false }))
      .toEqual({ reply: 'pass: 42 tests', failed: false });
    // The actor's turn errored: not a system refusal, so the script gets the
    // failure to handle in code (retry, fall back, report) instead of a throw.
    expect(shapeActorsResult('ask', { ok: true, reply: 'the vm actor failed: …', failed: true }))
      .toEqual({ reply: 'the vm actor failed: …', failed: true });
  });

  test('send shapes { sent }; list shapes the roster string', () => {
    expect(shapeActorsResult('send', { ok: true })).toEqual({ sent: true });
    expect(shapeActorsResult('list', { ok: true, roster: '{"tabs_columns":…}' })).toBe('{"tabs_columns":…}');
  });
});

describe('the ops trace — the observability contract', () => {
  const trace = [
    { seq: 1, method: 'list', ok: true, ms: 12 },
    { seq: 2, method: 'ask', to: 'vm-9', goal: 'run the benchmark suite and return the JSON results table now', ok: true, ms: 2140 },
    { seq: 3, method: 'ask', to: 'web', goal: 'price?', ok: false, ms: 30_000, error: 'ask timed out — <possible page text>' },
  ];

  test('traceEntryStart previews the goal (model-authored → fence-safe) and caps it', () => {
    const e = traceEntryStart(2, 'ask', { to: 'vm-9', goal: 'x'.repeat(100) });
    expect(e.to).toBe('vm-9');
    expect((e.goal ?? '').length).toBeLessThan(70);
    expect(e.goal?.endsWith('…')).toBe(true);
  });

  test('renderTraceLines shows op/target/outcome/timing and NEVER the error detail', () => {
    const lines = renderTraceLines(trace);
    expect(lines.length).toBe(3);
    expect(lines[1]).toContain('#2 ask vm-9');
    expect(lines[1]).toContain('ok 2140ms');
    expect(lines[2]).toContain('FAILED 30000ms');
    // the failure DETAIL (which can carry actor/page-derived bytes) must not
    // appear in the fence-safe lines
    expect(lines.join('\n')).not.toContain('possible page text');
  });

  test('traceErrorDetails carries exactly the failed ops (for the FENCED body)', () => {
    const details = traceErrorDetails(trace);
    expect(details.length).toBe(1);
    expect(details[0]).toContain('#3 ask web');
    expect(details[0]).toContain('possible page text');
  });
});
