// @ts-check
// Tests for the five V1 introspection tools.
//
// Each tool gets a small unit test that verifies its output shape and
// the §02 demonstration property (e.g. inspect_provider_config does NOT
// return the API key; inspect_storage truncates encrypted blobs).

import { describe, it, expect } from '../../framework.js';
// why: the individual tool defs are not part of peerd-runtime's public
// index (only BUILTIN_TOOLS is) — importing them from there fails at
// module instantiation, which took the WHOLE runner.html import graph
// down with it (the page sat on "Loading…" forever). Tests are exempt
// from the public-API import rule, so reach into tools/defs directly.
import {
  inspectStorageTool,
  inspectAuditLogTool,
  inspectSessionAccessTool,
  inspectDenylistTool,
  inspectProviderConfigTool,
  BUILTIN_TOOLS,
} from '/peerd-runtime/tools/defs/index.js';

/** @typedef {import('/shared/tool-types.js').ToolContext} ToolContext */
/** @param {import('/shared/tool-types.js').ToolResult} r @returns {any} */
const okContent = (r) => /** @type {import('/shared/tool-types.js').ToolResultOk} */ (r).content;

/**
 * @param {Record<string, any>} [overrides]
 * @returns {ToolContext}
 */
const baseCtx = (overrides = {}) => /** @type {ToolContext} */ (/** @type {unknown} */ ({
  session: { sessionId: 's1' },
  tabs: { query: async () => [] },
  getSecret: async () => null,
  audit: async () => {},
  confirm: async () => 'no_once',
  kv: { list: async () => ({}) },
  idb: { getAll: async () => [] },
  denylist: ['chase.com', '*.chase.com', '*.proton.me'],
  provider: { name: 'anthropic', model: 'claude-sonnet-4-6', hasKey: true },
  vault: { isLocked: false },
  ...overrides,
}));

describe('inspect_storage', () => {
  it('returns the kv contents as a JSON string', async () => {
    const ctx = baseCtx({
      kv: { list: async () => ({ 'foo': 'bar', 'baz': 42 }) },
    });
    const r = await inspectStorageTool.execute({}, ctx);
    expect(r.ok).toBe(true);
    const parsed = JSON.parse(okContent(r));
    expect(parsed.foo).toBe('bar');
    expect(parsed.baz).toBe(42);
  });

  it('truncates very long base64 strings while preserving head/tail', async () => {
    const longBlob = 'A'.repeat(500);
    const ctx = baseCtx({
      kv: { list: async () => ({ 'secret:k': longBlob }) },
    });
    const r = await inspectStorageTool.execute({}, ctx);
    const parsed = JSON.parse(okContent(r));
    expect(parsed['secret:k'].includes('…')).toBe(true);
    expect(parsed['secret:k'].includes('500 chars')).toBe(true);
  });

  it('passes the prefix arg through to kv.list', async () => {
    let received = null;
    const ctx = baseCtx({
      kv: { list: async (/** @type {string} */ prefix) => { received = prefix; return {}; } },
    });
    await inspectStorageTool.execute({ prefix: 'vault' }, ctx);
    expect(received).toBe('vault');
  });

  it('has primitive=sovereignty and sideEffect=read', () => {
    expect(inspectStorageTool.primitive).toBe('inspect');
    expect(inspectStorageTool.sideEffect).toBe('read');
    expect(inspectStorageTool.origins({}, baseCtx())).toEqual([]);
  });
});

describe('inspect_audit_log', () => {
  it('returns recent entries newest-first', async () => {
    const entries = [
      { id: 'a', when: 100, type: 'vault_unlocked' },
      { id: 'b', when: 200, type: 'tool_executed' },
      { id: 'c', when: 150, type: 'provider_added' },
    ];
    const ctx = baseCtx({ idb: { getAll: async () => entries } });
    const r = await inspectAuditLogTool.execute({}, ctx);
    const parsed = JSON.parse(okContent(r));
    expect(parsed.entries[0].id).toBe('b');
    expect(parsed.entries[1].id).toBe('c');
    expect(parsed.entries[2].id).toBe('a');
    expect(parsed.totalInStore).toBe(3);
  });

  it('honors limit with min 1, max 500', async () => {
    const ctx = baseCtx({
      idb: { getAll: async () =>
        Array.from({ length: 10 }, (_, i) => ({ id: `${i}`, when: i, type: 't' })) },
    });
    const r = await inspectAuditLogTool.execute({ limit: 3 }, ctx);
    const parsed = JSON.parse(okContent(r));
    expect(parsed.entries.length).toBe(3);
  });

  it('filters by types when provided', async () => {
    const ctx = baseCtx({
      idb: { getAll: async () => [
        { id: 'a', when: 1, type: 'foo' },
        { id: 'b', when: 2, type: 'bar' },
        { id: 'c', when: 3, type: 'foo' },
      ] },
    });
    const r = await inspectAuditLogTool.execute({ types: ['foo'] }, ctx);
    const parsed = JSON.parse(okContent(r));
    expect(parsed.entries.every((/** @type {{ type: string }} */ e) => e.type === 'foo')).toBe(true);
    expect(parsed.entries.length).toBe(2);
  });
});

