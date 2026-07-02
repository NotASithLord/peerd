// Per-session tool exposure manifests — the pure surfaces:
//   - presets-as-data invariants (the web actor's DOM toolset stays inside any
//     preset that grants message_actor — the actor inherits the manifest);
//   - normalize/resolve/label/filter semantics, fail-closed throughout;
//   - exposureGate's dispatch-time refusal via ctx.toolAllow;
//   - subagent narrowing: a child's effective set intersects the parent
//     session's manifest and the manifest INHERITS into the child record;
//   - session store: create/setToolManifest persistence ("unset" is the
//     ABSENT key, same contract as customSystemPrompt);
//   - the /tools command grammar (functional core, all IO injected).

import { describe, test, expect } from 'bun:test';
import {
  TOOL_MANIFEST_PRESETS,
  normalizeToolManifest,
  resolveManifestAllow,
  manifestLabel,
  filterDescriptorsByManifest,
} from '../../extension/peerd-runtime/tools/manifests.js';
import { makeToolsCommand } from '../../extension/peerd-runtime/tools/manifest-command.js';
import { exposureGate as exposureGateRaw } from '../../extension/peerd-runtime/tools/gates.js';
import { mainAgentDescriptors } from '../../extension/peerd-runtime/tools/exposure.js';
import { narrowTools, makeSpawnSubagent } from '../../extension/peerd-runtime/subagent/spawn.js';
import { WEB_ACTOR_DOM_TOOLS } from '../../extension/peerd-runtime/tools/exposure.js';
import { createSessionStore } from '../../extension/peerd-runtime/sessions/store.js';
// why: real JSDoc contracts from source — LoopEvent shapes the mock loop's
// yields, Session widens setToolManifest's inferred union return.
import type { LoopEvent } from '../../extension/peerd-runtime/loop/agent-loop.js';
import type { Session } from '../../extension/peerd-runtime/sessions/types.js';

type ToolT = import('../../extension/shared/tool-types.js').Tool;
type GateCtxT = import('../../extension/peerd-runtime/tools/gates.js').GateContext;

// exposureGate under test, with deliberately-minimal {name}/partial-ctx
// fixtures cast to the production Tool/GateContext the gate family declares
// (these pure tests read only a field or two; the real signature is unchanged).
const eg = (tool: { name: string }, args: unknown, ctx: object) =>
  exposureGateRaw(tool as unknown as ToolT, args, ctx as GateCtxT);

// ---- presets: data invariants ----------------------------------------------

describe('TOOL_MANIFEST_PRESETS — data invariants', () => {
  test('ships the named presets', () => {
    expect(Object.keys(TOOL_MANIFEST_PRESETS).sort()).toEqual(['browse-only', 'research']);
    for (const p of Object.values(TOOL_MANIFEST_PRESETS)) {
      expect(typeof p.description).toBe('string');
      expect(p.allow.length).toBeGreaterThan(0);
    }
  });

  test('research carries the web actor channel + its full DOM toolset (inherited via the manifest)', () => {
    const allow = new Set(TOOL_MANIFEST_PRESETS.research.allow);
    for (const name of ['message_actor', 'actor_list', 'open_tab']) expect(allow.has(name)).toBe(true);
    // the web actor inherits the owner chat's manifest, so the DOM toolset must ride it
    for (const name of WEB_ACTOR_DOM_TOOLS) expect(allow.has(name)).toBe(true);
    // do/get/check are gone — the manifest never names them
    for (const name of ['do', 'get', 'check']) expect(allow.has(name)).toBe(false);
  });

  test('browse-only carries the READ DOM subset only, no mutating internals', () => {
    const allow = new Set(TOOL_MANIFEST_PRESETS['browse-only'].allow);
    for (const name of ['message_actor', 'snapshot', 'read_page', 'read_state', 'query_dom', 'read_pdf', 'view']) {
      expect(allow.has(name)).toBe(true);
    }
    for (const name of ['do', 'get', 'check', 'click', 'type', 'page_keys', 'watch_changes']) {
      expect(allow.has(name)).toBe(false);
    }
  });

  test('neither preset exposes execution, file edits, or spawning', () => {
    for (const p of Object.values(TOOL_MANIFEST_PRESETS)) {
      const allow = new Set(p.allow);
      for (const name of [
        'vm_boot', 'vm_create', 'vm_delete', 'js_notebook', 'js_create',
        'app_create', 'app_update', 'edit_file', 'spawn_subagent',
        'page_eval', 'page_exec', 'request_review', 'load_skill',
      ]) {
        expect(allow.has(name)).toBe(false);
      }
    }
  });

  test('browse-only is the stricter preset: browse-only ⊆ research', () => {
    const research = new Set(TOOL_MANIFEST_PRESETS.research.allow);
    for (const name of TOOL_MANIFEST_PRESETS['browse-only'].allow) {
      expect(research.has(name)).toBe(true);
    }
  });
});

