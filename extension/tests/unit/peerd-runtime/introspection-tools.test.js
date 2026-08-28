// @ts-check
// Tests for the `inspect` introspection tool (kind-discriminated).
//
// The five V1 introspection tools (inspect_storage/_audit_log/_session_access/
// _denylist/_provider_config) collapsed into ONE `inspect({ kind })` — this
// verifies each facet's output shape and the §02 demonstration property
// (e.g. kind:'provider_config' does NOT return the API key; kind:'storage'
// truncates encrypted blobs), plus the dispatch itself (unknown kind → error).

import { describe, it, expect } from '../../framework.js';
// Tests are exempt from the public-API import rule and exercise the concrete
// implementation directly; the catalog itself comes from the sealed semantic
// surface used by the production controller.
import { inspectTool } from '/peerd-runtime/tools/defs/inspect.js';
import {
  getToolMetadata, listToolMetadata, TOOL_METADATA_ORDER,
} from '/peerd-runtime/semantic.js';

const inspectMetadata = getToolMetadata(inspectTool.name);

/** @typedef {import('/shared/tool-types.js').ToolContext} ToolContext */
/** @param {import('/shared/tool-types.js').ToolResult} r @returns {any} */
const okContent = (r) => /** @type {import('/shared/tool-types.js').ToolResultOk} */ (r).content;

/**
 * @param {Record<string, any>} [overrides]
 * @returns {ToolContext}
 */
const baseCtx = (overrides = {}) => {
  const source = {
    tabs: { query: async (/** @type {Record<string,unknown>} */ _query = {}) => [] },
    kv: { list: async (/** @type {string|undefined} */ _prefix = undefined) => ({}) },
    idb: { getAll: async (/** @type {string} */ _store = '') => [] },
    denylist: ['chase.com', '*.chase.com', '*.proton.me'],
    provider: { name: 'anthropic', model: 'claude-sonnet-4-6', hasKey: true },
    vault: { isLocked: false },
    ...overrides,
  };
  return /** @type {ToolContext} */ (/** @type {unknown} */ ({
    session: { sessionId: 's1' },
    getSecret: async () => null,
    audit: async () => {},
    confirm: async () => 'no_once',
    ...overrides,
    introspectionAuthority: {
      readProviderPosture: async () => ({
        provider: source.provider.name,
        model: source.provider.model,
        hasKey: source.provider.hasKey,
        vaultLocked: source.vault.isLocked,
      }),
      readStorageSnapshot: (/** @type {string|undefined} */ prefix) => source.kv.list(prefix),
      readAutomatableTabs: () => source.tabs.query({}),
      readDenylistPatterns: async () => source.denylist,
      readAuditEntries: () => source.idb.getAll('audit_log'),
    },
  }));
};

/** @param {string} kind @param {Record<string, any>} args @param {ToolContext} ctx */
const inspect = (kind, args, ctx) => inspectTool.execute({ kind, ...args }, ctx);

describe('inspect kind:storage', () => {
  it('returns the kv contents as a JSON string', async () => {
    const ctx = baseCtx({ kv: { list: async () => ({ 'foo': 'bar', 'baz': 42 }) } });
    const r = await inspect('storage', {}, ctx);
    expect(r.ok).toBe(true);
    const parsed = JSON.parse(okContent(r));
    expect(parsed.foo).toBe('bar');
    expect(parsed.baz).toBe(42);
  });

  it('truncates very long base64 strings while preserving head/tail', async () => {
    const longBlob = 'A'.repeat(500);
    const ctx = baseCtx({ kv: { list: async () => ({ 'secret:k': longBlob }) } });
    const r = await inspect('storage', {}, ctx);
    const parsed = JSON.parse(okContent(r));
    expect(parsed['secret:k'].includes('…')).toBe(true);
    expect(parsed['secret:k'].includes('500 chars')).toBe(true);
  });

  it('passes the prefix arg through to kv.list', async () => {
    let received = null;
    const ctx = baseCtx({
      kv: { list: async (/** @type {string} */ prefix) => { received = prefix; return {}; } },
    });
    await inspect('storage', { prefix: 'vault' }, ctx);
    expect(received).toBe('vault');
  });

  it('the tool itself is primitive=inspect, sideEffect=read, no origins', () => {
    expect(inspectTool.primitive).toBe('inspect');
    expect(inspectTool.sideEffect).toBe('read');
    expect(inspectTool.origins({}, baseCtx())).toEqual([]);
  });
});

