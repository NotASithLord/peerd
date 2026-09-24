// The pure translation core for the orchestrator's `peerd.actors.*` code
// surface (script tool) — the local twin of a2a-api.test.ts. Proves the
// method table (validation + oneShot passthrough), the
// result shaping (system failures REJECT), and the ops-trace helpers that
// carry the observability contract (fence-safe lines vs fenced error details).

import { describe, test, expect } from 'bun:test';
import {
  actorsCallToOp, shapeActorsResult,
  ACTORS_API_METHODS, ACTORS_CALL_MAX_TIMEOUT_MS, ACTORS_BRIDGE_GUARD_MS,
  ACTORS_ADDRESS_MAX_CHARS, ACTORS_GOAL_MAX_CHARS, ACTORS_TRACE_ERROR_MAX_CHARS,
  ACTORS_JOB_DEFAULT_TIMEOUT_MS, ACTORS_JOB_MAX_TIMEOUT_MS, ActorsApiError,
  renderTraceLines, traceGoalLines, traceErrorDetails,
} from '../../extension/peerd-runtime/actor/actors-api.js';

describe('the method table', () => {
  test('exposes exactly list / call — GenServer request-reply, no fake cast', () => {
    expect([...ACTORS_API_METHODS].sort()).toEqual(['call', 'list']);
    expect(actorsCallToOp({ method: 'call', args: { address: 'web', message: 'x' } }).delegates).toBe(true);
    expect(actorsCallToOp({ method: 'list' }).delegates).toBe(false);
  });

  test('an unknown method throws (the worker call rejects)', () => {
    expect(() => actorsCallToOp({ method: 'spawn', args: {} })).toThrow(ActorsApiError);
    expect(() => actorsCallToOp({ method: 'ask', args: {} })).toThrow(ActorsApiError);
    expect(() => actorsCallToOp({ method: undefined })).toThrow(/unknown actors method/);
  });

  test('an oversized unknown method is rejected without copying it into the error', () => {
    const method = 'M'.repeat(1_000_000);
    expect(() => actorsCallToOp({ method, args: {} }))
      .toThrow('unknown actors method: [oversized]');
  });
});

describe('actorsCallToOp — validation', () => {
  test('call requires address + message, clamps timeoutMs, passes oneShot through', () => {
    const r = actorsCallToOp({ method: 'call', args: { address: 'vm-9', message: 'run pytest', timeoutMs: 999_999, oneShot: true } });
    expect(r).toEqual({ op: 'call', args: { to: 'vm-9', goal: 'run pytest', timeoutMs: ACTORS_CALL_MAX_TIMEOUT_MS, oneShot: true }, delegates: true });
    expect(() => actorsCallToOp({ method: 'call', args: { message: 'x' } })).toThrow(/address/);
    expect(() => actorsCallToOp({ method: 'call', args: { address: 'vm-9', message: '  ' } })).toThrow(/message/);
  });

  test('call rejects the retired to / goal argument aliases', () => {
    expect(() => actorsCallToOp({
      method: 'call', args: { to: 'web', message: 'inspect it' },
    })).toThrow(/address/);
    expect(() => actorsCallToOp({
      method: 'call', args: { address: 'web', goal: 'inspect it' },
    })).toThrow(/message/);
  });

  test('call omits absent options (no undefined keys leak to the wire)', () => {
    const r = actorsCallToOp({ method: 'call', args: { address: 'web', message: 'find the price' } });
    expect(r.args).toEqual({ to: 'web', goal: 'find the price' });
  });

  test('address and goal caps reject before whitespace normalization', () => {
    expect(() => actorsCallToOp({
      method: 'call',
      args: { address: ' '.repeat(ACTORS_ADDRESS_MAX_CHARS + 1), message: 'x' },
    })).toThrow(`at most ${ACTORS_ADDRESS_MAX_CHARS} characters`);
    expect(() => actorsCallToOp({
      method: 'call',
      args: { address: 'web', message: ' '.repeat(ACTORS_GOAL_MAX_CHARS + 1) },
    })).toThrow(`at most ${ACTORS_GOAL_MAX_CHARS} characters`);
  });

  test('numeric tab handles from actors.list normalize to message_actor addresses', () => {
    expect(actorsCallToOp({ method: 'call', args: { address: 42, message: 'inspect it' } }).args.to)
      .toBe('42');
  });

  test('list takes no args', () => {
    expect(actorsCallToOp({ method: 'list' })).toEqual({ op: 'list', args: {}, delegates: false });
  });
});

describe('shapeActorsResult — system failures reject, actor failures return', () => {
  test('a failed op (gate refusal / rate cap / timeout) THROWS with the system reason', () => {
    expect(() => shapeActorsResult('call', { ok: false, error: 'message_actor: 4 actor messages already in flight…' }))
      .toThrow(/in flight/);
  });

  test('call shapes { reply, failed }; an actor-level failure RETURNS (script decides)', () => {
    expect(shapeActorsResult('call', { ok: true, reply: 'pass: 42 tests', failed: false }))
      .toEqual({ reply: 'pass: 42 tests', failed: false });
    // The actor's turn errored: not a system refusal, so the script gets the
    // failure to handle in code (retry, fall back, report) instead of a throw.
    expect(shapeActorsResult('call', { ok: true, reply: 'the vm actor failed: …', failed: true }))
      .toEqual({ reply: 'the vm actor failed: …', failed: true });
  });

  test('list returns structured, string-normalized refs', () => {
    const refs = [{ ref: '42', type: 'tab', name: 'Docs', live: true, current: false, detail: 'https://example.com' }];
    expect(shapeActorsResult('list', { ok: true, refs })).toEqual({ refs });
  });
});

