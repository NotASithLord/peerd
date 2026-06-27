import { describe, test, expect } from 'bun:test';
import {
  mainAgentDescriptors, isHiddenFromMain,
  filterByInstanceState, isInstanceGatedOut, instanceGateKind,
  filterByDwebEnabled, isDwebTool,
  filterByDwebActive, isDwebSecondaryTool,
  isActorMutatingTool, actorAllowedTools, isAllowedForActorType,
  actorAllowedToolsFor, isAllowedForActor,
  actorTargetId, actorTargetIdField, actorDescriptors, filterActorSurface,
  EXPOSURE_ACTOR,
  WEB_ACTOR_DOM_TOOLS, actorWebTabTarget,
} from '../../extension/peerd-runtime/tools/exposure.js';
import { exposureGate as exposureGateRaw, actorTierGate } from '../../extension/peerd-runtime/tools/gates.js';
import { DO_TOOLSET } from '../../extension/peerd-runtime/runner/index.js';

type ToolT = import('../../extension/shared/tool-types.js').Tool;
type GateCtxT = import('../../extension/peerd-runtime/tools/gates.js').GateContext;

// exposureGate under test, with the deliberately-minimal {name}/partial-ctx
// fixtures cast to the production Tool/GateContext the gate family declares.
// These pure tests read only a field or two; the casts keep the fixtures terse
// without weakening the real gate signature (which the dispatcher relies on).
const eg = (tool: { name: string }, args: unknown, ctx: object) =>
  exposureGateRaw(tool as unknown as ToolT, args, ctx as GateCtxT);

describe('dweb tool exposure (off the store build)', () => {
  const tools = [{ name: 'app_create' }, { name: 'dweb_share', dweb: true }, { name: 'do' }, { name: 'dweb_discover', dweb: true }];
  test('isDwebTool reads the dweb flag', () => {
    expect(isDwebTool({ name: 'dweb_share', dweb: true })).toBe(true);
    expect(isDwebTool({ name: 'app_create' })).toBe(false);
  });
  test('hides dweb tools when the dweb is off; keeps the rest', () => {
    expect(filterByDwebEnabled(tools, false).map((t) => t.name)).toEqual(['app_create', 'do']);
  });
  test('keeps dweb tools when the dweb is on', () => {
    expect(filterByDwebEnabled(tools, true).map((t) => t.name)).toEqual(['app_create', 'dweb_share', 'do', 'dweb_discover']);
  });
});