// The audit_log facet returns peerd's own counts, then the ENTRIES inside an
// untrusted fence: every successful fetch is audited with an attacker-chosen
// path, and this facet is on the main agent's surface. These tests read through
// the fence instead of JSON.parsing the whole payload.
const parseAudit = (/** @type {string} */ content) => {
  const at = content.indexOf('<untrusted_web_content');
  const counts = JSON.parse(content.slice(0, at));
  const body = content.slice(content.indexOf('>', at) + 1, content.lastIndexOf('</untrusted_web_content>'));
  return { ...counts, entries: JSON.parse(body) };
};

describe('inspect kind:audit_log', () => {
  it('returns recent entries newest-first', async () => {
    const entries = [
      { id: 'a', when: 100, type: 'vault_unlocked' },
      { id: 'b', when: 200, type: 'tool_executed' },
      { id: 'c', when: 150, type: 'provider_added' },
    ];
    const ctx = baseCtx({ idb: { getAll: async () => entries } });
    const r = await inspect('audit_log', {}, ctx);
    const parsed = parseAudit(okContent(r));
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
    const r = await inspect('audit_log', { limit: 3 }, ctx);
    const parsed = parseAudit(okContent(r));
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
    const r = await inspect('audit_log', { types: ['foo'] }, ctx);
    const parsed = parseAudit(okContent(r));
    expect(parsed.entries.every((/** @type {{ type: string }} */ e) => e.type === 'foo')).toBe(true);
    expect(parsed.entries.length).toBe(2);
  });
});

describe('inspect kind:session_access', () => {
  it('returns accessible tabs with origin-only URLs', async () => {
    const ctx = baseCtx({
      tabs: { query: async () => [
        { id: 1, url: 'https://github.com/foo/bar?ref=token', title: 'GitHub', active: true },
        { id: 2, url: 'https://news.ycombinator.com/', title: 'HN', active: false },
      ] },
    });
    const r = await inspect('session_access', {}, ctx);
    const parsed = JSON.parse(okContent(r));
    expect(parsed.accessibleTabs).toBe(2);
    expect(parsed.tabs[0].origin).toBe('https://github.com');
    expect(parsed.tabs[0].url).toBe('https://github.com');
    expect(okContent(r).includes('token')).toBe(false);
  });

  it('truncates long tab titles', async () => {
    const longTitle = 'x'.repeat(200);
    const ctx = baseCtx({
      tabs: { query: async () => [
        { id: 1, url: 'https://example.com/', title: longTitle, active: true },
      ] },
    });
    const r = await inspect('session_access', {}, ctx);
    const parsed = JSON.parse(okContent(r));
    expect(parsed.tabs[0].title.length <= 60).toBe(true);
  });

  it('reports the denylist as the only origin floor in scopeRule', async () => {
    const ctx = baseCtx();
    const r = await inspect('session_access', {}, ctx);
    const parsed = JSON.parse(okContent(r));
    expect(parsed.scopeRule.toLowerCase().includes('denylist')).toBe(true);
  });
});