// ---- normalize / resolve / label / filter ----------------------------------

describe('normalizeToolManifest', () => {
  test('null/undefined → null (no manifest, full exposure)', () => {
    expect(normalizeToolManifest(null)).toBe(null);
    expect(normalizeToolManifest(undefined)).toBe(null);
  });

  test('present-but-garbage fails CLOSED to the empty manifest, never null', () => {
    expect(normalizeToolManifest({})).toEqual({ allow: [] });
    expect(normalizeToolManifest('research')).toEqual({ allow: [] });
    expect(normalizeToolManifest(42)).toEqual({ allow: [] });
    expect(normalizeToolManifest(['snapshot'])).toEqual({ allow: [] });
    expect(normalizeToolManifest({ preset: 7, allow: 'snapshot' })).toEqual({ allow: [] });
  });

  test('keeps a trimmed preset and string-filtered allow', () => {
    expect(normalizeToolManifest({ preset: '  research ' })).toEqual({ preset: 'research' });
    expect(normalizeToolManifest({ allow: ['snapshot', 7, '', 'read_page'] as any })).toEqual({ allow: ['snapshot', 'read_page'] });
    expect(normalizeToolManifest({ preset: 'research', allow: ['extra'] }))
      .toEqual({ preset: 'research', allow: ['extra'] });
  });
});

describe('resolveManifestAllow', () => {
  test('absent manifest → null (everything stays exposed)', () => {
    expect(resolveManifestAllow(undefined)).toBe(null);
    expect(resolveManifestAllow(null)).toBe(null);
  });

  test('preset resolves to its allow list', () => {
    const allow = resolveManifestAllow({ preset: 'browse-only' })!;
    expect(allow.has('snapshot')).toBe(true);
    expect(allow.has('click')).toBe(false);
    expect(allow.size).toBe(TOOL_MANIFEST_PRESETS['browse-only'].allow.length);
  });

  test('allow alone, and preset ∪ allow (allow only ever EXTENDS)', () => {
    expect([...resolveManifestAllow({ allow: ['snapshot', 'read_page'] })!].sort()).toEqual(['read_page', 'snapshot']);
    const merged = resolveManifestAllow({ preset: 'browse-only', allow: ['remember'] })!;
    expect(merged.has('remember')).toBe(true);
    expect(merged.has('snapshot')).toBe(true);
  });

  test('unknown preset contributes NOTHING — fail-closed, never the full registry', () => {
    expect(resolveManifestAllow({ preset: 'no-such-preset' })!.size).toBe(0);
    const allow = resolveManifestAllow({ preset: 'no-such-preset', allow: ['snapshot'] })!;
    expect([...allow]).toEqual(['snapshot']);
    // garbage-but-present manifest → empty set
    expect(resolveManifestAllow({})!.size).toBe(0);
  });
});

