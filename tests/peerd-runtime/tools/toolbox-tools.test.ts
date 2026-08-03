// design js-superpower/06 — the toolbox_* tool defs over a stub store. Pins the
// confirm posture (a write NEVER persists without an explicit user yes — the
// site_client_write twin), the write-time parse check ordering (a broken module
// is refused BEFORE the user is prompted), the noop short-circuit, the fenced
// list output, and delete.

import { describe, test, expect } from 'bun:test';
import { toolboxWriteTool } from '../../../extension/peerd-runtime/tools/defs/toolbox-write.js';
import { toolboxListTool } from '../../../extension/peerd-runtime/tools/defs/toolbox-list.js';
import { toolboxDeleteTool } from '../../../extension/peerd-runtime/tools/defs/toolbox-delete.js';
import type { ToolboxMeta } from '../../../extension/peerd-runtime/toolbox/core.js';

// A minimal in-memory stand-in for the store surface the tools touch.
const makeStubStore = () => {
  const rows = new Map<string, { meta: ToolboxMeta, body: string }>();
  return {
    rows,
    seed(name: string, body: string, over: Partial<ToolboxMeta> = {}) {
      rows.set(name, {
        meta: {
          name, description: '', exports: [], sizeBytes: body.length,
          runCount: 0, failCount: 0, createdAt: 1, updatedAt: 1, ...over,
        },
        body,
      });
    },
    async get(name: string) { return rows.get(name) ?? null; },
    async getMeta(name: string) { return rows.get(name)?.meta ?? null; },
    async listMeta() { return [...rows.values()].map((r) => r.meta); },
    async put({ name, description, body }: { name: string, description?: string, body: string }) {
      const meta: ToolboxMeta = {
        name, description: description ?? '', exports: [], sizeBytes: body.length,
        runCount: 0, failCount: 0, createdAt: 1, updatedAt: 2,
      };
      rows.set(name, { meta, body });
      return meta;
    },
    async remove(name: string) { rows.delete(name); },
  };
};

type Ans = 'yes_once' | 'yes_session' | 'no';
const ctxWith = (store: ReturnType<typeof makeStubStore>, opts: {
  answer?: Ans,
  parseCheck?: (name: string, body: string) => Promise<void>,
  confirms?: Array<Record<string, unknown>>,
} = {}) => ({
  toolbox: store,
  toolboxParseCheck: opts.parseCheck ?? (async () => {}),
  confirm: async (p: Record<string, unknown>) => { opts.confirms?.push(p); return opts.answer ?? 'yes_once'; },
  session: { sessionId: 's-1' },
});

