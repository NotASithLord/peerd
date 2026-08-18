import { describe, test, expect } from 'bun:test';
import {
  mainAgentDescriptors, isHiddenFromMain,
  filterByDwebEnabled, isDwebTool,
  filterByDwebActive, isDwebSecondaryTool,
  isActorOnlyTool, actorAllowedTools, isAllowedForActorType,
  actorAllowedToolsFor, isAllowedForActor,
  actorTargetId, actorTargetIdField, actorDescriptors, filterActorSurface,
  EXPOSURE_ACTOR,
  WEB_ACTOR_DOM_TOOLS, actorWebTabTarget,
} from '../../extension/peerd-runtime/tools/exposure.js';
import { exposureGate as exposureGateRaw, actorTierGate } from '../../extension/peerd-runtime/tools/gates.js';

type ToolT = import('../../extension/shared/tool-types.js').Tool;
type GateCtxT = import('../../extension/peerd-runtime/tools/gates.js').GateContext;

// exposureGate under test, with the deliberately-minimal {name}/partial-ctx
// fixtures cast to the production Tool/GateContext the gate family declares.
// These pure tests read only a field or two; the casts keep the fixtures terse
// without weakening the real gate signature (which the dispatcher relies on).
const eg = (tool: { name: string }, args: unknown, ctx: object) =>
  exposureGateRaw(tool as unknown as ToolT, args, ctx as GateCtxT);

describe('dweb tool exposure (off the store build)', () => {
  const tools = [{ name: 'sandbox_create' }, { name: 'dweb_share', dweb: true }, { name: 'remember' }, { name: 'dweb_discover', dweb: true }];
  test('isDwebTool reads the dweb flag', () => {
    expect(isDwebTool({ name: 'dweb_share', dweb: true })).toBe(true);
    expect(isDwebTool({ name: 'sandbox_create' })).toBe(false);
  });
  test('hides dweb tools when the dweb is off; keeps the rest', () => {
    expect(filterByDwebEnabled(tools, false).map((t) => t.name)).toEqual(['sandbox_create', 'remember']);
  });
  test('keeps dweb tools when the dweb is on', () => {
    expect(filterByDwebEnabled(tools, true).map((t) => t.name)).toEqual(['sandbox_create', 'dweb_share', 'remember', 'dweb_discover']);
  });
});

describe('dweb tool exposure (progressive disclosure of the SECONDARY surface)', () => {
  const dwebOn = [
    { name: 'dweb_discover' }, { name: 'dweb_share' }, { name: 'dweb_install' },
    { name: 'dweb_peers' }, { name: 'dweb_block' }, { name: 'dweb_discovery' }, { name: 'dweb_guide' },
    { name: 'sandbox_create' },
  ];
  test('isDwebSecondaryTool flags exactly the deferred set (dweb_guide is ENTRY, not deferred)', () => {
    for (const n of ['dweb_peers', 'dweb_block', 'dweb_discovery']) expect(isDwebSecondaryTool(n)).toBe(true);
    // dweb_guide is an ENTRY tool — the prompt tells the agent to call it FIRST,
    // before any other dweb tool, so it must NOT be gated behind engagement.
    for (const n of ['dweb_discover', 'dweb_share', 'dweb_install', 'dweb_guide', 'sandbox_create']) expect(isDwebSecondaryTool(n)).toBe(false);
  });
  test('hides the secondary tools until the session has engaged the dweb; dweb_guide stays visible', () => {
    expect(filterByDwebActive(dwebOn, false).map((t) => t.name))
      .toEqual(['dweb_discover', 'dweb_share', 'dweb_install', 'dweb_guide', 'sandbox_create']); // entry tools (incl. guide) survive
  });
  test('reveals the secondary tools once engaged', () => {
    expect(filterByDwebActive(dwebOn, true).map((t) => t.name)).toEqual(dwebOn.map((t) => t.name));
  });
});

describe('tool exposure (main-agent cutover)', () => {
  test('hides the low-level DOM/page tools from the main agent', () => {
    for (const name of ['snapshot', 'read_page', 'read_state', 'watch_changes', 'query_dom', 'page_eval', 'page_exec', 'page_keys', 'navigate', 'type', 'click', 'read_pdf']) {
      expect(isHiddenFromMain(name)).toBe(true);
    }
  });

  test('keeps tab management + non-browser tools visible to the main agent', () => {
    for (const name of ['actor_list', 'open_tab', 'message_actor', 'actor_create', 'vm_boot', 'remember']) {
      expect(isHiddenFromMain(name)).toBe(false);
    }
  });

  test('mainAgentDescriptors removes exactly the hidden set, order preserved', () => {
    const all = [{ name: 'message_actor' }, { name: 'snapshot' }, { name: 'click' }, { name: 'open_tab' }, { name: 'actor_list' }, { name: 'page_exec' }, { name: 'remember' }];
    expect(mainAgentDescriptors(all).map((t) => t.name)).toEqual(['message_actor', 'open_tab', 'actor_list', 'remember']);
  });
});

