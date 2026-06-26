// @ts-check
// Dispatcher composition tests.
//
// The dispatcher's contract is small but load-bearing: gates run in
// order, each result lands in meta.gates, a failing gate stops execution
// and audits, execute() failures audit and surface with the gate chain
// already populated. These tests pin all of that.

import { describe, it, expect } from '../../framework.js';
import {
  registerTool, clearTools, dispatchToolCall, GATES,
} from '/peerd-runtime/index.js';

/** @typedef {import('/shared/tool-types.js').ToolContext} ToolContext */
/** @typedef {import('/shared/tool-types.js').Tool} Tool */
/** @typedef {import('/shared/tool-types.js').ToolMeta} ToolMeta */
/** @param {import('/shared/tool-types.js').ToolResult} r @returns {ToolMeta} */
const metaOf = (r) => /** @type {ToolMeta} */ (r.meta);
/** @param {import('/shared/tool-types.js').ToolResult} r @returns {string} */
const errOf = (r) => /** @type {import('/shared/tool-types.js').ToolResultErr} */ (r).error;

/**
 * @param {Record<string, any>} [overrides]
 */
const recorderCtx = (overrides = {}) => {
  /** @type {any[]} */
  const audited = [];
  return {
    ctx: /** @type {ToolContext} */ (/** @type {unknown} */ ({
      session: { sessionId: 's1' },
      tabs: { query: async () => [] },
      getSecret: async () => null,
      audit: async (/** @type {any} */ e) => { audited.push(e); },
      confirm: async () => 'no_once',
      kv: { list: async () => ({}) },
      idb: { getAll: async () => [] },
      denylist: [],
      provider: { name: 'anthropic', model: 'claude-sonnet-4-6', hasKey: false },
      vault: { isLocked: false },
      ...overrides,
    })),
    audited,
  };
};

/**
 * @param {Partial<Tool>} overrides
 * @returns {Tool}
 */
const makeTool = (overrides) => /** @type {Tool} */ ({
  name: 't',
  primitive: 'inspect',
  description: 't',
  schema: {},
  sideEffect: 'read',
  origins: () => [],
  execute: async () => ({ ok: true, content: 'hello' }),
  ...overrides,
});

describe('dispatcher', () => {
  it('returns unknown_tool for an unregistered name', async () => {
    clearTools();
    const { ctx } = recorderCtx();
    const r = await dispatchToolCall({ id: 'x', name: 'no-such', args: {} }, ctx);
    expect(r.ok).toBe(false);
    expect(metaOf(r).primitive).toBe('unknown');
    expect(metaOf(r).gates).toEqual([]);
    expect(metaOf(r).toolName).toBe('no-such');
  });

  it('runs every gate and records each in meta.gates', async () => {
    clearTools();
    registerTool(makeTool({}));
    const { ctx } = recorderCtx();
    const r = await dispatchToolCall({ id: 'x', name: 't', args: {} }, ctx);
    expect(r.ok).toBe(true);
    expect(metaOf(r).gates.length).toBe(GATES.length);
    expect(metaOf(r).gates.map((g) => g.name)).toEqual(GATES.map((g) => g.name));
    for (const g of metaOf(r).gates) expect(g.allowed).toBe(true);
  });

  it('attaches primitive and durationMs to meta', async () => {
    clearTools();
    registerTool(makeTool({ primitive: 'tab' }));
    const { ctx } = recorderCtx();
    const r = await dispatchToolCall({ id: 'x', name: 't', args: {} }, ctx);
    expect(metaOf(r).primitive).toBe('tab');
    expect(typeof metaOf(r).durationMs).toBe('number');
    expect(metaOf(r).durationMs >= 0).toBe(true);
  });

  it('stops at the first gate denial and audits a tool_blocked entry', async () => {
    clearTools();
    // Tool whose origin gate triggers a denylist hit.
    registerTool(makeTool({
      origins: () => ['https://chase.com'],
    }));
    const { ctx, audited } = recorderCtx({ denylist: ['chase.com', '*.chase.com'] });
    const r = await dispatchToolCall({ id: 'x', name: 't', args: {} }, ctx);
    expect(r.ok).toBe(false);
    expect(errOf(r).startsWith('gate_blocked:origin:')).toBe(true);
    expect(metaOf(r).durationMs).toBe(0);
    // Gates ran through origin but no further.
    const names = metaOf(r).gates.map((g) => g.name);
    expect(names).toEqual(['persona', 'exposure', 'origin']);
    expect(metaOf(r).gates[2].allowed).toBe(false);
    // Wait a microtask for the fire-and-forget audit to land.
    await Promise.resolve();
    expect(audited.some((e) => e.type === 'tool_blocked' && e.details.gate === 'origin')).toBe(true);
  });

  it('audits tool_executed on success', async () => {
    clearTools();
    registerTool(makeTool({}));
    const { ctx, audited } = recorderCtx();
    await dispatchToolCall({ id: 'x', name: 't', args: {} }, ctx);
    await Promise.resolve();
    expect(audited.some((e) => e.type === 'tool_executed' && e.details.tool === 't')).toBe(true);
  });

  it('catches execute() throw and returns ok:false with meta intact', async () => {
    clearTools();
    registerTool(makeTool({
      execute: async () => { throw new Error('kaboom'); },
    }));
    const { ctx, audited } = recorderCtx();
    const r = await dispatchToolCall({ id: 'x', name: 't', args: {} }, ctx);
    expect(r.ok).toBe(false);
    expect(errOf(r)).toBe('kaboom');
    expect(metaOf(r).gates.length).toBe(GATES.length);
    await Promise.resolve();
    expect(audited.some((e) => e.type === 'tool_failed')).toBe(true);
  });

  it('treats a throwing gate as a denial rather than crashing', async () => {
    // We can't inject a custom gate easily; we'll exercise the path
    // via a tool whose origins() throws — that surfaces through the
    // origin gate's `result = fn(...)` wrapper.
    clearTools();
    registerTool(makeTool({
      origins: () => { throw new Error('origins blew up'); },
    }));
    const { ctx } = recorderCtx();
    const r = await dispatchToolCall({ id: 'x', name: 't', args: {} }, ctx);
    expect(r.ok).toBe(false);
    expect(errOf(r).startsWith('gate_blocked:origin:gate threw')).toBe(true);
  });
});