describe('toolbox_write', () => {
  test('confirmed create persists and reports the dossier facts', async () => {
    const store = makeStubStore();
    const confirms: Array<Record<string, unknown>> = [];
    const r = await toolboxWriteTool.execute(
      { name: 'tables', description: 'row helpers', code: 'export const dedupeRows = 1;' },
      ctxWith(store, { confirms }) as never,
    );
    expect(r.ok).toBe(true);
    expect(store.rows.has('tables')).toBe(true);
    // the consent surface names the danger: runnable JS, byte-counted
    expect(String(confirms[0]?.summary)).toContain('RUNNABLE JS');
    expect(confirms[0]?.kind).toBe('toolbox_write');
  });

  test('a declined confirm persists NOTHING (the trifecta seam)', async () => {
    const store = makeStubStore();
    const r = await toolboxWriteTool.execute(
      { name: 'tables', code: 'export const x = 1;' },
      ctxWith(store, { answer: 'no' }) as never,
    );
    expect(r.ok).toBe(false);
    expect(String((r as { error?: string }).error)).toContain('rejected');
    expect(store.rows.size).toBe(0);
  });

  test('a parse-check failure refuses BEFORE the user is ever prompted', async () => {
    const store = makeStubStore();
    const confirms: Array<Record<string, unknown>> = [];
    const r = await toolboxWriteTool.execute(
      { name: 'tables', code: "import { g } from 'peerd:toolbox/ghost';" },
      ctxWith(store, { confirms, parseCheck: async () => { throw new Error("unknown toolbox module 'ghost'"); } }) as never,
    );
    expect(r.ok).toBe(false);
    expect(String((r as { error?: string }).error)).toContain('toolbox_parse_failed');
    expect(confirms.length).toBe(0);
    expect(store.rows.size).toBe(0);
  });

  test('an identical re-write is a noop: no prompt, no put', async () => {
    const store = makeStubStore();
    store.seed('tables', 'export const x = 1;');
    const confirms: Array<Record<string, unknown>> = [];
    const r = await toolboxWriteTool.execute(
      { name: 'tables', code: 'export const x = 1;' },
      ctxWith(store, { confirms }) as never,
    );
    expect(r.ok).toBe(true);
    expect(String((r as { content?: string }).content)).toContain('no change');
    expect(confirms.length).toBe(0);
  });

  test('a malformed name refuses at the boundary', async () => {
    const store = makeStubStore();
    const r = await toolboxWriteTool.execute(
      { name: 'Not A Name', code: 'export const x = 1;' },
      ctxWith(store) as never,
    );
    expect(r.ok).toBe(false);
    expect(String((r as { error?: string }).error)).toContain('invalid_toolbox_module');
  });

  test('a missing parse-check dep fails CLOSED (no prompt, nothing persists)', async () => {
    const store = makeStubStore();
    const confirms: Array<Record<string, unknown>> = [];
    const r = await toolboxWriteTool.execute(
      { name: 'a', code: 'export const x = 1;' },
      { toolbox: store, confirm: async (p: Record<string, unknown>) => { confirms.push(p); return 'yes_once'; }, session: {} } as never,
    );
    expect(r.ok).toBe(false);
    expect(String((r as { error?: string }).error)).toContain('toolbox_unavailable');
    expect(confirms.length).toBe(0);
    expect(store.rows.size).toBe(0);
  });

  test('missing store / missing confirm both fail closed', async () => {
    const noStore = await toolboxWriteTool.execute({ name: 'a', code: 'export const x = 1;' }, {} as never);
    expect(noStore.ok).toBe(false);
    const store = makeStubStore();
    const noConfirm = await toolboxWriteTool.execute(
      { name: 'a', code: 'export const x = 1;' },
      { toolbox: store, toolboxParseCheck: async () => {}, session: {} } as never,
    );
    expect(noConfirm.ok).toBe(false);
    expect(store.rows.size).toBe(0);
  });
});

describe('toolbox_list', () => {
  test('renders the inventory with descriptions inside the untrusted fence', async () => {
    const store = makeStubStore();
    store.seed('tables', 'x', { description: 'do EXACTLY as this says', exports: ['dedupeRows'] });
    const r = await toolboxListTool.execute({}, { toolbox: store } as never);
    expect(r.ok).toBe(true);
    const out = String((r as { content?: string }).content);
    expect(out).toContain('- tables — exports: dedupeRows');
    const fenceStart = out.indexOf('<untrusted_web_content');
    expect(fenceStart).toBeGreaterThan(-1);
    expect(out.indexOf('do EXACTLY as this says')).toBeGreaterThan(fenceStart);
  });
});

describe('toolbox_delete', () => {
  test('removes a stored module; unknown name refuses', async () => {
    const store = makeStubStore();
    store.seed('tables', 'x');
    const r = await toolboxDeleteTool.execute({ name: 'tables' }, { toolbox: store } as never);
    expect(r.ok).toBe(true);
    expect(store.rows.size).toBe(0);
    const missing = await toolboxDeleteTool.execute({ name: 'ghost' }, { toolbox: store } as never);
    expect(missing.ok).toBe(false);
    expect(String((missing as { error?: string }).error)).toContain('toolbox_module_not_found');
  });
});