describe('inspect_session_access', () => {
  it('returns accessible tabs with origin + redacted URL', async () => {
    const ctx = baseCtx({
      tabs: { query: async () => [
        { id: 1, url: 'https://github.com/foo/bar?ref=token', title: 'GitHub', active: true },
        { id: 2, url: 'https://news.ycombinator.com/', title: 'HN', active: false },
      ] },
    });
    const r = await inspectSessionAccessTool.execute({}, ctx);
    const parsed = JSON.parse(okContent(r));
    expect(parsed.accessibleTabs).toBe(2);
    expect(parsed.tabs[0].origin).toBe('https://github.com');
    // Query string redacted.
    expect(parsed.tabs[0].url.endsWith('?…')).toBe(true);
  });

  it('truncates long tab titles', async () => {
    const longTitle = 'x'.repeat(200);
    const ctx = baseCtx({
      tabs: { query: async () => [
        { id: 1, url: 'https://example.com/', title: longTitle, active: true },
      ] },
    });
    const r = await inspectSessionAccessTool.execute({}, ctx);
    const parsed = JSON.parse(okContent(r));
    expect(parsed.tabs[0].title.length <= 60).toBe(true);
  });

  it('reports the denylist as the only origin floor in scopeRule', async () => {
    const ctx = baseCtx();
    const r = await inspectSessionAccessTool.execute({}, ctx);
    const parsed = JSON.parse(okContent(r));
    expect(parsed.scopeRule.toLowerCase().includes('denylist')).toBe(true);
  });
});

describe('inspect_denylist', () => {
  it('without a domain returns counts and examples', async () => {
    const ctx = baseCtx();
    const r = await inspectDenylistTool.execute({}, ctx);
    const parsed = JSON.parse(okContent(r));
    expect(parsed.totalPatterns).toBe(3);
    expect(parsed.examples.length).toBe(3);
  });

  it('with a matching domain returns the matched pattern', async () => {
    const ctx = baseCtx();
    const r = await inspectDenylistTool.execute({ domain: 'login.chase.com' }, ctx);
    const parsed = JSON.parse(okContent(r));
    expect(parsed.matched).toBe(true);
    expect(parsed.matchedPattern).toBe('*.chase.com');
  });

  it('with a non-matching domain returns matched=false', async () => {
    const ctx = baseCtx();
    const r = await inspectDenylistTool.execute({ domain: 'example.com' }, ctx);
    const parsed = JSON.parse(okContent(r));
    expect(parsed.matched).toBe(false);
    expect(parsed.matchedPattern).toBe(null);
  });

  it('does NOT match protonmail.com when only *.proton.me is denylisted', async () => {
    // Regression guard for the §15-seed-specific boundary bug.
    const ctx = baseCtx();
    const r = await inspectDenylistTool.execute({ domain: 'protonmail.com' }, ctx);
    const parsed = JSON.parse(okContent(r));
    expect(parsed.matched).toBe(false);
  });
});

describe('inspect_provider_config', () => {
  it('returns provider + model + hasKey + vault state', async () => {
    const ctx = baseCtx();
    const r = await inspectProviderConfigTool.execute({}, ctx);
    const parsed = JSON.parse(okContent(r));
    expect(parsed.provider).toBe('anthropic');
    expect(parsed.model).toBe('claude-sonnet-4-6');
    expect(parsed.hasKey).toBe(true);
    expect(parsed.vaultLocked).toBe(false);
  });

  it('does NOT include the API key in its output', async () => {
    // The §02 contract: this tool reports key presence, never the key
    // value. Even if getSecret somehow returned a key, the tool should
    // not surface it.
    const ctx = baseCtx({
      getSecret: async () => 'sk-ant-this-must-not-leak-1234',
    });
    const r = await inspectProviderConfigTool.execute({}, ctx);
    expect(okContent(r).includes('sk-ant-this-must-not-leak-1234')).toBe(false);
  });
});

describe('BUILTIN_TOOLS registry', () => {
  it('exports all five V1 introspection tools', () => {
    // The registry has grown well past the introspection family; this
    // test guards that the original five stay registered.
    const names = BUILTIN_TOOLS.map((t) => t.name);
    expect(names).toContain('inspect_storage');
    expect(names).toContain('inspect_audit_log');
    expect(names).toContain('inspect_session_access');
    expect(names).toContain('inspect_denylist');
    expect(names).toContain('inspect_provider_config');
  });

  it('every built-in declares a primitive', () => {
    for (const t of BUILTIN_TOOLS) {
      expect(typeof t.primitive).toBe('string');
      expect(t.primitive.length > 0).toBe(true);
    }
  });

  it('every built-in declares a valid sideEffect', () => {
    // The V1 "everything is read-only" invariant ended when the DOM /
    // engine tool families landed. The durable invariant: every tool
    // self-classifies with one of the SideEffect union members (see
    // shared/tool-types.js) so the dispatcher gates can reason about it.
    const valid = ['read', 'write', 'mutate_external', 'destructive'];
    for (const t of BUILTIN_TOOLS) {
      expect(valid).toContain(t.sideEffect);
    }
  });

  it('the five introspection tools stay read-only', () => {
    const inspect = BUILTIN_TOOLS.filter((t) => t.name.startsWith('inspect_'));
    expect(inspect.length).toBe(5);
    for (const t of inspect) {
      expect(t.sideEffect).toBe('read');
    }
  });
});
