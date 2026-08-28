// Hook system — developer tests (feature 10).
//
// Coverage required by the feature brief:
//   1. a pre-hook BLOCKS a call
//   2. unsupported decisions fail closed
//   3. a post-hook OBSERVES the result
//   4. a hook that THROWS fails closed (blocks)
//
// We test the functional core directly — the pure runner + the registry
// + the compiler. The dispatcher delegates the entire hook phase to
// runPreToolUse / runPostToolUse, so exercising those IS exercising the
// dispatcher's hook behaviour, without dragging in the dispatcher's
// transitive `/peerd-egress/index.js` absolute import (which Bun can't
// resolve — that path needs the browser, like the rest of the in-browser
// suite). A "dispatcher-shaped" describe block at the bottom runs a
// faithful mini-dispatcher over the runner to prove block/observe wiring.

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  runPreToolUse,
  runPostToolUse,
  selectHooks,
  hookMatches,
} from '../../extension/peerd-runtime/tools/hooks/runner.js';
import {
  registerHook,
  listHooks,
  saveUserHook,
  removeHook,
  exportHooks,
  loadUserHooks,
  _clearAllHooks,
  HOOKS_STORAGE_KEY,
} from '../../extension/peerd-runtime/tools/hooks/registry.js';
import {
  compileUserHook,
  parseHookMarkdown,
} from '../../extension/peerd-runtime/tools/hooks/compile.js';
import type { ToolResult } from '../../extension/shared/tool-types.js';

const ctx = {} as any;

// In-memory kv matching the chrome.storage.local wrapper surface.
const makeKv = () => {
  const store = new Map<string, unknown>();
  return {
    get: async (k: string) => store.get(k),
    set: async (k: string, v: unknown) => { store.set(k, v); },
    _store: store,
  };
};

beforeEach(() => { _clearAllHooks(); });

// ---- runner: the four load-bearing behaviours -----------------------------

describe('runPreToolUse', () => {
  test('(1) a pre-hook BLOCKS a call', async () => {
    const hooks = [{
      id: 'blocker', event: 'pre-tool-use' as const,
      run: () => ({ action: 'block' as const, reason: 'nope' }),
    }];
    const out = await runPreToolUse({ hooks, toolName: 'click', args: { x: 1 }, ctx });
    expect(out.allowed).toBe(false);
    expect(out.reason).toContain('nope');
    expect(out.outcomes[0]).toMatchObject({ id: 'blocker', action: 'block' });
  });

  test('an obsolete modify decision FAILS CLOSED', async () => {
    const hooks = [{
      id: 'obsolete-modify', event: 'pre-tool-use' as const,
      run: () => ({ action: 'modify' as any, args: { flagged: true } }),
    }];
    const out = await runPreToolUse({ hooks, toolName: 'type', args: { text: 'hi' }, ctx });
    expect(out.allowed).toBe(false);
    expect(out.reason).toContain("unknown action 'modify'");
    expect(out.args).toEqual({ text: 'hi' });
  });

  test('(4) a throwing pre-hook FAILS CLOSED (blocks)', async () => {
    const hooks = [{
      id: 'boom', event: 'pre-tool-use' as const,
      run: () => { throw new Error('kaboom'); },
    }];
    const out = await runPreToolUse({ hooks, toolName: 'navigate', args: {}, ctx });
    expect(out.allowed).toBe(false);
    expect(out.reason).toContain('kaboom');
    expect(out.reason).toContain('failing closed');
  });

  test('a non-object return FAILS CLOSED', async () => {
    const hooks = [{
      id: 'garbage', event: 'pre-tool-use' as const,
      run: () => 42 as any,
    }];
    const out = await runPreToolUse({ hooks, toolName: 'click', args: {}, ctx });
    expect(out.allowed).toBe(false);
  });

  test('no return value is an implicit ALLOW', async () => {
    const hooks = [{ id: 'quiet', event: 'pre-tool-use' as const, run: () => undefined }];
    const out = await runPreToolUse({ hooks, toolName: 'click', args: { a: 1 }, ctx });
    expect(out.allowed).toBe(true);
    expect(out.args).toEqual({ a: 1 });
  });

  test('the FIRST block short-circuits later hooks', async () => {
    let secondRan = false;
    const hooks = [
      { id: 'first', event: 'pre-tool-use' as const, order: 1, run: () => ({ action: 'block' as const, reason: 'stop' }) },
      { id: 'second', event: 'pre-tool-use' as const, order: 2, run: () => { secondRan = true; } },
    ];
    const out = await runPreToolUse({ hooks, toolName: 'click', args: {}, ctx });
    expect(out.allowed).toBe(false);
    expect(secondRan).toBe(false);
  });

  test('a hanging hook is bounded fail-closed via injected invoke', async () => {
    // The shell can pass an `invoke` that races the hook against a
    // timeout; a timeout reject must surface as a block, same as a throw.
    const hooks = [{
      id: 'hang', event: 'pre-tool-use' as const,
      run: () => new Promise<never>(() => {}), // never resolves
    }];
    const invoke = (fn: () => any) =>
      Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5))]);
    const out = await runPreToolUse({ hooks, toolName: 'click', args: {}, ctx, invoke });
    expect(out.allowed).toBe(false);
    expect(out.reason).toContain('timeout');
  });
});