// Confirmation is driven by the Plan/Act permission policy (Feature 03)
// via ctx.permission = { mode, confirmActions }. These tests pin the
// dispatcher's integration with that policy (post-2026-06-12 tier
// collapse: one boolean — ON = every non-read confirms, OFF = nothing
// confirms).
/** @param {boolean} confirmActions */
const act = (confirmActions) => ({ permission: { mode: 'act', confirmActions } });

describe('confirmation (Plan/Act permission policy)', () => {
  it('PLAN mode blocks a non-read tool at the persona gate (before confirm)', async () => {
    clearTools();
    registerTool(makeTool({ sideEffect: 'write', primitive: 'tab' }));
    let prompted = false;
    const { ctx } = recorderCtx({
      permission: { mode: 'plan', confirmActions: true },
      confirm: async () => { prompted = true; return 'yes_once'; },
    });
    const r = await dispatchToolCall({ id: 'x', name: 't', args: {} }, ctx);
    expect(r.ok).toBe(false);
    expect(errOf(r).startsWith('gate_blocked:persona:')).toBe(true);
    expect(prompted).toBe(false);  // blocked before the confirm step
  });

  it('does NOT prompt for read tools even with confirmations on', async () => {
    clearTools();
    registerTool(makeTool({ sideEffect: 'read' }));
    let prompted = false;
    const { ctx } = recorderCtx({
      ...act(true),
      confirm: async () => { prompted = true; return 'no'; },
    });
    const r = await dispatchToolCall({ id: 'x', name: 't', args: {} }, ctx);
    expect(r.ok).toBe(true);
    expect(prompted).toBe(false);
  });

  it('confirmations OFF does NOT prompt for a write tool', async () => {
    clearTools();
    registerTool(makeTool({ sideEffect: 'write', primitive: 'tab' }));
    let prompted = false;
    const { ctx } = recorderCtx({ ...act(false), confirm: async () => { prompted = true; return 'no'; } });
    const r = await dispatchToolCall({ id: 'x', name: 't', args: {} }, ctx);
    expect(r.ok).toBe(true);
    expect(prompted).toBe(false);
  });

  it('confirmations ON prompts even for a workspace write (the old auto-edit lane is gone)', async () => {
    clearTools();
    registerTool(makeTool({ sideEffect: 'write', primitive: 'webvm' }));
    let prompted = false;
    const { ctx } = recorderCtx({ ...act(true), confirm: async () => { prompted = true; return 'yes_once'; } });
    const r = await dispatchToolCall({ id: 'x', name: 't', args: {} }, ctx);
    expect(r.ok).toBe(true);
    expect(prompted).toBe(true);
  });

  it('missing/garbage confirmActions fails safe to prompting', async () => {
    clearTools();
    registerTool(makeTool({ sideEffect: 'write', primitive: 'tab' }));
    let prompted = false;
    // A legacy-shaped permission (tier string, no boolean) must confirm.
    const { ctx } = recorderCtx({
      permission: { mode: 'act', tier: 'full-auto' },
      confirm: async () => { prompted = true; return 'yes_once'; },
    });
    const r = await dispatchToolCall({ id: 'x', name: 't', args: {} }, ctx);
    expect(r.ok).toBe(true);
    expect(prompted).toBe(true);
  });

  it('confirmations ON prompts for a write tool; "no" blocks and audits tool_rejected', async () => {
    clearTools();
    registerTool(makeTool({ sideEffect: 'write', primitive: 'tab' }));
    const { ctx, audited } = recorderCtx({ ...act(true), confirm: async () => 'no' });
    const r = await dispatchToolCall({ id: 'x', name: 't', args: {} }, ctx);
    expect(r.ok).toBe(false);
    expect(errOf(r).startsWith('gate_blocked:confirmation:')).toBe(true);
    const confirmGate = metaOf(r).gates.find((g) => g.name === 'confirmation');
    expect(confirmGate?.allowed).toBe(false);
    await Promise.resolve();
    expect(audited.some((e) => e.type === 'tool_rejected')).toBe(true);
  });

  it('confirmations ON prompts for a write tool; "yes_once" allows and runs', async () => {
    clearTools();
    registerTool(makeTool({ sideEffect: 'write', primitive: 'tab' }));
    const { ctx } = recorderCtx({ ...act(true), confirm: async () => 'yes_once' });
    const r = await dispatchToolCall({ id: 'x', name: 't', args: {} }, ctx);
    expect(r.ok).toBe(true);
    const confirmGate = metaOf(r).gates.find((g) => g.name === 'confirmation');
    expect(confirmGate?.allowed).toBe(true);
  });
});