describe('inspect kind:denylist', () => {
  it('without a domain returns counts and examples', async () => {
    const ctx = baseCtx();
    const r = await inspect('denylist', {}, ctx);
    const parsed = JSON.parse(okContent(r));
    expect(parsed.totalPatterns).toBe(3);
    expect(parsed.examples.length).toBe(3);
  });

  it('with a matching domain returns the matched pattern', async () => {
    const ctx = baseCtx();
    const r = await inspect('denylist', { domain: 'login.chase.com' }, ctx);
    const parsed = JSON.parse(okContent(r));
    expect(parsed.matched).toBe(true);
    expect(parsed.matchedPattern).toBe('*.chase.com');
  });

  it('with a non-matching domain returns matched=false', async () => {
    const ctx = baseCtx();
    const r = await inspect('denylist', { domain: 'example.com' }, ctx);
    const parsed = JSON.parse(okContent(r));
    expect(parsed.matched).toBe(false);
    expect(parsed.matchedPattern).toBe(null);
  });

  it('does NOT match protonmail.com when only *.proton.me is denylisted', async () => {
    // Regression guard for the §15-seed-specific boundary bug.
    const ctx = baseCtx();
    const r = await inspect('denylist', { domain: 'protonmail.com' }, ctx);
    const parsed = JSON.parse(okContent(r));
    expect(parsed.matched).toBe(false);
  });
});

describe('inspect kind:provider_config', () => {
  it('returns provider + model + hasKey + vault state', async () => {
    const ctx = baseCtx();
    const r = await inspect('provider_config', {}, ctx);
    const parsed = JSON.parse(okContent(r));
    expect(parsed.provider).toBe('anthropic');
    expect(parsed.model).toBe('claude-sonnet-4-6');
    expect(parsed.hasKey).toBe(true);
    expect(parsed.vaultLocked).toBe(false);
  });

  it('does NOT include the API key in its output', async () => {
    // The §02 contract: this facet reports key presence, never the key
    // value. Even if getSecret somehow returned a key, it must not surface.
    const ctx = baseCtx({ getSecret: async () => 'sk-ant-this-must-not-leak-1234' });
    const r = await inspect('provider_config', {}, ctx);
    expect(okContent(r).includes('sk-ant-this-must-not-leak-1234')).toBe(false);
  });
});

describe('inspect dispatch', () => {
  it('an unknown kind returns ok:false with the valid kinds listed', async () => {
    const r = await inspectTool.execute({ kind: 'nope' }, baseCtx());
    expect(r.ok).toBe(false);
    const err = /** @type {import('/shared/tool-types.js').ToolResultErr} */ (r).error;
    expect(err.includes('provider_config')).toBe(true);
    expect(err.includes('audit_log')).toBe(true);
  });

  it('a missing kind is rejected (kind is required)', async () => {
    const r = await inspectTool.execute({}, baseCtx());
    expect(r.ok).toBe(false);
  });

  it('the schema enumerates all five kinds and requires kind', () => {
    const props = /** @type {any} */ (inspectMetadata.schema).properties;
    expect([...props.kind.enum].sort()).toEqual(
      ['audit_log', 'denylist', 'provider_config', 'session_access', 'storage']);
    expect(/** @type {any} */ (inspectMetadata.schema).required).toEqual(['kind']);
  });
});

describe('controller tool catalog', () => {
  it('contains the merged inspect tool and none of the old five names', () => {
    const names = TOOL_METADATA_ORDER;
    expect(names).toContain('inspect');
    for (const gone of ['inspect_storage', 'inspect_audit_log', 'inspect_session_access',
      'inspect_denylist', 'inspect_provider_config']) {
      expect(names.indexOf(gone)).toBe(-1);
    }
  });

  it('every catalog entry declares a primitive', () => {
    for (const metadata of listToolMetadata()) {
      expect(typeof metadata.primitive).toBe('string');
      expect(metadata.primitive.length > 0).toBe(true);
    }
  });

  it('every catalog entry declares a valid sideEffect', () => {
    // The V1 "everything is read-only" invariant ended when the DOM /
    // engine tool families landed. The durable invariant: every tool
    // self-classifies with one of the SideEffect union members (see
    // shared/tool-types.js) so the dispatcher gates can reason about it.
    const valid = ['read', 'write', 'mutate_external', 'destructive'];
    for (const metadata of listToolMetadata()) {
      expect(valid.includes(/** @type {string} */ (metadata.sideEffect))).toBe(true);
    }
  });
});