describe('runPostToolUse', () => {
  test('(3) a post-hook OBSERVES the result', async () => {
    let seen: any = null;
    const hooks = [{
      id: 'observer', event: 'post-tool-use' as const,
      run: (inv: any) => { seen = inv.result; },
    }];
    const result: ToolResult = { ok: true, content: 'done' };
    const out = await runPostToolUse({ hooks, toolName: 'click', args: {}, result, ctx });
    expect(seen).toEqual(result);
    expect(out.outcomes[0]).toMatchObject({ id: 'observer', action: 'observe' });
  });

  test('a throwing post-hook is recorded but does NOT fail closed', async () => {
    // The side effect already ran; a buggy observer must not corrupt the
    // result the model sees. The throw is recorded, not propagated.
    const hooks = [{ id: 'bad-observer', event: 'post-tool-use' as const, run: () => { throw new Error('late'); } }];
    const out = await runPostToolUse({ hooks, toolName: 'click', args: {}, result: { ok: true, content: '' }, ctx });
    expect(out.outcomes[0].reason).toContain('ignored');
  });
});

// ---- selection / matching -------------------------------------------------

describe('selectHooks / hookMatches', () => {
  test('hookMatches: exact, wildcard, prefix glob', () => {
    expect(hookMatches('*', 'anything')).toBe(true);
    expect(hookMatches(undefined, 'anything')).toBe(true);
    expect(hookMatches('click', 'click')).toBe(true);
    expect(hookMatches('click', 'type')).toBe(false);
    expect(hookMatches('page_*', 'page_code')).toBe(true);
    expect(hookMatches('page_*', 'click')).toBe(false);
  });

  test('selectHooks filters by event + enabled + match, sorts by order', () => {
    const hooks = [
      { id: 'b', event: 'pre-tool-use' as const, order: 20, run: () => {} },
      { id: 'a', event: 'pre-tool-use' as const, order: 10, run: () => {} },
      { id: 'off', event: 'pre-tool-use' as const, enabled: false, run: () => {} },
      { id: 'post', event: 'post-tool-use' as const, run: () => {} },
      { id: 'scoped', event: 'pre-tool-use' as const, match: 'type', run: () => {} },
    ];
    const ids = selectHooks(hooks, 'pre-tool-use', 'click').map((h) => h.id);
    expect(ids).toEqual(['a', 'b']); // 'off' disabled, 'post' wrong event, 'scoped' wrong tool
  });
});

// ---- registry + storage + reversibility -----------------------------------