describe('manifestLabel', () => {
  test('null for no manifest; preset name; +N for extensions; custom count', () => {
    expect(manifestLabel(null)).toBe(null);
    expect(manifestLabel({ preset: 'research' })).toBe('research');
    expect(manifestLabel({ preset: 'research', allow: ['a', 'b'] })).toBe('research +2');
    expect(manifestLabel({ allow: ['a'] })).toBe('custom (1 tool)');
    expect(manifestLabel({ allow: ['a', 'b'] })).toBe('custom (2 tools)');
    expect(manifestLabel({})).toBe('custom (0 tools)');
  });
});

describe('filterDescriptorsByManifest', () => {
  const descs = [{ name: 'remember' }, { name: 'vm_boot' }, { name: 'now' }];

  test('null allow passes everything through; a Set intersects, order preserved', () => {
    expect(filterDescriptorsByManifest(descs, null)).toEqual(descs);
    expect(filterDescriptorsByManifest(descs, new Set(['now', 'remember'])).map((t) => t.name))
      .toEqual(['remember', 'now']);
    expect(filterDescriptorsByManifest(descs, new Set())).toEqual([]);
  });

  test('composes after mainAgentDescriptors — the manifest can NEVER re-expose an actor-only tool to main', () => {
    const all = [{ name: 'remember' }, { name: 'click' }, { name: 'navigate' }, { name: 'now' }];
    // a manifest naming the hidden DOM tools (browse-only names navigate for
    // the web actor) still yields a main list without them
    const allow = new Set(['remember', 'click', 'navigate', 'now']);
    expect(filterDescriptorsByManifest(mainAgentDescriptors(all), allow).map((t) => t.name))
      .toEqual(['remember', 'now']);
  });
});

// ---- exposure gate: dispatch-time enforcement -------------------------------

