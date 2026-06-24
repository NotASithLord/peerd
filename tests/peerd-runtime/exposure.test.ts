import { describe, test, expect } from 'bun:test';
import {
  mainAgentDescriptors, isHiddenFromMain,
  filterByInstanceState, isInstanceGatedOut, instanceGateKind,
  filterByDwebEnabled, isDwebTool,
  filterByDwebActive, isDwebSecondaryTool,
  isResidentMutatingTool, residentAllowedTools, isAllowedForResidentKind,
  residentTargetId, residentTargetIdField, residentDescriptors, filterResidentSurface,
  EXPOSURE_RESIDENT,
} from '../../extension/peerd-runtime/tools/exposure.js';
import { exposureGate as exposureGateRaw, residentTierGate } from '../../extension/peerd-runtime/tools/gates.js';

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
    for (const name of ['snapshot', 'read_page', 'read_state', 'watch_changes', 'query_dom', 'page_eval', 'page_exec', 'page_keys', 'navigate', 'type', 'click', 'submit_form', 'read_pdf']) {
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
    expect(eg({ name: 'do' }, {}, { exposure: 'main' }).allowed).toBe(true);
    expect(eg({ name: 'list_tabs' }, {}, { exposure: 'main' }).allowed).toBe(true);
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
    // With RESIDENT_TAB_AGENTS on, the MUTATING ops are resident-only even with an
    // instance present; the READ ops (which stay on the main agent) are what
    // instance-gating still admits once their kind exists.
    expect(eg({ name: 'app_read_file' }, {}, { exposure: 'main', instanceState: { app: true } }).allowed).toBe(true);
    expect(eg({ name: 'js_read_file' }, {}, { exposure: 'main', instanceState: { notebook: true } }).allowed).toBe(true);
  });

  test('fails closed when instanceState is absent on the main turn', () => {
    expect(eg({ name: 'js_read_file' }, {}, { exposure: 'main' }).allowed).toBe(false);
  });

  test('never instance-gates a non-main context (runner / subagent hold full tools)', () => {
    // Instance gating is main-only; a non-main ctx is never instance-gated. Uses
    // READ ops (non-tiered) so the DESIGN-17 resident tier doesn't mask the point.
    expect(eg({ name: 'app_read_file' }, {}, {}).allowed).toBe(true);
    expect(eg({ name: 'js_read_file' }, {}, { exposure: null }).allowed).toBe(true);
  });

  test('always-on ops (create/entry) pass on the main agent even with no instances', () => {
    const none = { webvm: false, notebook: false, app: false };
    // The create/list/open entry tools stay on the main agent (it bootstraps an
    // instance, then delegates). The RUN tools (vm_boot/js_notebook) are now
    // resident-only — proven in the resident-tier gate tests below.
    for (const n of ['app_create', 'vm_create', 'vm_list', 'js_create', 'app_open']) {
      expect(eg({ name: n }, {}, { exposure: 'main', instanceState: none }).allowed).toBe(true);
    }
  });
});

// ── DESIGN-17: resident tab agents — the capability tier ────────────────────
// The gate's resident logic is a pure, flag-INJECTED function (residentTierGate)
// so these prove the structure with flagOn:true regardless of the source flag's
// current value. null = "no resident-tier opinion" (the gate continues).
const rt = (tool: { name: string }, args: unknown, ctx: object, flagOn: boolean) =>
  residentTierGate(tool as unknown as ToolT, args, ctx as GateCtxT, flagOn);

describe('DESIGN-17 resident tier — the tool sets', () => {
  test('the MUTATING tier is what leaves the main agent (reads stay global)', () => {
    for (const n of ['vm_boot', 'vm_write_file', 'vm_import', 'vm_delete',
      'js_notebook', 'js_write_file', 'js_delete',
      'app_update', 'app_write_file', 'app_delete_file', 'app_delete', 'edit_file']) {
      expect(isResidentMutatingTool(n)).toBe(true);
    }
    // Reads + entry/catalog tools + js_run stay GLOBAL — NOT tiered (spec).
    for (const n of ['js_read_file', 'app_read_file', 'app_list_files',
      'vm_create', 'vm_list', 'js_create', 'js_list', 'js_run',
      'app_create', 'app_list', 'app_open', 'app_search', 'message_resident']) {
      expect(isResidentMutatingTool(n)).toBe(false);
    }
  });

  test('residentAllowedTools scopes each kind to its own surface (+ reads + edit_file)', () => {
    expect([...residentAllowedTools('webvm')].sort()).toEqual(
      ['vm_boot', 'vm_delete', 'vm_import', 'vm_write_file'].sort());
    expect(isAllowedForResidentKind('app_update', 'app')).toBe(true);
    expect(isAllowedForResidentKind('app_read_file', 'app')).toBe(true); // reads allowed for its own
    expect(isAllowedForResidentKind('edit_file', 'app')).toBe(true);
    expect(isAllowedForResidentKind('edit_file', 'notebook')).toBe(true);
    expect(isAllowedForResidentKind('edit_file', 'webvm')).toBe(false);   // no vm files via edit_file
    expect(isAllowedForResidentKind('vm_boot', 'app')).toBe(false);       // foreign kind
    expect(isAllowedForResidentKind('call_api', 'app')).toBe(false);      // non-env tool
    expect(isAllowedForResidentKind('vm_boot', undefined as unknown as string)).toBe(false);
  });

  test('residentTargetId reads the correct per-tool arg (the pin source)', () => {
    expect(residentTargetIdField('app_delete')).toBe('appId');
    expect(residentTargetIdField('vm_boot')).toBe('vm');
    expect(residentTargetIdField('vm_delete')).toBe('vmId');
    expect(residentTargetIdField('js_delete')).toBe('notebookId');
    expect(residentTargetIdField('js_notebook')).toBe('notebook');
    expect(residentTargetIdField('edit_file')).toBe('targetId');
    expect(residentTargetIdField('vm_write_file')).toBe(null);  // session-default only
    expect(residentTargetId('app_delete', { appId: 'app-9' })).toBe('app-9');
    expect(residentTargetId('app_delete', {})).toBeUndefined();
    expect(residentTargetId('vm_write_file', { path: '/x' })).toBeUndefined();
  });

  test('residentDescriptors filters to the kind; filterResidentSurface respects the flag', () => {
    const all = [{ name: 'app_update' }, { name: 'vm_boot' }, { name: 'do' }, { name: 'message_resident' }];
    expect(residentDescriptors(all, 'app').map((t) => t.name)).toEqual(['app_update']);
    // flag ON: the mutating tier leaves main, message_resident stays.
    expect(filterResidentSurface(all, true).map((t) => t.name)).toEqual(['do', 'message_resident']);
    // flag OFF: status quo — mutating tier stays, message_resident hidden.
    expect(filterResidentSurface(all, false).map((t) => t.name)).toEqual(['app_update', 'vm_boot', 'do']);
  });
});

