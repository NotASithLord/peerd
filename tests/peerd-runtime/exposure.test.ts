import { describe, test, expect } from 'bun:test';
import {
  mainAgentDescriptors, isHiddenFromMain,
  filterByInstanceState, isInstanceGatedOut, instanceGateKind,
  filterByDwebEnabled, isDwebTool,
  filterByDwebActive, isDwebSecondaryTool,
} from '../../extension/peerd-runtime/tools/exposure.js';
import { exposureGate as exposureGateRaw } from '../../extension/peerd-runtime/tools/gates.js';

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
    expect(eg({ name: 'app_write_file' }, {}, { exposure: 'main', instanceState: { app: true } }).allowed).toBe(true);
    expect(eg({ name: 'vm_write_file' }, {}, { exposure: 'main', instanceState: { webvm: true } }).allowed).toBe(true);
  });

  test('fails closed when instanceState is absent on the main turn', () => {
    expect(eg({ name: 'js_read_file' }, {}, { exposure: 'main' }).allowed).toBe(false);
  });

  test('never instance-gates a non-main context (runner / subagent hold full tools)', () => {
    expect(eg({ name: 'app_write_file' }, {}, {}).allowed).toBe(true);
    expect(eg({ name: 'vm_write_file' }, {}, { exposure: null }).allowed).toBe(true);
  });

  test('always-on ops (auto-create + entry) pass even with no instances', () => {
    const none = { webvm: false, notebook: false, app: false };
    for (const n of ['vm_boot', 'js_notebook', 'app_create', 'vm_create', 'app_open']) {
      expect(eg({ name: n }, {}, { exposure: 'main', instanceState: none }).allowed).toBe(true);
    }
  });
});