describe('exposureGate — per-session manifest refusal at dispatch', () => {
  test('refuses a manifest-excluded tool BY NAME, naming the manifest in the reason', () => {
    // call_api is a non-tiered tool, so the MANIFEST gate is what refuses it — a
    // mutating tool (vm_boot) would be refused earlier by the actor tier, which
    // precedes the manifest check in exposureGate.
    const ctx = { exposure: 'main', toolAllow: new Set(['snapshot', 'read_page']), toolManifestLabel: 'browse-only' };
    const r = eg({ name: 'call_api' }, {}, ctx);
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('tool manifest');
    expect(r.reason).toContain('browse-only');
  });

  test('allows manifest-included tools; null toolAllow keeps today\'s behavior', () => {
    // js_run (a main-agent tool) exercises the manifest allow-path; the DOM tools
    // would be refused earlier by the web-actor cutover, so they can't be used here.
    expect(eg({ name: 'js_run' }, {}, { exposure: 'main', toolAllow: new Set(['js_run']) }).allowed).toBe(true);
    // js_run stays on the main agent (not the actor-mutating tier), so a
    // null/absent manifest leaves it allowed — the no-manifest status quo.
    expect(eg({ name: 'js_run' }, {}, { exposure: 'main', toolAllow: null }).allowed).toBe(true);
    expect(eg({ name: 'js_run' }, {}, { exposure: 'main' }).allowed).toBe(true);
  });

  test('applies to CHILD contexts too (exposure unset) — a child never escalates past the manifest', () => {
    // call_api is non-tiered, so this exercises the manifest refusal itself (a
    // mutating tool would be refused earlier by the actor tier).
    const r = eg({ name: 'call_api' }, {}, { toolAllow: new Set(['snapshot']), toolManifestLabel: 'research' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('tool manifest');
  });

  test('the actor-only main check still wins even when the manifest allows the name', () => {
    // research includes 'click' so the web actor may use it; the main agent
    // must still be refused (the manifest narrows, never widens).
    const r = eg({ name: 'click' }, {}, { exposure: 'main', toolAllow: new Set(['click']) });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('actor-only');
  });

  test('an EMPTY allow-set (fail-closed resolution) refuses everything', () => {
    expect(eg({ name: 'remember' }, {}, { toolAllow: new Set() }).allowed).toBe(false);
  });
});

// ---- subagent narrowing intersection ----------------------------------------

describe('narrowTools — manifest intersection', () => {
  const all = [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'spawn_subagent' }];

  test('intersects the inherited set with the parent manifest allow', () => {
    expect(narrowTools(all, { allow: new Set(['b', 'c']) }).map((t) => t.name)).toEqual(['b', 'c']);
  });

  test('intersects an EXPLICIT tools list too — a caller cannot escalate past the manifest', () => {
    expect(narrowTools(all, { tools: ['a', 'b'], allow: new Set(['b']) }).map((t) => t.name)).toEqual(['b']);
  });

  test('allowRecursion cannot resurrect spawn_subagent when the manifest excludes it', () => {
    expect(narrowTools(all, { allowRecursion: true, allow: new Set(['a']) }).map((t) => t.name)).toEqual(['a']);
  });

  test('null allow leaves the existing behavior untouched', () => {
    expect(narrowTools(all, { allow: null }).map((t) => t.name)).toEqual(['a', 'b', 'c']);
  });
});

describe('makeSpawnSubagent — the parent manifest caps and follows the child', () => {
  // Mini store mirroring createSessionStore's create/get surface,
  // INCLUDING toolManifest passthrough.
  const makeMiniStore = () => {
    const map = new Map<string, any>();
    let n = 0;
    return {
      map,
      create: async (opts: any = {}) => {
        const s = {
          sessionId: `s-${++n}`,
          createdAt: n,
          messages: [] as any[],
          provider: opts.provider ?? 'anthropic',
          model: opts.model ?? 'm',
          kind: opts.kind ?? 'chat',
          depth: opts.depth ?? 0,
          ...(opts.toolManifest !== undefined ? { toolManifest: opts.toolManifest } : {}),
          ...(opts.parentSessionId ? { parentSessionId: opts.parentSessionId } : {}),
          ...(opts.task ? { task: opts.task } : {}),
        };
        map.set(s.sessionId, s);
        return s;
      },
      get: async (id: string) => map.get(id),
      appendMessage: async (id: string, msg: any) => {
        const s = map.get(id);
        s.messages.push(msg);
        return s;
      },
    };
  };

  const harness = (store: any) => {
    const seenTools: any[] = [];
    const dispatched: string[] = [];
    async function* loop(ctx: any): AsyncGenerator<LoopEvent> {
      seenTools.push(ctx.tools);
      if (ctx.toolDispatch) {
        await ctx.toolDispatch({ id: 't1', name: 'b', args: {} });
        await ctx.toolDispatch({ id: 't2', name: 'c', args: {} });
      }
      await ctx.sessions.appendMessage(ctx.sessionId, { role: 'assistant', content: 'done' });
      // why: LoopEvent's stop variant requires messageId; the orchestrator
      // never reads it, so a fixed mock id just completes the shape.
      yield { type: 'stop', sessionId: ctx.sessionId, messageId: 'm-mock', stopReason: 'end_turn' };
    }
    const deps = {
      sessions: store,
      runUserTurn: loop,
      callModel: async function* () { yield { type: 'message-stop', stopReason: 'end_turn' }; },
      getSecret: async () => 'sk',
      safeFetch: async () => new Response('ok'),
      appendAudit: async () => {},
      buildToolContext: async ({ sessionId }: any) => ({ session: { sessionId }, audit: async () => {} }),
      dispatchToolCall: async (call: any) => { dispatched.push(call.name); return { ok: true, content: 'ran' }; },
      renderSystemPrompt: async () => 'sys',
      getToolDescriptors: () => [
        { name: 'a', description: 'A', schema: {} },
        { name: 'b', description: 'B', schema: {} },
        { name: 'c', description: 'C', schema: {} },
      ],
    };
    return { deps, seenTools, dispatched };
  };

  test('descriptors intersect the parent manifest; out-of-manifest dispatch is refused; child inherits the manifest', async () => {
    const store = makeMiniStore();
    const parent = await store.create({ toolManifest: { allow: ['b'] } });
    const { deps, seenTools, dispatched } = harness(store);
    const spawn = makeSpawnSubagent(deps);

    const out = await spawn({ task: 't', parentSessionId: parent.sessionId, tools: ['b', 'c'] });

    // descriptor layer: requested {b,c} ∩ manifest {b} = {b}
    expect(seenTools[0].map((t: any) => t.name)).toEqual(['b']);
    // dispatch layer: 'c' never reached dispatchToolCall (allowedNames refusal)
    expect(dispatched).toEqual(['b']);
    // inheritance: the child RECORD carries the parent's manifest verbatim
    const child = store.map.get(out.sessionId!);
    expect(child.toolManifest).toEqual({ allow: ['b'] });
  });

  test('no parent manifest → behavior unchanged and the child record stays clean', async () => {
    const store = makeMiniStore();
    const parent = await store.create({});
    const { deps, seenTools } = harness(store);
    const spawn = makeSpawnSubagent(deps);

    const out = await spawn({ task: 't', parentSessionId: parent.sessionId });

    expect(seenTools[0].map((t: any) => t.name)).toEqual(['a', 'b', 'c']);
    expect('toolManifest' in store.map.get(out.sessionId!)).toBe(false);
  });
});

// ---- session store persistence ----------------------------------------------

const makeIdb = () => {
  const stores = new Map<string, Map<string, any>>();
  const tbl = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    return stores.get(name)!;
  };
  return {
    get: async (store: string, key: string) => tbl(store).get(key),
    // Key by the store's keyPath: session_messages records carry `id`,
    // session records carry `sessionId` (v8 per-message store).
    put: async (store: string, val: any) => { tbl(store).set(val.id ?? val.sessionId, val); },
    getAll: async (store: string) => [...tbl(store).values()],
  };
};