describe('registry', () => {
  test('registerHook + listHooks installs default (code) hooks', () => {
    registerHook({ id: 'd1', event: 'pre-tool-use', run: () => {} });
    expect(listHooks().map((h) => h.id)).toContain('d1');
  });

  test('saveUserHook persists + installs; removeHook + exportHooks give reversibility', async () => {
    const kv = makeKv();
    const record = {
      id: 'no-evil', event: 'pre-tool-use' as const, kind: 'declarative' as const,
      rule: { matchArg: 'url', contains: 'evil.com', onMatch: 'block' as const, reason: 'blocked evil.com' },
    };
    await saveUserHook({ kv }, record);
    // installed into the live registry...
    expect(listHooks().map((h) => h.id)).toContain('no-evil');
    // ...persisted to storage...
    expect((kv._store.get(HOOKS_STORAGE_KEY) as any[]).map((r) => r.id)).toEqual(['no-evil']);
    // ...exportable (reversibility surface)...
    expect(exportHooks().map((r) => r.id)).toEqual(['no-evil']);
    // ...and removable.
    await removeHook({ kv }, 'no-evil');
    expect(listHooks().map((h) => h.id)).not.toContain('no-evil');
    expect(kv._store.get(HOOKS_STORAGE_KEY)).toEqual([]);
  });

  test('saveUserHook rejects built-in IDs before persistence', async () => {
    const kv = makeKv();
    kv._store.set(HOOKS_STORAGE_KEY, [{
      id: 'existing', event: 'pre-tool-use', kind: 'declarative',
      rule: { matchArg: 'url', contains: 'existing' },
    }]);
    await expect(saveUserHook({ kv }, {
      id: 'egress-allowlist', event: 'pre-tool-use', kind: 'declarative',
      rule: { matchArg: 'url', contains: 'safe' },
    })).rejects.toThrow(/reserved for a built-in hook/);
    expect(kv._store.get(HOOKS_STORAGE_KEY)).toEqual([{
      id: 'existing', event: 'pre-tool-use', kind: 'declarative',
      rule: { matchArg: 'url', contains: 'existing' },
    }]);
    expect(exportHooks()).toEqual([]);
  });

  test('loadUserHooks compiles stored records and skips malformed ones', async () => {
    const kv = makeKv();
    kv._store.set(HOOKS_STORAGE_KEY, [
      { id: 'good', event: 'pre-tool-use', kind: 'declarative', rule: { matchArg: 'url', contains: 'x' } },
      { id: 'bad', event: 'pre-tool-use', kind: 'declarative' }, // missing rule
    ]);
    const { loaded, skipped } = await loadUserHooks({ kv, warn: () => {} });
    expect(loaded).toBe(1);
    expect(skipped).toBe(1);
    expect(listHooks().map((h) => h.id)).toContain('good');
  });

  test('loadUserHooks visibly retires legacy JS and blocks an enabled pre-hook', async () => {
    const legacy = {
      id: 'legacy-veto', event: 'pre-tool-use', enabled: true,
      match: 'fetch_url', kind: 'js', body: 'return { action: "allow" };',
    } as any;
    const result = await loadUserHooks({
      kv: { get: async () => [legacy] }, warn: () => {},
    });
    expect(result).toEqual({ loaded: 0, skipped: 1 });
    const visible = listHooks().find((hook: any) => hook.id === 'legacy-veto') as any;
    expect(visible).toMatchObject({
      enabled: true, unsupported: true,
      unsupportedReason: expect.stringContaining('retired'),
    });
    expect(await visible.run({ toolName: 'fetch_url', args: {}, ctx: {} }))
      .toMatchObject({ action: 'block', reason: expect.stringContaining('declarative') });
    expect(exportHooks()).toContainEqual(legacy);
  });

  test('loadUserHooks visibly retires a legacy regex rule and fails closed', async () => {
    const legacy = {
      id: 'legacy-regex', event: 'pre-tool-use', enabled: true,
      match: 'fetch_url', kind: 'declarative',
      rule: { matchArg: 'url', pattern: '(a+)+$' },
    } as any;
    const result = await loadUserHooks({
      kv: { get: async () => [legacy] }, warn: () => {},
    });
    expect(result).toEqual({ loaded: 0, skipped: 1 });
    const visible = listHooks().find((hook: any) => hook.id === 'legacy-regex') as any;
    expect(visible).toMatchObject({
      enabled: true, unsupported: true,
      unsupportedReason: expect.stringContaining('Regex hook rules were retired'),
    });
    expect(await visible.run({ toolName: 'fetch_url', args: {}, ctx: {} }))
      .toMatchObject({ action: 'block', reason: expect.stringContaining('contains') });
    expect(exportHooks()).toContainEqual(legacy);
  });

  test('loadUserHooks visibly retires and fail-closes a stored built-in ID collision', async () => {
    const kv = makeKv();
    const collision = {
      id: 'egress-allowlist', event: 'pre-tool-use', enabled: true,
      kind: 'declarative', rule: { matchArg: 'url', contains: 'secret' },
    } as any;
    kv._store.set(HOOKS_STORAGE_KEY, [collision]);
    registerHook({ id: 'egress-allowlist', event: 'pre-tool-use', run: () => undefined });
    expect(await loadUserHooks({ kv, warn: () => {} }))
      .toEqual({ loaded: 0, skipped: 1 });
    const collisions = listHooks().filter((hook) => hook.id === 'egress-allowlist') as any[];
    expect(collisions).toHaveLength(2);
    const retired = collisions.find((hook) => hook.unsupported === true);
    expect(retired?.unsupportedReason).toContain('reserved for a built-in hook');
    expect(await retired.run({ toolName: 'fetch_url', args: {}, ctx: {} }))
      .toMatchObject({ action: 'block', reason: expect.stringContaining('Rename') });
    await removeHook({ kv }, 'egress-allowlist');
    expect(kv._store.get(HOOKS_STORAGE_KEY)).toEqual([]);
    expect(listHooks().filter((hook) => hook.id === 'egress-allowlist')).toHaveLength(1);
  });
});

// ---- compile: declarative + js + markdown authoring -----------------------