describe('exposureGate — enforcement at dispatch (not just the descriptor list)', () => {
  test('refuses a hidden tool when the context is the MAIN agent', () => {
    const r = eg({ name: 'page_exec' }, {}, { exposure: 'main' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('actor-only');
  });

  test('allows a hidden tool for the actor / actor (exposure unset)', () => {
    expect(eg({ name: 'page_exec' }, {}, {}).allowed).toBe(true);
    expect(eg({ name: 'snapshot' }, {}, { exposure: null }).allowed).toBe(true);
  });

  test('always allows a non-hidden tool, even on the main turn', () => {
    expect(eg({ name: 'open_tab' }, {}, { exposure: 'main' }).allowed).toBe(true);
    expect(eg({ name: 'actor_list' }, {}, { exposure: 'main' }).allowed).toBe(true);
  });

  // DESIGN-17 web-actor cutover: the low-level DOM/page tools leave the MAIN
  // agent (it messages a tab's actor instead). The web actor holds them; the
  // main turn is refused any of them at dispatch.
  test('refuses the DOM/page tools on the MAIN turn (they belong to the web actor)', () => {
    for (const name of ['snapshot', 'click', 'type', 'navigate', 'read_page']) {
      const r = eg({ name }, {}, { exposure: 'main' });
      expect(r.allowed).toBe(false);
      expect(r.reason).toContain('actor');
    }
  });
});

describe('the instance-gating machinery is GONE (folded into the actor tier)', () => {
  test('a create/entry tool passes on the main turn with no instances anywhere', () => {
    // No instanceState anywhere in the ctx — the gate must not care.
    for (const n of ['sandbox_create', 'actor_list', 'app_open', 'app_search', 'script']) {
      expect(eg({ name: n }, {}, { exposure: 'main' }).allowed).toBe(true);
    }
  });

  test('a premature instance op is refused as ACTOR-ONLY (not "create one first")', () => {
    // The old machinery answered "needs a current app — create one first";
    // the honest answer is that the op belongs to the instance actor.
    const r = eg({ name: 'app_write_file' }, {}, { exposure: 'main' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('actor-only');
  });
});

// ── DESIGN-17: actor tab agents — the capability tier ────────────────────
// The gate's actor logic is a pure function (actorTierGate). The actor
// model is unconditional (the source flags were removed), so the tier is always
// enforced. null = "no actor-tier opinion" (the gate continues).
const rt = (tool: { name: string }, args: unknown, ctx: object) =>
  actorTierGate(tool as unknown as ToolT, args, ctx as GateCtxT);

describe('DESIGN-17 actor tier — the tool sets', () => {
  test('the actor-only tier is what leaves the main agent — writes AND the fenced reads', () => {
    for (const n of ['vm_boot', 'vm_write_file', 'vm_import', 'vm_delete',
      'js_notebook', 'js_write_file', 'js_read_file', 'js_delete',
      'pod_exec', 'pod_status', 'pod_cancel', 'pod_read', 'pod_write', 'pod_destroy',
      'app_update', 'app_write_file', 'app_read_file', 'app_list_files',
      'app_delete_file', 'app_delete', 'app_observe', 'app_act', 'app_code', 'edit_file',
      'repo_history', 'repo_version', 'repo_remote']) {
      expect(isActorOnlyTool(n)).toBe(true);
    }
    // The bootstrap/catalog surface + script stay on the orchestrator.
    for (const n of ['sandbox_create', 'actor_list', 'script',
      'app_open', 'app_search', 'message_actor']) {
      expect(isActorOnlyTool(n)).toBe(false);
    }
  });

  test('actorAllowedTools scopes each kind to its own surface (+ reads + edit_file)', () => {
    expect([...actorAllowedTools('webvm')].sort()).toEqual(
      ['vm_boot', 'vm_delete', 'vm_import', 'vm_write_file'].sort());
    expect(isAllowedForActorType('app_update', 'app')).toBe(true);
    expect(isAllowedForActorType('app_read_file', 'app')).toBe(true); // reads allowed for its own
    expect(isAllowedForActorType('app_observe', 'app')).toBe(true);
    expect(isAllowedForActorType('app_act', 'app')).toBe(true);
    expect(isAllowedForActorType('app_code', 'app')).toBe(true);
    expect(isAllowedForActorType('edit_file', 'app')).toBe(true);
    expect(isAllowedForActorType('edit_file', 'notebook')).toBe(true);
    expect(isAllowedForActorType('repo_history', 'app')).toBe(true);
    expect(isAllowedForActorType('repo_history', 'notebook')).toBe(true);
    expect(isAllowedForActorType('pod_exec', 'pod')).toBe(true);
    expect(isAllowedForActorType('pod_read', 'pod')).toBe(true);
    expect(isAllowedForActorType('vm_boot', 'pod')).toBe(false);
    expect(isAllowedForActorType('repo_history', 'webvm')).toBe(false);
    expect(isAllowedForActorType('edit_file', 'webvm')).toBe(false);   // no vm files via edit_file
    expect(isAllowedForActorType('vm_boot', 'app')).toBe(false);       // foreign kind
    expect(isAllowedForActorType('call_api', 'app')).toBe(false);      // non-env tool
    expect(isAllowedForActorType('vm_boot', undefined as unknown as string)).toBe(false);
  });

  test('actorTargetId reads the correct per-tool arg (the pin source)', () => {
    expect(actorTargetIdField('app_delete')).toBe('appId');
    expect(actorTargetIdField('vm_boot')).toBe('vm');
    expect(actorTargetIdField('vm_delete')).toBe('vmId');
    expect(actorTargetIdField('js_delete')).toBe('notebookId');
    expect(actorTargetIdField('js_notebook')).toBe('notebook');
    expect(actorTargetIdField('pod_exec')).toBe('podId');
    expect(actorTargetIdField('pod_destroy')).toBe('podId');
    expect(actorTargetIdField('edit_file')).toBe('targetId');
    // Repository tools name no id at all: they derive kind + id from the
    // server-stamped actor context, so there is no model-controlled target.
    expect(actorTargetIdField('repo_history')).toBe(null);
    expect(actorTargetIdField('vm_write_file')).toBe(null);  // session-default only
    expect(actorTargetId('app_delete', { appId: 'app-9' })).toBe('app-9');
    expect(actorTargetId('app_delete', {})).toBeUndefined();
    expect(actorTargetId('vm_write_file', { path: '/x' })).toBeUndefined();
  });

  test('actorDescriptors filters to the kind; filterActorSurface strips the main surface', () => {
    const all = [{ name: 'app_update' }, { name: 'vm_boot' }, { name: 'remember' }, { name: 'message_actor' }, { name: 'open_tab' }];
    expect(actorDescriptors(all, 'app').map((t) => t.name)).toEqual(['app_update']);
    // The mutating tier leaves the main agent (delegated via message_actor);
    // message_actor + open_tab + non-instance tools stay.
    expect(filterActorSurface(all).map((t) => t.name)).toEqual(['remember', 'message_actor', 'open_tab']);
  });
});

describe('App actor code-first runtime surface', () => {
  test('collapses direct runtime verbs into app_code while preserving code-writing tools', () => {
    const code = actorAllowedToolsFor('app', undefined, 'code');
    expect(code.has('app_code')).toBe(true);
    expect(code.has('app_observe')).toBe(false);
    expect(code.has('app_act')).toBe(false);
    expect(code.has('edit_file')).toBe(true);
    expect(code.has('app_write_file')).toBe(true);
  });

  test('enforces the surface at the gate, not only in descriptors', () => {
    const ctx = { exposure: 'actor', actorType: 'app', actorInstanceId: 'app-1', actorSurface: 'code' };
    expect(rt({ name: 'app_code' }, { code: 'return app.observe()' }, ctx)).toBeNull();
    expect(rt({ name: 'app_observe' }, {}, ctx)?.allowed).toBe(false);
    expect(rt({ name: 'app_act' }, { action: 'move' }, ctx)?.allowed).toBe(false);
  });
});

describe('DESIGN-17 actor tier — the gate (the wall)', () => {
  test('a NON-actor (actor/main/direct) is refused the mutating tier', () => {
    // THE PROOF: a `actor_create({tools:['app_delete']})` child has exposure
    // unset → refused at the gate even though the tool name is in its subset.
    for (const ctx of [{}, { exposure: 'main' }, { exposure: null }, { exposure: 'spawned' }]) {
      const r = rt({ name: 'app_delete' }, {}, ctx);
      expect(r?.allowed).toBe(false);
      expect(r?.reason).toContain('actor-only');
    }
    expect(rt({ name: 'edit_file' }, {}, { exposure: 'main' })?.allowed).toBe(false);
  });

  test('the fenced reads ARE tiered — refused for every non-actor ctx (owner call 2026-07-05)', () => {
    // The old "cheap global read" affordance let untrusted instance bytes
    // (notebook/app code persists web data) reach the orchestrator's context
    // even fenced — culled; a read is an actor turn like any other op.
    for (const n of ['app_read_file', 'app_list_files', 'js_read_file']) {
      expect(rt({ name: n }, {}, {})?.allowed).toBe(false);
      expect(rt({ name: n }, {}, { exposure: 'main' })?.allowed).toBe(false);
    }
    // ...and each remains allowed for ITS OWN kind's actor.
    expect(rt({ name: 'js_read_file' }, {}, { exposure: EXPOSURE_ACTOR, actorType: 'notebook', actorInstanceId: 'nb-1' })).toBeNull();
    expect(rt({ name: 'app_read_file' }, {}, { exposure: EXPOSURE_ACTOR, actorType: 'app', actorInstanceId: 'app-1' })).toBeNull();
  });

  test('an actor may call its own kind; foreign/non-env tools fail closed', () => {
    const appCtx = { exposure: EXPOSURE_ACTOR, actorType: 'app', actorInstanceId: 'app-1' };
    expect(rt({ name: 'app_update' }, {}, appCtx)).toBeNull();          // allowed
    expect(rt({ name: 'vm_boot' }, {}, appCtx)?.allowed).toBe(false);   // foreign kind
    expect(rt({ name: 'call_api' }, {}, appCtx)?.allowed).toBe(false);  // non-env
    expect(rt({ name: 'actor_create' }, {}, appCtx)?.allowed).toBe(false);
    const podCtx = { exposure: EXPOSURE_ACTOR, actorType: 'pod', actorInstanceId: 'pod-1' };
    expect(rt({ name: 'pod_exec' }, { podId: 'pod-1' }, podCtx)).toBeNull();
    expect(rt({ name: 'pod_exec' }, { podId: 'pod-2' }, podCtx)?.allowed).toBe(false);
    expect(rt({ name: 'js_notebook' }, {}, podCtx)?.allowed).toBe(false);
  });

  test('the per-instance pin refuses a sibling id, allows the bound id / no id', () => {
    // The actor dispatch wrapper (pinActorCall) normalizes any id/name arg
    // to the bound INSTANCE ID before the gate runs, so the gate only ever sees
    // ids — it refuses any explicit id that isn't the bound one.
    const ctx = { exposure: EXPOSURE_ACTOR, actorType: 'app', actorInstanceId: 'app-1' };
    expect(rt({ name: 'app_delete' }, { appId: 'app-2' }, ctx)?.allowed).toBe(false); // sibling
    expect(rt({ name: 'app_delete' }, { appId: 'app-1' }, ctx)).toBeNull();           // own id
    expect(rt({ name: 'app_delete' }, {}, ctx)).toBeNull();                           // wrapper injects
    // a webvm actor pinned by name-or-id arg
    const vm = { exposure: EXPOSURE_ACTOR, actorType: 'webvm', actorInstanceId: 'vm-1' };
    expect(rt({ name: 'vm_boot' }, { vm: 'vm-2' }, vm)?.allowed).toBe(false);
    expect(rt({ name: 'vm_boot' }, { vm: 'vm-1' }, vm)).toBeNull();
  });

  test('message_actor is non-mutating — the delegation channel, allowed off an actor', () => {
    // It is NOT in the mutating tier, so a non-actor main/direct ctx may call it
    // (that IS how the orchestrator delegates). An actor is refused it separately
    // (positive-scope rule) so it can't recursively message another actor.
    expect(rt({ name: 'message_actor' }, {}, {})).toBeNull();
    expect(rt({ name: 'message_actor' }, {}, { exposure: 'main' })).toBeNull();
  });

  test('exposureGate WIRES actorTierGate end to end', () => {
    // The full gate proves the exposureGate→actorTierGate wiring: message_actor
    // is allowed (the non-mutating delegation channel), while the mutating tier is
    // refused on the main agent — it must go through the instance's actor.
    expect(eg({ name: 'message_actor' }, {}, { exposure: 'main' }).allowed).toBe(true);
    const r = eg({ name: 'app_update' }, {}, { exposure: 'main' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('actor-only');
  });
});

describe('DESIGN-17 web actor — the fourth kind (DOM toolset + tab pin)', () => {
  // Production shape (buildToolContext, service-worker.js): the per-chat web
  // actor's actorInstanceId is the FIXED literal 'web' (its message_actor
  // address — stable across re-navigation), never a tab id. The actor's
  // actually-owned tab lives at ctx.activeTab.id, resolved separately. A
  // prior version of this fixture encoded the tab id INTO actorInstanceId
  // ('42') — which matched an earlier design but not the real ctx shape after
  // the singleton-actor-address change, and silently stopped exercising the
  // real bug: gates.js compared against actorInstanceId ('web' in
  // production), so every own-tab call was refused. Fixed in gates.js; this
  // fixture now matches what buildToolContext actually produces.
  const web = (over: object = {}) =>
    ({ exposure: EXPOSURE_ACTOR, actorType: 'web', actorInstanceId: 'web', activeTab: { id: 42, url: 'https://example.test/', origin: 'https://example.test' }, ...over });

  test('WEB_ACTOR_DOM_TOOLS is the DOM read/mutate set (no code-exec)', () => {
    // The web actor owns page reads + DOM mutators but NOT page_eval/page_exec —
    // it ingests untrusted page text, so it must not also wield code-exec.
    expect([...WEB_ACTOR_DOM_TOOLS].sort()).toEqual([
      'click', 'navigate', 'query_dom', 'read_page', 'read_pdf',
      'read_state', 'snapshot', 'type', 'view', 'watch_changes',
    ].sort());
    expect(WEB_ACTOR_DOM_TOOLS).not.toContain('page_eval');
    expect(WEB_ACTOR_DOM_TOOLS).not.toContain('page_exec');
    expect(WEB_ACTOR_DOM_TOOLS).not.toContain('page_keys');
  });

  test('a web actor may call its DOM tools (read + mutate) + the sessionless fetch_url', () => {
    for (const n of ['snapshot', 'read_page', 'click', 'type', 'navigate', 'query_dom', 'fetch_url']) {
      expect(rt({ name: n }, {}, web())).toBeNull();
    }
    expect(isAllowedForActorType('click', 'web')).toBe(true);
    // fetch_url is the web actor's NON-render mechanism — allowed for it, and the
    // ONLY ctx allowed it (it's hidden from main, refused for every other kind).
    expect(isAllowedForActorType('fetch_url', 'web')).toBe(true);
    expect(isAllowedForActorType('fetch_url', 'app')).toBe(false);
    // call_api stays OUT — the web actor's open-web read is fetch_url (sessionless),
    // not the credential-capable call_api.
    expect(isAllowedForActorType('call_api', 'web')).toBe(false);
    // == DOM toolset + fetch_url + read_doc + read_web_cache + the 4 DESIGN-19
    // site-client tools (run/read/write/capture) + login (Tier 0)
    // (drift: bump if the set grows).
    expect(actorAllowedTools('web').size).toBe(WEB_ACTOR_DOM_TOOLS.length + 8);
    // read_doc reads an office/ebook FILE by url (no tab) — same tier as
    // fetch_url, and refused for every other actor kind.
    expect(isAllowedForActorType('read_doc', 'web')).toBe(true);
    expect(isAllowedForActorType('read_doc', 'app')).toBe(false);
    // DESIGN-19: the site-client family is in the web actor's toolset.
    for (const n of ['site_client_run', 'site_client_read', 'site_client_write', 'site_capture']) {
      expect(isAllowedForActorType(n, 'web')).toBe(true);
      expect(isAllowedForActorType(n, 'app')).toBe(false);
    }
    // Tier 0 login — web-actor-only, refused for every other kind.
    expect(isAllowedForActorType('login', 'web')).toBe(true);
    expect(isAllowedForActorType('login', 'app')).toBe(false);
    // read_web_cache pages a spilled fetch_url body — same tier as the fetch.
    expect(isAllowedForActorType('read_web_cache', 'web')).toBe(true);
    expect(isAllowedForActorType('read_web_cache', 'app')).toBe(false);
  });

  test('DESIGN-18: an API backing keeps only its tab-free origin surface', () => {
    // fetch_url is in; the whole DOM toolset is OUT (it needs a tab the API actor
    // never has). The gate refuses a DOM tool for backing:'api' at the gate.
    expect(isAllowedForActor('fetch_url', 'web', 'api')).toBe(true);
    // ...and its paging read side — an API actor that overflows must page too.
    expect(isAllowedForActor('read_web_cache', 'web', 'api')).toBe(true);
    for (const n of ['click', 'type', 'navigate', 'snapshot', 'read_page', 'query_dom', 'read_pdf']) {
      expect(isAllowedForActor(n, 'web', 'api')).toBe(false);
    }
    // DESIGN-19: an API actor CAN run/read/write a site client for its fixed origin,
    // but NOT site_capture (no tab to observe).
    expect(isAllowedForActor('site_client_run', 'web', 'api')).toBe(true);
    expect(isAllowedForActor('site_client_write', 'web', 'api')).toBe(true);
    expect(isAllowedForActor('site_capture', 'web', 'api')).toBe(false);
    // fetch_url + read_web_cache + site_client_run/read/write (capture excluded).
    expect(actorAllowedToolsFor('web', 'api').size).toBe(5);
    // A tab backing (and an absent backing — the DESIGN-17 default) keeps the FULL set.
    expect(isAllowedForActor('click', 'web', 'tab')).toBe(true);
    expect(isAllowedForActor('click', 'web', undefined)).toBe(true);
    expect(actorAllowedToolsFor('web', 'tab').size).toBe(actorAllowedTools('web').size);
    // backing is web-only — it doesn't change an engine kind's set.
    expect(actorAllowedToolsFor('webvm', 'api').size).toBe(actorAllowedTools('webvm').size);
  });

  test('a present unknown web backing fails closed instead of inheriting tab tools', () => {
    expect(actorAllowedToolsFor('web', 'future' as any).size).toBe(0);
    expect(isAllowedForActor('site_client_read', 'web', 'future' as any)).toBe(false);
    expect(rt({ name: 'site_client_read' }, { origin: 'https://a.test' }, {
      exposure: EXPOSURE_ACTOR, actorType: 'web', backing: 'future' as any,
      canUseSiteClientOrigin: () => true,
    })?.allowed).toBe(false);
  });

  test('DESIGN-18: actorTierGate refuses DOM tools for an API backing, allows fetch_url', () => {
    const apiCtx = { exposure: EXPOSURE_ACTOR, actorType: 'web', backing: 'api', actorInstanceId: 'https://api.stripe.com' };
    // fetch_url passes; click is refused with an API-shaped reason.
    expect(rt({ name: 'fetch_url' }, { url: 'https://api.stripe.com/v1/charges' }, apiCtx)).toBeNull();
    const refused = rt({ name: 'click' }, { ref: 'a1' }, apiCtx);
    expect(refused?.allowed).toBe(false);
    expect(refused?.reason).toContain('API integration');
    // The same DOM tool is fine for a tab-backed web actor.
    expect(rt({ name: 'click' }, {}, { exposure: EXPOSURE_ACTOR, actorType: 'web', backing: 'tab', actorInstanceId: '42' })).toBeNull();
  });

  test('a web actor is positively scoped — foreign + powerful tools refused', () => {
    // notably page_eval/page_exec (code-exec) are NOT in the web toolset — the
    // exclusion that IS the web actor's boundary, enforced at the gate.
    for (const n of ['app_update', 'vm_boot', 'js_notebook', 'edit_file',
      'call_api', 'actor_create', 'page_eval', 'page_exec', 'message_actor']) {
      expect(rt({ name: n }, {}, web())?.allowed).toBe(false);
    }
  });

  test('the exposure×tier reconciliation: DOM mutators stay OFF the mutating tier', () => {
    // why: the web actor (exposure ACTOR) calls click/type/navigate via its
    // positive kind-scope; they're contained for MAIN by isHiddenFromMain (the
    // exposure axis), NOT by the mutating tier — so the tier has no opinion.
    for (const n of ['click', 'type', 'navigate']) {
      expect(isActorOnlyTool(n)).toBe(false);
      expect(rt({ name: n }, {}, {})).toBeNull();                   // actor (exposure unset)
      expect(rt({ name: n }, {}, { exposure: 'main' })).toBeNull(); // tier no-opinion (exposure hides it)
    }
  });

  test('the tab pin — explicit foreign tabId refused; owned / absent pass', () => {
    expect(actorWebTabTarget({ tabId: 99 })).toBe(99);
    expect(actorWebTabTarget({})).toBeUndefined();
    expect(rt({ name: 'click' }, { tabId: 99 }, web())?.allowed).toBe(false); // sibling tab
    expect(rt({ name: 'click' }, { tabId: 42 }, web())).toBeNull();           // own tab
    expect(rt({ name: 'click' }, {}, web())).toBeNull();                      // default → bound
  });

  // Regression: gates.js used to compare the explicit tabId against
  // ctx.actorInstanceId. In production that's the fixed literal 'web' (the
  // singleton actor's message_actor address), never a tab id, so EVERY
  // own-tab call was refused — confirmed live: a read_page on the actor's own
  // tab was refused with "pinned to tab web". The check must key off
  // ctx.activeTab.id (the actor's real owned tab), independent of whatever
  // string actorInstanceId happens to hold.
  test('the tab pin keys off ctx.activeTab.id, not actorInstanceId', () => {
    const ctx = { exposure: EXPOSURE_ACTOR, actorType: 'web', actorInstanceId: 'web', activeTab: { id: 1006003486, url: 'https://example.test/', origin: 'https://example.test' } };
    // Exactly the reported failure: same numeric tab as the owned one, named explicitly.
    expect(rt({ name: 'read_page' }, { tabId: 1006003486 }, ctx)).toBeNull();
    // The security guarantee is untouched: a DIFFERENT explicit tab is still refused.
    const refused = rt({ name: 'read_page' }, { tabId: 999 }, ctx);
    expect(refused?.allowed).toBe(false);
    expect(refused?.reason).toContain('1006003486');
    // No owned tab yet (0-tab state) — an explicit tabId still fails closed.
    const noTab = rt({ name: 'read_page' }, { tabId: 1 }, { exposure: EXPOSURE_ACTOR, actorType: 'web', actorInstanceId: 'web' });
    expect(noTab?.allowed).toBe(false);
  });

  test('actorDescriptors filters a web actor to its DOM toolset', () => {
    const all = [{ name: 'click' }, { name: 'app_update' }, { name: 'remember' }, { name: 'snapshot' }];
    expect(actorDescriptors(all, 'web').map((t) => t.name).sort()).toEqual(['click', 'snapshot']);
  });

  test('DESIGN-18: actorDescriptors advertises the API actor tab-free surface', () => {
    const all = [
      { name: 'click' }, { name: 'snapshot' }, { name: 'navigate' },
      { name: 'fetch_url' }, { name: 'read_web_cache' },
      { name: 'site_client_run' }, { name: 'site_client_read' }, { name: 'site_client_write' },
      { name: 'site_capture' }, { name: 'app_update' },
    ];
    // An API backing drops the DOM tools from the ADVERTISED list (matching the gate +
    // the actor's own "no DOM" lore — so the model isn't shown tools it'd only be refused).
    expect(actorDescriptors(all, 'web', 'api').map((t) => t.name)).toEqual([
      'fetch_url', 'read_web_cache', 'site_client_run', 'site_client_read', 'site_client_write',
    ]);
    // A tab backing (and an absent backing) keep the full web surface.
    expect(actorDescriptors(all, 'web', 'tab').map((t) => t.name).sort()).toEqual([
      'click', 'fetch_url', 'navigate', 'read_web_cache', 'site_capture',
      'site_client_read', 'site_client_run', 'site_client_write', 'snapshot',
    ]);
  });
});

describe('PR #119 web actor — the code-REPL action surface (A/B arm)', () => {
  const webCode = (over: object = {}) =>
    ({
      exposure: EXPOSURE_ACTOR, actorType: 'web', backing: 'tab', actorInstanceId: '42', actorSurface: 'code',
      canUseSiteClientOrigin: () => true,
      ...over,
    });

  test('the code surface is page_code plus the one operation not mapped by page.*', () => {
    expect([...actorAllowedToolsFor('web', 'tab', 'code')]).toEqual(['page_code', 'site_client_run']);
    expect(isAllowedForActor('page_code', 'web', 'tab', 'code')).toBe(true);
    expect(isAllowedForActor('site_client_run', 'web', 'tab', 'code')).toBe(true);
    // Everything else — action AND direct perception — is OFF the code surface:
    // perception is page.snapshot()/page.content() INSIDE page_code, not a direct
    // tool (a direct snapshot resolves the tab from the actor's turn ctx, which a
    // fresh actor lacks — the mid-turn-adopted tab never repins it, so it fails).
    for (const n of ['click', 'type', 'navigate', 'query_dom', 'page_keys', 'fetch_url', 'snapshot', 'read_page']) {
      expect(isAllowedForActor(n, 'web', 'tab', 'code')).toBe(false);
    }
  });

  test('the TOOLS surface (and an absent surface) is unchanged — page_code is NOT in it', () => {
    // Default: no surface arg means the historical tool-call surface; page_code
    // must NOT leak into it, and the discrete DOM tools must stay.
    expect(isAllowedForActor('page_code', 'web', 'tab', 'tools')).toBe(false);
    expect(isAllowedForActor('page_code', 'web', 'tab', undefined)).toBe(false);
    expect(isAllowedForActor('navigate', 'web', 'tab', 'tools')).toBe(true);
    expect(isAllowedForActor('navigate', 'web', 'tab', undefined)).toBe(true);
    // An API backing ignores the surface entirely — still fetch/site-client only.
    expect(isAllowedForActor('page_code', 'web', 'api', 'code')).toBe(false);
    expect(actorAllowedToolsFor('web', 'api', 'code').size).toBe(5);   // fetch_url + read_web_cache + site_client run/read/write (surface ignored for api)
  });

  test('page_code is contained: hidden from main, in NO other actor kind\'s allow-set', () => {
    // THE PROOF, post-#159 shape: page_code ACTS on the owned tab, so it is
    // contained like the DOM tools (click/type/navigate) — hidden from the main
    // agent via MAIN_AGENT_HIDDEN_TOOLS (a prompt-injected main turn fails
    // closed at exposureGate), and present ONLY in the code-surface web actor's
    // positive set. (The spawn_subagent path is walled separately: the
    // capability strip drops jsOffscreenClient for any non-code-surface ctx,
    // and the SW page/call route refuses a non-web-actor owner — the slice-3
    // security tests.)
    expect(isHiddenFromMain('page_code')).toBe(true);
    const r = eg({ name: 'page_code' }, {}, { exposure: 'main' });
    expect(r?.allowed).toBe(false);
    expect(r?.reason).toContain('actor-only');
    // No other actor kind may call it — engine actors, the dweb actor, the
    // API-backed web actor, and the tools-surface web actor all refuse.
    for (const kind of ['webvm', 'notebook', 'pod', 'app', 'dweb']) {
      expect(isAllowedForActor('page_code', kind, undefined, undefined)).toBe(false);
    }
    expect(isAllowedForActor('page_code', 'web', 'api', 'code')).toBe(false);
    expect(isAllowedForActor('page_code', 'web', 'tab', 'tools')).toBe(false);
  });

  test('the gate: a code-surface web actor may call page_code and discrete site_client_run', () => {
    expect(rt({ name: 'page_code' }, { code: 'return 1' }, webCode())).toBeNull();      // allowed
    expect(rt({ name: 'site_client_run' }, { origin: 'https://example.com', code: 'return 1' }, webCode())).toBeNull();
    // Everything else refuses — the model acts AND perceives via page.* in code.
    for (const n of ['click', 'type', 'navigate', 'query_dom', 'fetch_url', 'snapshot', 'read_page']) {
      expect(rt({ name: n }, {}, webCode())?.allowed).toBe(false);
    }
  });

  test('the gate: a TOOLS-surface web actor is refused page_code (surface is enforced, not advisory)', () => {
    const toolsCtx = { exposure: EXPOSURE_ACTOR, actorType: 'web', backing: 'tab', actorInstanceId: '42', actorSurface: 'tools' };
    expect(rt({ name: 'page_code' }, {}, toolsCtx)?.allowed).toBe(false);
    // ...and the discrete DOM tools it DOES own still pass.
    expect(rt({ name: 'navigate' }, {}, toolsCtx)).toBeNull();
    // An absent surface behaves like 'tools' — page_code refused, navigate allowed.
    const noSurface = { exposure: EXPOSURE_ACTOR, actorType: 'web', backing: 'tab', actorInstanceId: '42' };
    expect(rt({ name: 'page_code' }, {}, noSurface)?.allowed).toBe(false);
    expect(rt({ name: 'navigate' }, {}, noSurface)).toBeNull();
  });

  test('actorDescriptors is surface-aware — a code actor sees code plus unmapped operations', () => {
    const all = [{ name: 'click' }, { name: 'navigate' }, { name: 'snapshot' }, { name: 'read_page' }, { name: 'page_code' }, { name: 'fetch_url' }, { name: 'site_client_run' }];
    expect(actorDescriptors(all, 'web', 'tab', 'code').map((t) => t.name)).toEqual(['page_code', 'site_client_run']);
    // The tools surface keeps every supplied direct web operation and never
    // shows page_code.
    expect(actorDescriptors(all, 'web', 'tab', 'tools').map((t) => t.name).sort())
      .toEqual(['click', 'fetch_url', 'navigate', 'read_page', 'site_client_run', 'snapshot']);
  });
});