const makeRealStore = () => {
  let i = 0;
  return createSessionStore({ idb: makeIdb(), now: () => 1000, makeId: () => `id-${++i}` });
};

describe('session store — toolManifest', () => {
  test('create persists a normalized manifest and omits the key otherwise', async () => {
    const store = makeRealStore();
    const withManifest = await store.create({ toolManifest: { preset: ' research ' } });
    expect(withManifest.toolManifest).toEqual({ preset: 'research' });

    const without = await store.create({});
    expect('toolManifest' in without).toBe(false);

    // present-but-garbage persists the fail-closed EMPTY manifest — a
    // corrupted input must narrow to nothing, not widen to everything
    const garbage = await store.create({ toolManifest: 'research' as any });
    expect(garbage.toolManifest).toEqual({ allow: [] });
  });

  test('setToolManifest sets, replaces, and CLEARS (key removed, not emptied)', async () => {
    const store = makeRealStore();
    const s = await store.create({});

    // why: setToolManifest's inferred return is a union (with/without the
    // key); both branches are Sessions, so the annotation widens cleanly.
    const set: Session = await store.setToolManifest(s.sessionId, { preset: 'browse-only' });
    expect(set.toolManifest).toEqual({ preset: 'browse-only' });
    expect((await store.get(s.sessionId))!.toolManifest).toEqual({ preset: 'browse-only' });

    const replaced: Session = await store.setToolManifest(s.sessionId, { allow: ['snapshot'] });
    expect(replaced.toolManifest).toEqual({ allow: ['snapshot'] });

    const cleared = await store.setToolManifest(s.sessionId, null);
    expect('toolManifest' in cleared).toBe(false);
    expect('toolManifest' in (await store.get(s.sessionId))!).toBe(false);
  });

  test('clearing preserves every other field on the record', async () => {
    const store = makeRealStore();
    const s = await store.create({ provider: 'openrouter', model: 'm-1', toolManifest: { preset: 'research' } });
    await store.appendMessage(s.sessionId, { role: 'user', content: 'hello', id: 'm1', when: 1 } as any);
    const cleared = await store.setToolManifest(s.sessionId, null);
    expect(cleared.provider).toBe('openrouter');
    expect(cleared.model).toBe('m-1');
    expect(cleared.messages.length).toBe(1);
    expect(cleared.title).toBe('hello');
  });
});

