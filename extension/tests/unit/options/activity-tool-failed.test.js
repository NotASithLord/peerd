// @ts-check
// Options → Activity: a declined tool call must surface as a "tool failed"
// row, end-to-end through the REAL dispatcher + REAL audit log.
//
// This is the seam the Bun dispatcher tests can't reach: the returned
// { ok: false } → tool_failed audit branch (dispatcher.js), through the real
// hash-chained createAuditLog, out the audit/list read, into the ActivityView
// render (EVENT_META danger row + the Issues filter). Before the 2b fix the
// dispatcher audited every non-throw as tool_executed, so this row read as a
// green "tool ran" and the Issues filter hid the user's own failures.

import m from '/vendor/mithril/mithril.js';
import { describe, it, expect } from '../../framework.js';
import { registerTool, clearTools, dispatchToolCall } from '/peerd-runtime/index.js';
import { createAuditLog, idb } from '/peerd-egress/index.js';
import { ActivityView } from '/options/sections/activity.js';

/** @param {(msg: any) => Promise<any>} send */
const mount = (send) => {
  const root = document.createElement('div');
  document.body.appendChild(root);
  m.mount(root, { view: () => m(ActivityView, { send }) });
  return { root, unmount: () => { m.mount(root, null); root.remove(); } };
};

const settle = () => new Promise((r) => setTimeout(r, 0)).then(() => m.redraw.sync?.() ?? m.redraw());

/** @param {(e: any) => Promise<any>} audit */
const dispatchCtx = (audit) => /** @type {any} */ ({
  session: { sessionId: 's1' },
  tabs: { query: async () => [] },
  getSecret: async () => null,
  audit,
  confirm: async () => 'no_once',
  kv: { list: async () => ({}) },
  idb: { getAll: async () => [] },
  denylist: [],
  provider: { name: 'anthropic', model: 'claude-sonnet-4-6', hasKey: false },
  vault: { isLocked: false },
});

/** @param {Partial<any>} over */
const makeTool = (over) => /** @type {any} */ ({
  name: 't', primitive: 'inspect', description: 't', schema: {},
  sideEffect: 'read', origins: () => [],
  execute: async () => ({ ok: true, content: 'hello' }),
  ...over,
});

describe('options.activity — a declined tool call shows as failed (end-to-end)', () => {
  it('renders a danger "tool failed" row from the real audit log', async () => {
    await idb.clear('audit_log');
    const log = createAuditLog({ idb });

    // Drive a declined confirmation through the REAL dispatcher: the tool
    // returns { ok: false } (the fetch-url decline shape), and ctx.audit is
    // the real append — so the tool_failed entry is genuinely hash-chained.
    clearTools();
    registerTool(makeTool({
      execute: async () => ({ ok: false, error: 'declined', content: 'User declined the outbound write.' }),
    }));
    // The dispatcher fires ctx.audit fire-and-forget (.catch, not awaited), so
    // dispatchToolCall resolves BEFORE log.append finishes its async chain-head
    // read + hash + IDB put. Capture the append promise and await it ourselves,
    // or list() races an empty log. (Deterministic — no poll/sleep.)
    /** @type {Promise<any>[]} */
    const appends = [];
    await dispatchToolCall({ id: 'x', name: 't', args: {} }, dispatchCtx((e) => {
      const p = log.append(e);
      appends.push(p);
      return p;
    }));
    await Promise.all(appends);

    const entries = await log.list();
    // The dispatcher wrote tool_failed (not tool_executed) for the {ok:false}.
    expect(entries.some((/** @type {any} */ e) => e.type === 'tool_failed')).toBe(true);
    expect(entries.some((/** @type {any} */ e) => e.type === 'tool_executed')).toBe(false);

    const { root, unmount } = mount(async (msg) => (msg.type === 'audit/list'
      ? { ok: true, entries, total: entries.length }
      : { ok: true }));
    try {
      await settle();
      const text = root.textContent ?? '';
      expect(text.includes('tool failed')).toBe(true);            // the danger label
      expect(!!root.querySelector('.log-danger')).toBe(true);     // the danger dot
    } finally { unmount(); clearTools(); }
  });
});