describe('compileUserHook (declarative)', () => {
  test('declarative rule blocks on a matching arg', async () => {
    const hook = compileUserHook({
      id: 'block-evil', event: 'pre-tool-use', kind: 'declarative',
      rule: { matchArg: 'url', contains: 'evil.com', onMatch: 'block', reason: 'no evil' },
    });
    const blocked = await hook.run({ event: 'pre-tool-use', toolName: 'fetch', args: { url: 'https://evil.com/x' }, ctx } as any);
    expect(blocked).toMatchObject({ action: 'block', reason: 'no evil' });
    const ok = await hook.run({ event: 'pre-tool-use', toolName: 'fetch', args: { url: 'https://good.com' }, ctx } as any);
    expect(ok).toMatchObject({ action: 'allow' });
  });

  test('rejects legacy regex rules instead of executing them', () => {
    expect(() => compileUserHook({
      id: 'bad-re', event: 'pre-tool-use', kind: 'declarative',
      rule: { matchArg: 'url', pattern: '([' },
    } as any)).toThrow(/matchArg \+ contains/);
  });

  test('rejects every code-owned hook ID', () => {
    for (const id of ['egress-allowlist', 'egress-tripwire']) {
      expect(() => compileUserHook({
        id, event: 'pre-tool-use', kind: 'declarative',
        rule: { matchArg: 'url', contains: 'safe' },
      })).toThrow(/reserved for a built-in hook/);
    }
  });
});

describe('compileUserHook (legacy executable kinds)', () => {
  test('rejects JS source even when a legacy record claims trust', () => {
    expect(() => compileUserHook({
      id: 'legacy-js', event: 'pre-tool-use', kind: 'js', trusted: true,
      body: 'return { action: "allow" };',
    } as any)).toThrow(/executable JS hooks are not supported/);
  });
});

describe('parseHookMarkdown', () => {
  test('rejects frontmatter + JS bodies instead of dynamically compiling them', () => {
    const md = [
      '---',
      'id: block-secrets',
      'event: pre-tool-use',
      'match: type',
      'order: 50',
      'trusted: true',
      '---',
      'Block typing anything that looks like a secret.',
      '',
      '```js',
      'if (/sk-[A-Za-z0-9]{20,}/.test(inv.args.text ?? "")) return { action: "block", reason: "secret" };',
      '```',
    ].join('\n');
    expect(() => parseHookMarkdown(md)).toThrow(/executable JS hooks are not supported/);
  });

  test('parses a declarative rule block from frontmatter', () => {
    const md = [
      '---',
      'id: no-evil',
      'event: pre-tool-use',
      'rule:',
      '  matchArg: url',
      '  contains: evil',
      '  onMatch: block',
      '---',
      'Declarative deny.',
    ].join('\n');
    const rec = parseHookMarkdown(md);
    expect(rec.kind).toBe('declarative');
    expect(rec.rule).toEqual({ matchArg: 'url', contains: 'evil', onMatch: 'block' });
  });
});

// ---- dispatcher-shaped wiring (mini-dispatcher over the runner) ------------
//
// Proves the SAME order the real dispatcher uses: pre-hooks (may block /
// rewrite args) → execute → post-hooks (observe). This mirrors
// dispatcher.js lines without its egress absolute import.

describe('dispatcher-shaped: pre → execute → post', () => {
  const miniDispatch = async (hooks: any[], tool: any, args: any) => {
    const pre = await runPreToolUse({ hooks, toolName: tool.name, args, ctx });
    if (!pre.allowed) return { ok: false, error: pre.reason, ranExecute: false };
    const result = await tool.execute(pre.args);
    const post = await runPostToolUse({ hooks, toolName: tool.name, args: pre.args, result, ctx });
    return { ...result, ranExecute: true, hooks: [...pre.outcomes, ...post.outcomes] };
  };

  test('block prevents execute', async () => {
    let executed = false;
    const tool = { name: 'click', execute: async () => { executed = true; return { ok: true }; } };
    const hooks = [{ id: 'veto', event: 'pre-tool-use', run: () => ({ action: 'block', reason: 'denied' }) }];
    const out = await miniDispatch(hooks, tool, {});
    expect(out.ranExecute).toBe(false);
    expect(executed).toBe(false);
  });

  test('post observes the unchanged admitted args and result', async () => {
    let receivedArgs: any = null;
    let observedOk: any = null;
    const tool = { name: 'type', execute: async (a: any) => { receivedArgs = a; return { ok: true, content: 'typed' }; } };
    const hooks = [{
      id: 'watch', event: 'post-tool-use', run: (inv: any) => { observedOk = inv.result.ok; },
    }];
    const out = await miniDispatch(hooks, tool, { text: 'hi' });
    expect(receivedArgs).toEqual({ text: 'hi' });
    expect(observedOk).toBe(true);
    expect(out.ranExecute).toBe(true);
  });
});