// ---- /tools command grammar ---------------------------------------------------

describe('makeToolsCommand — grammar over injected IO', () => {
  const harness = (opts: { sessionId?: string | undefined } = {}) => {
    const store = makeRealStore();
    const notes: string[] = [];
    const audits: any[] = [];
    let currentId: string | undefined = opts.sessionId;
    const cmd = makeToolsCommand({
      sessions: store,
      getCurrentSessionId: async () => currentId,
      ensureSession: async () => {
        if (!currentId) currentId = (await store.create({})).sessionId;
        return currentId;
      },
      postNote: (t: string) => { notes.push(t); },
      audit: async (e: any) => { audits.push(e); },
    });
    return { cmd, store, notes, audits, current: () => currentId };
  };

  test('set: persists the preset, audits the EVENT (preset name only), returns the session', async () => {
    const { cmd, store, notes, audits, current } = harness();
    const out = await cmd('research');
    // why: makeToolsCommand's JSDoc types `session` as a bare object — narrow
    // before the property read (the runtime record is a full Session).
    if (!out.session || !('toolManifest' in out.session)) throw new Error('expected session.toolManifest');
    expect(out.session.toolManifest).toEqual({ preset: 'research' });
    expect((await store.get(current()!))!.toolManifest).toEqual({ preset: 'research' });
    expect(notes[0]).toContain('research');
    expect(audits[0].type).toBe('tool_manifest_set');
    expect(audits[0].details).toEqual({ preset: 'research' });
  });

  test('set is case-insensitive and lazily creates the session (the /system contract)', async () => {
    const { cmd, current } = harness();
    expect(current()).toBe(undefined);
    const out = await cmd('Browse-Only');
    expect(current()).not.toBe(undefined);
    // why: same bare-object narrowing as the set test above.
    if (!out.session || !('toolManifest' in out.session)) throw new Error('expected session.toolManifest');
    expect(out.session.toolManifest).toEqual({ preset: 'browse-only' });
  });

  test('unknown preset: error note listing presets, NOTHING persisted, no session created', async () => {
    const { cmd, notes, audits, current } = harness();
    const out = await cmd('yolo');
    expect(out.session).toBe(null);
    expect(current()).toBe(undefined);
    expect(audits.length).toBe(0);
    expect(notes[0]).toContain("Unknown tool preset 'yolo'");
    expect(notes[0]).toContain('research');
    expect(notes[0]).toContain('browse-only');
  });

  test('full/clear: removes the manifest and audits; without a chat it just explains', async () => {
    const { cmd, store, notes, audits, current } = harness();
    await cmd('research');
    const out = await cmd('full');
    expect('toolManifest' in out.session!).toBe(false);
    expect('toolManifest' in (await store.get(current()!))!).toBe(false);
    expect(audits[1].type).toBe('tool_manifest_cleared');

    const empty = harness();
    const res = await empty.cmd('clear');
    expect(res.session).toBe(null);
    expect(empty.notes[0]).toContain('No active chat');
  });

  test('show: reports the active manifest or the full default; list names every preset', async () => {
    const { cmd, notes } = harness();
    await cmd('');
    expect(notes[0]).toContain('No tool manifest set');
    await cmd('browse-only');
    await cmd('');
    expect(notes[2]).toContain('browse-only');
    expect(notes[2]).toContain(`${TOOL_MANIFEST_PRESETS['browse-only'].allow.length} tools exposed`);
    await cmd('list');
    expect(notes[3]).toContain('/tools research');
    expect(notes[3]).toContain('/tools browse-only');
    expect(notes[3]).toContain('/tools full');
  });
});