describe('the ops trace — the observability contract', () => {
  const trace = [
    { seq: 1, method: 'list', ok: true, ms: 12, settled: true },
    { seq: 2, method: 'call', to: 'vm-9', goal: 'run the benchmark suite and return the JSON results table now', ok: true, ms: 2140, settled: true },
    { seq: 3, method: 'call', to: 'web', goal: 'price?', ok: false, ms: 30_000, settled: true, error: 'call timed out: <possible page text>' },
  ];

  test('the fence-safe lines carry NOTHING runtime-shaped: no goal, dynamic target, or error detail', () => {
    const lines = renderTraceLines(trace);
    expect(lines.length).toBe(3);
    expect(lines[1]).toContain('#2 call [target redacted]');
    expect(lines[1]).toContain('ok 2140ms');
    expect(lines[2]).toContain('FAILED 30000ms');
    const joined = lines.join('\n');
    // a chained goal / an error detail can carry actor/page-derived bytes —
    // neither may appear outside the fence
    expect(joined).not.toContain('benchmark');
    expect(joined).not.toContain('possible page text');
    expect(joined).not.toContain('vm-9');
  });

  test('an allowed-character instruction target is redacted outside the fence', () => {
    const payload = 'IGNORE_PREVIOUS_INSTRUCTIONS';
    const [line] = renderTraceLines([{ seq: 1, method: 'call', to: payload, ok: true, ms: 5, settled: true }]);
    expect(line).not.toContain(payload);
    expect(line).toContain('[target redacted]');
  });

  test('a very large dynamic target is rejected before safe-label matching', () => {
    const payload = 'A'.repeat(1_000_000);
    const [line] = renderTraceLines([{ seq: 1, method: 'call', to: payload, ok: true, ms: 5, settled: true }]);
    expect(line).toBe('  #1 call [target redacted] → ok 5ms');
  });

  test('fixed singleton and numeric tab handles remain visible outside the fence', () => {
    const lines = renderTraceLines([
      { seq: 1, method: 'call', to: 'web', ok: true, ms: 5, settled: true },
      { seq: 2, method: 'call', to: 'dweb', ok: true, ms: 5, settled: true },
      { seq: 3, method: 'call', to: '42', ok: true, ms: 5, settled: true },
    ]);
    expect(lines[0]).toContain('call web');
    expect(lines[1]).toContain('call dweb');
    expect(lines[2]).toContain('call 42');
  });

  test('an op still IN FLIGHT when the run died says so — never an instant failure', () => {
    const [line] = renderTraceLines([{ seq: 1, method: 'call', to: 'vm-9', ok: false, ms: 0, settled: false }]);
    expect(line).toContain('IN FLIGHT when the run ended');
    expect(line).not.toContain('FAILED 0ms');
  });

  test('a Stop-cancelled operation never renders as failed', () => {
    const [line] = renderTraceLines([{
      seq: 1, method: 'call', to: 'vm-9', ok: false, ms: 12,
      settled: true, cancelled: true, error: 'actors.call: aborted (Stop)',
    }]);
    expect(line).toContain('CANCELLED by Stop 12ms');
    expect(line).not.toContain('FAILED');
  });

  test("a call whose ACTOR reported failure renders distinctly from transport ok", () => {
    const [line] = renderTraceLines([{ seq: 1, method: 'call', to: 'vm-9', ok: true, ms: 400, settled: true, actorFailed: true }]);
    expect(line).toContain('REPORTED FAILURE');
    expect(line).not.toContain('→ ok');
  });

  test('traceGoalLines carries the previews for the FENCED body, capped', () => {
    const goals = traceGoalLines([{ seq: 2, method: 'call', to: 'vm-9', goal: 'x'.repeat(100), ok: true, ms: 5, settled: true }]);
    expect(goals.length).toBe(1);
    expect(goals[0]).toContain('#2 target="vm-9" → "');
    expect(goals[0]).toContain('…');
  });

  test('a no-goal crash mirror retains only its bounded target preview inside the fence details', () => {
    const [detail] = traceGoalLines([{
      seq: 2, method: 'call', to: 'x'.repeat(500), ok: false, ms: 0, settled: false,
    }]);
    expect(detail).toContain('#2 target="');
    expect(detail).toContain('…');
    expect(detail.length).toBeLessThan(100);
    expect(detail).not.toContain('→');
  });

  test('traceErrorDetails carries exactly the failed ops (for the FENCED body)', () => {
    const details = traceErrorDetails(trace);
    expect(details.length).toBe(1);
    expect(details[0]).toContain('#3 call target="web"');
    expect(details[0]).toContain('possible page text');
  });

  test('traceErrorDetails bounds retained failure text', () => {
    const [detail] = traceErrorDetails([{
      seq: 1, method: 'call', to: 'web', ok: false, ms: 1,
      error: 'e'.repeat(ACTORS_TRACE_ERROR_MAX_CHARS + 500),
    }]);
    expect(detail.length).toBeLessThan(ACTORS_TRACE_ERROR_MAX_CHARS + 100);
  });
});

describe('the timeout tower derives from one ceiling', () => {
  test('job > bridge guard > per-call cap, by construction', () => {
    expect(ACTORS_BRIDGE_GUARD_MS).toBeGreaterThan(ACTORS_CALL_MAX_TIMEOUT_MS);
    expect(ACTORS_JOB_DEFAULT_TIMEOUT_MS).toBeGreaterThan(ACTORS_BRIDGE_GUARD_MS);
    expect(ACTORS_JOB_MAX_TIMEOUT_MS).toBeGreaterThan(ACTORS_JOB_DEFAULT_TIMEOUT_MS);
  });
});