describe('DESIGN-17 resident tier — the gate (the wall, flagOn:true)', () => {
  test('a NON-resident (subagent/main/direct) is refused the mutating tier', () => {
    // THE PROOF: a `spawn_subagent({tools:['app_delete']})` child has exposure
    // unset → refused at the gate even though the tool name is in its subset.
    for (const ctx of [{}, { exposure: 'main' }, { exposure: null }, { exposure: 'subagent' }]) {
      const r = rt({ name: 'app_delete' }, {}, ctx, true);
      expect(r?.allowed).toBe(false);
      expect(r?.reason).toContain('resident-only');
    }
    expect(rt({ name: 'edit_file' }, {}, { exposure: 'main' }, true)?.allowed).toBe(false);
  });

  test('reads are NOT tiered — a non-resident may still read globally', () => {
    expect(rt({ name: 'app_read_file' }, {}, {}, true)).toBeNull();
    expect(rt({ name: 'app_list_files' }, {}, { exposure: 'main' }, true)).toBeNull();
    expect(rt({ name: 'js_read_file' }, {}, {}, true)).toBeNull();
  });

  test('a resident may call its own kind; foreign/non-env tools fail closed', () => {
    const appCtx = { exposure: EXPOSURE_RESIDENT, residentKind: 'app', residentInstanceId: 'app-1' };
    expect(rt({ name: 'app_update' }, {}, appCtx, true)).toBeNull();          // allowed
    expect(rt({ name: 'vm_boot' }, {}, appCtx, true)?.allowed).toBe(false);   // foreign kind
    expect(rt({ name: 'call_api' }, {}, appCtx, true)?.allowed).toBe(false);  // non-env
    expect(rt({ name: 'spawn_subagent' }, {}, appCtx, true)?.allowed).toBe(false);
  });

  test('the per-instance pin refuses a sibling id, allows the bound id / no id', () => {
    // The resident dispatch wrapper (pinResidentCall) normalizes any id/name arg
    // to the bound INSTANCE ID before the gate runs, so the gate only ever sees
    // ids — it refuses any explicit id that isn't the bound one.
    const ctx = { exposure: EXPOSURE_RESIDENT, residentKind: 'app', residentInstanceId: 'app-1' };
    expect(rt({ name: 'app_delete' }, { appId: 'app-2' }, ctx, true)?.allowed).toBe(false); // sibling
    expect(rt({ name: 'app_delete' }, { appId: 'app-1' }, ctx, true)).toBeNull();           // own id
    expect(rt({ name: 'app_delete' }, {}, ctx, true)).toBeNull();                           // wrapper injects
    // a webvm resident pinned by name-or-id arg
    const vm = { exposure: EXPOSURE_RESIDENT, residentKind: 'webvm', residentInstanceId: 'vm-1' };
    expect(rt({ name: 'vm_boot' }, { vm: 'vm-2' }, vm, true)?.allowed).toBe(false);
    expect(rt({ name: 'vm_boot' }, { vm: 'vm-1' }, vm, true)).toBeNull();
  });

  test('message_resident: refused by name with flag OFF, allowed (non-mutating) with flag ON', () => {
    expect(rt({ name: 'message_resident' }, {}, {}, false)?.allowed).toBe(false);
    expect(rt({ name: 'message_resident' }, {}, {}, true)).toBeNull();
    // flag OFF: the mutating tier is NOT refused (instance tools stay on main).
    expect(rt({ name: 'app_delete' }, {}, {}, false)).toBeNull();
    expect(rt({ name: 'vm_boot' }, {}, { exposure: 'main' }, false)).toBeNull();
  });

  test('exposureGate WIRES residentTierGate with the real flag (flag ON for this branch)', () => {
    // The real gate reads the source flag (ON for this branch), so this proves the
    // exposureGate→residentTierGate wiring end to end: message_resident is allowed
    // (the non-mutating delegation channel), while the mutating tier is refused on
    // the main agent — it must go through the instance's resident. The flag-OFF
    // structure stays proven by the injected rt(..., false) tests above.
    expect(eg({ name: 'message_resident' }, {}, { exposure: 'main' }).allowed).toBe(true);
    const r = eg({ name: 'app_update' }, {}, { exposure: 'main', instanceState: { app: true } });
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain('resident-only');
  });
});