describe('gate composition order', () => {
  it('is persona → exposure → origin → confirmation → egress → audit', () => {
    expect(GATES.map((g) => g.name)).toEqual([
      'persona', 'exposure', 'origin', 'confirmation', 'egress', 'audit',
    ]);
  });

  it('persona gate reflects the Plan/Act mode; exposure passes non-hidden tools', async () => {
    clearTools();
    // Default ctx has no permission → resolves to Plan; but a read tool
    // is allowed in Plan, so the persona reason names the mode + class.
    registerTool(makeTool({ sideEffect: 'read' }));
    const { ctx } = recorderCtx();
    const r = await dispatchToolCall({ id: 'x', name: 't', args: {} }, ctx);
    const persona = metaOf(r).gates.find((g) => g.name === 'persona');
    const exposure = metaOf(r).gates.find((g) => g.name === 'exposure');
    expect(persona?.reason.includes('read')).toBe(true);
    expect(exposure?.allowed).toBe(true);
    expect(exposure?.reason).toBe('exposed');
  });

  it('exposure gate refuses main-hidden tools when ctx.exposure is "main"', async () => {
    clearTools();
    // read_page is in the main-hidden set (runner-only since the do/get/
    // check cutover) — dispatching it with exposure:'main' must refuse at
    // the gate, so a prompt-injected model can't reach it by name.
    registerTool(makeTool({ name: 'read_page', sideEffect: 'read' }));
    const { ctx } = recorderCtx({ exposure: 'main' });
    const r = await dispatchToolCall({ id: 'x', name: 'read_page', args: {} }, ctx);
    expect(r.ok).toBe(false);
    expect(errOf(r).startsWith('gate_blocked:exposure:')).toBe(true);
    const exposure = metaOf(r).gates.find((g) => g.name === 'exposure');
    expect(exposure?.allowed).toBe(false);
    expect(exposure?.reason.includes('runner-only')).toBe(true);
  });

  // DESIGN-17: the resident capability tier, end-to-end through the dispatcher.
  // The full-chain analog of the residentTierGate unit proof (tests/peerd-runtime/
  // exposure.test.ts). The resident model is unconditional, so this proves a
  // subagent can't escalate into the mutating tier, while message_resident (the
  // non-mutating delegation channel) passes the exposure gate on the main agent.
  it('resident tier: a subagent can not escalate into the mutating tier', async () => {
    clearTools();
    registerTool(makeTool({ name: 'app_delete', sideEffect: 'destructive' }));
    registerTool(makeTool({ name: 'message_resident', sideEffect: 'write' }));
    // act + confirm-off so persona/confirmation don't pre-empt the exposure gate.
    const permission = { mode: 'act', confirmActions: false };

    // A subagent (exposure unset) trying the mutating tier by name is refused.
    const sub = recorderCtx({ permission }).ctx;
    const rDelete = await dispatchToolCall({ id: 'a', name: 'app_delete', args: { appId: 'app-x' } }, sub);
    expect(rDelete.ok).toBe(false);
    expect(errOf(rDelete).startsWith('gate_blocked:exposure:')).toBe(true);
    expect(metaOf(rDelete).gates.find((g) => g.name === 'exposure')?.reason.includes('resident-only')).toBe(true);

    // message_resident is non-mutating — the main agent's delegation channel passes.
    const main = recorderCtx({ permission, exposure: 'main' }).ctx;
    const rMsg = await dispatchToolCall({ id: 'b', name: 'message_resident', args: {} }, main);
    expect(metaOf(rMsg).gates.find((g) => g.name === 'exposure')?.allowed).toBe(true);
  });
});