describe('dweb tool exposure (progressive disclosure of the SECONDARY surface)', () => {
  const dwebOn = [
    { name: 'dweb_discover' }, { name: 'dweb_share' }, { name: 'dweb_install' },
    { name: 'dweb_peers' }, { name: 'dweb_block' }, { name: 'dweb_discovery' }, { name: 'dweb_guide' },
    { name: 'app_create' },
  ];
  test('isDwebSecondaryTool flags exactly the deferred set (dweb_guide is ENTRY, not deferred)', () => {
    for (const n of ['dweb_peers', 'dweb_block', 'dweb_discovery']) expect(isDwebSecondaryTool(n)).toBe(true);
    // dweb_guide is an ENTRY tool — the prompt tells the agent to call it FIRST,
    // before any other dweb tool, so it must NOT be gated behind engagement.
    for (const n of ['dweb_discover', 'dweb_share', 'dweb_install', 'dweb_guide', 'app_create']) expect(isDwebSecondaryTool(n)).toBe(false);
  });
  test('hides the secondary tools until the session has engaged the dweb; dweb_guide stays visible', () => {
    expect(filterByDwebActive(dwebOn, false).map((t) => t.name))
      .toEqual(['dweb_discover', 'dweb_share', 'dweb_install', 'dweb_guide', 'app_create']); // entry tools (incl. guide) survive
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

  test('keeps do/get/check + tab management + non-browser tools', () => {
    for (const name of ['do', 'get', 'check', 'list_tabs', 'open_tab', 'spawn_subagent', 'vm_boot', 'remember']) {
      expect(isHiddenFromMain(name)).toBe(false);
    }
  });

  test('mainAgentDescriptors removes exactly the hidden set, order preserved', () => {
    const all = [{ name: 'do' }, { name: 'snapshot' }, { name: 'click' }, { name: 'get' }, { name: 'list_tabs' }, { name: 'page_exec' }, { name: 'check' }];
    expect(mainAgentDescriptors(all).map((t) => t.name)).toEqual(['do', 'get', 'list_tabs', 'check']);
  });
});

describe('exposureGate — enforcement at dispatch (not just the descriptor list)', () => {
  test('refuses a hidden tool when the context is the MAIN agent', () => {
    const r = eg({ name: 'page_exec' }, {}, { exposure: 'main' });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('runner-only');
  });

  test('allows a hidden tool for the runner / subagent (exposure unset)', () => {
    expect(eg({ name: 'page_exec' }, {}, {}).allowed).toBe(true);
    expect(eg({ name: 'snapshot' }, {}, { exposure: null }).allowed).toBe(true);
  });

  test('always allows a non-hidden tool, even on the main turn', () => {
    expect(eg({ name: 'open_tab' }, {}, { exposure: 'main' }).allowed).toBe(true);
    expect(eg({ name: 'list_tabs' }, {}, { exposure: 'main' }).allowed).toBe(true);
  });

  // DESIGN-17 web-actor cutover: the do/get/check page runner leaves the MAIN
  // agent (it messages a tab's actor instead). Subagents (exposure unset) keep
  // them — they can't message actors.
  test('refuses do/get/check on the MAIN turn (folded into the web actor)', () => {
    for (const name of ['do', 'get', 'check']) {
      const r = eg({ name }, {}, { exposure: 'main' });
      expect(r.allowed).toBe(false);
      expect(r.reason).toContain('web actor');
    }
  });
  test('a subagent (exposure unset) still keeps do/get/check', () => {
    expect(eg({ name: 'do' }, {}, { exposure: null }).allowed).toBe(true);
    expect(eg({ name: 'get' }, {}, {}).allowed).toBe(true);
  });
});

describe('progressive disclosure — instance-gated engine ops', () => {
  const NONE = { webvm: false, notebook: false, app: false };
  const ALL = { webvm: true, notebook: true, app: true };

  test('instanceGateKind maps ops to their kind, null for everything else', () => {
    expect(instanceGateKind('vm_write_file')).toBe('webvm');
    expect(instanceGateKind('js_read_file')).toBe('notebook');
    expect(instanceGateKind('app_update')).toBe('app');
    // entry + auto-creating + unrelated tools are NOT gated
    for (const n of ['vm_create', 'vm_boot', 'js_create', 'js_notebook', 'app_create', 'app_open', 'do', 'remember']) {
      expect(instanceGateKind(n)).toBeNull();
    }
  });

  test('ops are hidden with no instance, shown once the matching kind exists', () => {
    expect(isInstanceGatedOut('vm_write_file', NONE)).toBe(true);
    expect(isInstanceGatedOut('vm_write_file', { webvm: true })).toBe(false);
    expect(isInstanceGatedOut('app_update', NONE)).toBe(true);
    expect(isInstanceGatedOut('app_update', { app: true })).toBe(false);
    // only the MATCHING kind reveals it
    expect(isInstanceGatedOut('js_delete', { webvm: true, app: true })).toBe(true);
    expect(isInstanceGatedOut('js_delete', { notebook: true })).toBe(false);
  });

  test('null/absent instanceState fails CLOSED (gated ops stay hidden)', () => {
    expect(isInstanceGatedOut('vm_import', null)).toBe(true);
    expect(isInstanceGatedOut('app_write_file', undefined)).toBe(true);
  });

  test('non-gated tools (entry + auto-create + unrelated) are never gated', () => {
    for (const n of ['vm_boot', 'js_notebook', 'app_create', 'vm_create', 'app_open', 'do', 'get']) {
      expect(isInstanceGatedOut(n, NONE)).toBe(false);
      expect(isInstanceGatedOut(n, null)).toBe(false);
    }
  });

  test('filterByInstanceState reveals a kind only when its instance exists', () => {
    const all = [
      { name: 'vm_create' }, { name: 'vm_boot' }, { name: 'vm_write_file' },
      { name: 'app_create' }, { name: 'app_update' }, { name: 'do' },
    ];
    expect(filterByInstanceState(all, NONE).map((t) => t.name))
      .toEqual(['vm_create', 'vm_boot', 'app_create', 'do']);
    expect(filterByInstanceState(all, { webvm: true }).map((t) => t.name))
      .toEqual(['vm_create', 'vm_boot', 'vm_write_file', 'app_create', 'do']);
    expect(filterByInstanceState(all, ALL).map((t) => t.name)).toEqual(all.map((t) => t.name));
  });
});

describe('exposureGate — instance gating at dispatch (fails closed)', () => {
  test('refuses a gated op on the main turn when the kind has no instance, with a create hint', () => {
    const r = eg({ name: 'app_write_file' }, {}, { exposure: 'main', instanceState: { app: false } });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('app_create');
  });

  test('allows the gated op once the instance exists', () => {
    // The MUTATING ops are actor-only even with an instance present; the READ
    // ops (which stay on the main agent) are what instance-gating still admits
    // once their kind exists.
    expect(eg({ name: 'app_read_file' }, {}, { exposure: 'main', instanceState: { app: true } }).allowed).toBe(true);
    expect(eg({ name: 'js_read_file' }, {}, { exposure: 'main', instanceState: { notebook: true } }).allowed).toBe(true);
  });

  test('fails closed when instanceState is absent on the main turn', () => {
    expect(eg({ name: 'js_read_file' }, {}, { exposure: 'main' }).allowed).toBe(false);
  });

  test('never instance-gates a non-main context (runner / subagent hold full tools)', () => {
    // Instance gating is main-only; a non-main ctx is never instance-gated. Uses
    // READ ops (non-tiered) so the DESIGN-17 actor tier doesn't mask the point.
    expect(eg({ name: 'app_read_file' }, {}, {}).allowed).toBe(true);
    expect(eg({ name: 'js_read_file' }, {}, { exposure: null }).allowed).toBe(true);
  });

  test('always-on ops (create/entry) pass on the main agent even with no instances', () => {
    const none = { webvm: false, notebook: false, app: false };
    // The create/list/open entry tools stay on the main agent (it bootstraps an
    // instance, then delegates). The RUN tools (vm_boot/js_notebook) are now
    // actor-only — proven in the actor-tier gate tests below.
    for (const n of ['app_create', 'vm_create', 'vm_list', 'js_create', 'app_open']) {
      expect(eg({ name: n }, {}, { exposure: 'main', instanceState: none }).allowed).toBe(true);
    }
  });
});

// ── DESIGN-17: actor tab agents — the capability tier ────────────────────
// The gate's actor logic is a pure function (actorTierGate). The actor
// model is unconditional (the source flags were removed), so the tier is always
// enforced. null = "no actor-tier opinion" (the gate continues).
const rt = (tool: { name: string }, args: unknown, ctx: object) =>
  actorTierGate(tool as unknown as ToolT, args, ctx as GateCtxT);

describe('DESIGN-17 actor tier — the tool sets', () => {
  test('the MUTATING tier is what leaves the main agent (reads stay global)', () => {
    for (const n of ['vm_boot', 'vm_write_file', 'vm_import', 'vm_delete',
      'js_notebook', 'js_write_file', 'js_delete',
      'app_update', 'app_write_file', 'app_delete_file', 'app_delete', 'edit_file']) {
      expect(isActorMutatingTool(n)).toBe(true);
    }
    // Reads + entry/catalog tools + js_run stay GLOBAL — NOT tiered (spec).
    for (const n of ['js_read_file', 'app_read_file', 'app_list_files',
      'vm_create', 'vm_list', 'js_create', 'js_list', 'js_run',
      'app_create', 'app_list', 'app_open', 'app_search', 'message_actor']) {
      expect(isActorMutatingTool(n)).toBe(false);
    }
  });

  test('actorAllowedTools scopes each kind to its own surface (+ reads + edit_file)', () => {
    expect([...actorAllowedTools('webvm')].sort()).toEqual(
      ['vm_boot', 'vm_delete', 'vm_import', 'vm_write_file'].sort());
    expect(isAllowedForActorType('app_update', 'app')).toBe(true);
    expect(isAllowedForActorType('app_read_file', 'app')).toBe(true); // reads allowed for its own
    expect(isAllowedForActorType('edit_file', 'app')).toBe(true);
    expect(isAllowedForActorType('edit_file', 'notebook')).toBe(true);
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
    expect(actorTargetIdField('edit_file')).toBe('targetId');
    expect(actorTargetIdField('vm_write_file')).toBe(null);  // session-default only
    expect(actorTargetId('app_delete', { appId: 'app-9' })).toBe('app-9');
    expect(actorTargetId('app_delete', {})).toBeUndefined();
    expect(actorTargetId('vm_write_file', { path: '/x' })).toBeUndefined();
  });

  test('actorDescriptors filters to the kind; filterActorSurface strips the main surface', () => {
    const all = [{ name: 'app_update' }, { name: 'vm_boot' }, { name: 'do' }, { name: 'get' }, { name: 'message_actor' }, { name: 'open_tab' }];
    expect(actorDescriptors(all, 'app').map((t) => t.name)).toEqual(['app_update']);
    // The mutating tier AND do/get/check both leave the main agent (folded into the
    // tab's actor); message_actor + open_tab stay.
    expect(filterActorSurface(all).map((t) => t.name)).toEqual(['message_actor', 'open_tab']);
  });
});

describe('DESIGN-17 actor tier — the gate (the wall)', () => {
  test('a NON-actor (subagent/main/direct) is refused the mutating tier', () => {
    // THE PROOF: a `spawn_subagent({tools:['app_delete']})` child has exposure
    // unset → refused at the gate even though the tool name is in its subset.
    for (const ctx of [{}, { exposure: 'main' }, { exposure: null }, { exposure: 'subagent' }]) {
      const r = rt({ name: 'app_delete' }, {}, ctx);
      expect(r?.allowed).toBe(false);
      expect(r?.reason).toContain('actor-only');
    }
    expect(rt({ name: 'edit_file' }, {}, { exposure: 'main' })?.allowed).toBe(false);
  });

  test('reads are NOT tiered — a non-actor may still read globally', () => {
    expect(rt({ name: 'app_read_file' }, {}, {})).toBeNull();
    expect(rt({ name: 'app_list_files' }, {}, { exposure: 'main' })).toBeNull();
    expect(rt({ name: 'js_read_file' }, {}, {})).toBeNull();
  });

  test('an actor may call its own kind; foreign/non-env tools fail closed', () => {
    const appCtx = { exposure: EXPOSURE_ACTOR, actorType: 'app', actorInstanceId: 'app-1' };
    expect(rt({ name: 'app_update' }, {}, appCtx)).toBeNull();          // allowed
    expect(rt({ name: 'vm_boot' }, {}, appCtx)?.allowed).toBe(false);   // foreign kind
    expect(rt({ name: 'call_api' }, {}, appCtx)?.allowed).toBe(false);  // non-env
    expect(rt({ name: 'spawn_subagent' }, {}, appCtx)?.allowed).toBe(false);
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
    const r = eg({ name: 'app_update' }, {}, { exposure: 'main', instanceState: { app: true } });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('actor-only');
  });
});

describe('DESIGN-17 web actor — the fourth kind (DOM toolset + tab pin)', () => {
  const web = (over: object = {}) =>
    ({ exposure: EXPOSURE_ACTOR, actorType: 'web', actorInstanceId: '42', ...over });

  test('the web toolset mirrors the runner DO_TOOLSET (drift guard)', () => {
    expect([...WEB_ACTOR_DOM_TOOLS].sort()).toEqual([...DO_TOOLSET].sort());
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
    // == DOM toolset + the one fetch_url addition (drift: bump if the set grows).
    expect(actorAllowedTools('web').size).toBe(WEB_ACTOR_DOM_TOOLS.length + 1);
  });

  test('DESIGN-18: an API backing (web actor, no tab) is fetch_url-ONLY', () => {
    // fetch_url is in; the whole DOM toolset is OUT (it needs a tab the API actor
    // never has). The gate refuses a DOM tool for backing:'api' at the gate.
    expect(isAllowedForActor('fetch_url', 'web', 'api')).toBe(true);
    for (const n of ['click', 'type', 'navigate', 'snapshot', 'read_page', 'query_dom', 'read_pdf']) {
      expect(isAllowedForActor(n, 'web', 'api')).toBe(false);
    }
    expect(actorAllowedToolsFor('web', 'api').size).toBe(1);   // fetch_url only
    // A tab backing (and an absent backing — the DESIGN-17 default) keeps the FULL set.
    expect(isAllowedForActor('click', 'web', 'tab')).toBe(true);
    expect(isAllowedForActor('click', 'web', undefined)).toBe(true);
    expect(actorAllowedToolsFor('web', 'tab').size).toBe(actorAllowedTools('web').size);
    // backing is web-only — it doesn't change an engine kind's set.
    expect(actorAllowedToolsFor('webvm', 'api').size).toBe(actorAllowedTools('webvm').size);
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
    // same exclusion that IS the runner's boundary, now enforced at the gate.
    for (const n of ['app_update', 'vm_boot', 'js_notebook', 'edit_file',
      'call_api', 'spawn_subagent', 'page_eval', 'page_exec', 'message_actor']) {
      expect(rt({ name: n }, {}, web())?.allowed).toBe(false);
    }
  });

  test('the exposure×tier reconciliation: DOM mutators stay OFF the mutating tier', () => {
    // why: the runner (exposure UNSET) must keep using click/type/navigate. They're
    // contained for MAIN by isHiddenFromMain (the exposure axis), NOT by the
    // mutating tier — so the tier has no opinion and the runner is never refused.
    for (const n of ['click', 'type', 'navigate']) {
      expect(isActorMutatingTool(n)).toBe(false);
      expect(rt({ name: n }, {}, {})).toBeNull();                   // runner (exposure unset)
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

  test('actorDescriptors filters a web actor to its DOM toolset', () => {
    const all = [{ name: 'click' }, { name: 'app_update' }, { name: 'do' }, { name: 'snapshot' }];
    expect(actorDescriptors(all, 'web').map((t) => t.name).sort()).toEqual(['click', 'snapshot']);
  });
});
