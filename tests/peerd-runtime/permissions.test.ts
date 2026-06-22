// Plan/Act + confirm-actions permission policy (Feature 03; tiers
// collapsed to one boolean 2026-06-12).
//
// The policy is a PURE function (peerd-runtime/permissions/policy.js) with
// no IO and no `/peerd-*` absolute imports, so it's directly importable
// under Bun — unlike the dispatcher, which transitively imports
// /peerd-egress/index.js (a browser-resolved path Bun can't follow). We
// therefore test the policy at its real boundary, the same `decideAction`
// the persona gate and the dispatcher call, against tool descriptors that
// mirror the actual built-in tools' { name, sideEffect, primitive }.
//
// A tiny `simulateDispatch` replays the dispatcher's exact decision flow
// (persona-gate block in Plan, then the async confirm step in Act) so the
// required scenarios are asserted end-to-end at the policy layer:
//   - Plan blocks a write/tab/fetch tool
//   - Act + confirmActions ON confirms each non-read
//   - Act + confirmActions OFF allows all without confirming
// Plus the legacy-tier migration reader (confirmActionsFromRecord).

import { describe, test, expect } from 'bun:test';
import {
  decideAction,
  classifyAction,
  PERMISSION_MODES,
  ACTION_CLASSES,
  DEFAULT_CONFIRM_ACTIONS,
  normalizeMode,
  normalizeConfirmActions,
  confirmActionsFromRecord,
} from '../../extension/peerd-runtime/permissions/policy.js';

// Real-tool-shaped descriptors. Names + sideEffect + primitive copied
// from the actual defs (verified against peerd-runtime/tools/defs/*).
const TOOLS = {
  read_page:     { name: 'read_page',     sideEffect: 'read',            primitive: 'tab' },
  inspect_audit: { name: 'inspect_audit', sideEffect: 'read',            primitive: 'inspect' },
  vm_write_file: { name: 'vm_write_file', sideEffect: 'write',           primitive: 'webvm' },
  js_write_file: { name: 'js_write_file', sideEffect: 'write',           primitive: 'notebook' },
  app_write:     { name: 'app_write_file', sideEffect: 'write',          primitive: 'app' },
  vm_boot:       { name: 'vm_boot',       sideEffect: 'write',           primitive: 'webvm' },
  js_notebook:       { name: 'js_notebook',       sideEffect: 'write',           primitive: 'notebook' },
  page_exec:     { name: 'page_exec',     sideEffect: 'write',           primitive: 'tab' },
  click:         { name: 'click',         sideEffect: 'write',           primitive: 'tab' },
  type:          { name: 'type',          sideEffect: 'write',           primitive: 'tab' },
  navigate:      { name: 'navigate',      sideEffect: 'write',           primitive: 'tab' },
  open_tab:      { name: 'open_tab',      sideEffect: 'mutate_external',  primitive: 'tab' },
  vm_delete:     { name: 'vm_delete',     sideEffect: 'destructive',      primitive: 'webvm' },
} as const; // why: keep sideEffect as the SideEffect literal union, not string

// ---- classifyAction: the taxonomy --------------------------------------
// The classes survive the tier collapse (lineage + the confirm prompt
// label actions by class) even though the confirm rule no longer branches
// on them.

describe('classifyAction', () => {
  test('reads → READ', () => {
    expect(classifyAction(TOOLS.read_page)).toBe(ACTION_CLASSES.READ);
    expect(classifyAction(TOOLS.inspect_audit)).toBe(ACTION_CLASSES.READ);
  });

  test('notebook/vm/app file writes → WORKSPACE_WRITE', () => {
    expect(classifyAction(TOOLS.vm_write_file)).toBe(ACTION_CLASSES.WORKSPACE_WRITE);
    expect(classifyAction(TOOLS.js_write_file)).toBe(ACTION_CLASSES.WORKSPACE_WRITE);
    expect(classifyAction(TOOLS.app_write)).toBe(ACTION_CLASSES.WORKSPACE_WRITE);
  });

  test('code execution → SHELL (even on a workspace primitive)', () => {
    expect(classifyAction(TOOLS.vm_boot)).toBe(ACTION_CLASSES.SHELL);
    expect(classifyAction(TOOLS.js_notebook)).toBe(ACTION_CLASSES.SHELL);
    expect(classifyAction(TOOLS.page_exec)).toBe(ACTION_CLASSES.SHELL);
  });

  test('live-page DOM writes + external mutations + deletes → EXTERNAL', () => {
    expect(classifyAction(TOOLS.click)).toBe(ACTION_CLASSES.EXTERNAL);
    expect(classifyAction(TOOLS.navigate)).toBe(ACTION_CLASSES.EXTERNAL);
    expect(classifyAction(TOOLS.open_tab)).toBe(ACTION_CLASSES.EXTERNAL);
    expect(classifyAction(TOOLS.vm_delete)).toBe(ACTION_CLASSES.EXTERNAL);
  });
});

// ---- decideAction: mode + confirm matrix --------------------------------

describe('PLAN mode is read-only (plus the navigation carve-out)', () => {
  test('reads pass', () => {
    const v = decideAction({ mode: PERMISSION_MODES.PLAN, confirmActions: true, tool: TOOLS.read_page });
    expect(v.allowed).toBe(true);
    expect(v.confirm).toBe(false);
  });

  // The required "Plan blocks a write/tab/fetch tool" assertion — and the
  // browser-native angle: it blocks DOM/tab actions + external, not just
  // file writes. confirmActions:false on purpose — Plan blocks regardless
  // of the confirm toggle.
  test.each([
    ['workspace write', TOOLS.vm_write_file],
    ['shell / page_exec', TOOLS.page_exec],
    ['DOM click', TOOLS.click],
    ['DOM type', TOOLS.type],
    ['destructive delete', TOOLS.vm_delete],
  ])('blocks %s', (_label, tool) => {
    const v = decideAction({ mode: PERMISSION_MODES.PLAN, confirmActions: false, tool });
    expect(v.allowed).toBe(false);
    expect(v.reason).toContain('plan mode is read-only');
  });

  // Navigation carve-out (decision 2026-06-12): pure URL loads are the
  // ONLY non-read actions Plan permits — navigate (runner-side) and
  // open_tab (main-agent surface). click stays blocked above because
  // "click a hyperlink" is indistinguishable from "click Delete" at the
  // tool layer.
  test.each([
    ['navigate (current tab)', TOOLS.navigate],
    ['open_tab (fresh tab)', TOOLS.open_tab],
  ])('allows %s without confirmation', (_label, tool) => {
    const v = decideAction({ mode: PERMISSION_MODES.PLAN, confirmActions: true, tool });
    expect(v.allowed).toBe(true);
    expect(v.confirm).toBe(false);
    expect(v.reason).toContain('navigation carve-out');
  });

  test('the carve-out does not weaken ACT — confirmations on still confirms navigate', () => {
    const v = decideAction({ mode: PERMISSION_MODES.ACT, confirmActions: true, tool: TOOLS.navigate });
    expect(v.allowed).toBe(true);
    expect(v.confirm).toBe(true);
  });
});

describe('ACT + confirmActions ON confirms every non-read', () => {
  test('reads never confirm', () => {
    expect(decideAction({ mode: PERMISSION_MODES.ACT, confirmActions: true, tool: TOOLS.read_page }).confirm).toBe(false);
  });

  test.each([
    TOOLS.vm_write_file, TOOLS.js_notebook, TOOLS.vm_boot, TOOLS.page_exec,
    TOOLS.click, TOOLS.type, TOOLS.navigate, TOOLS.open_tab, TOOLS.vm_delete,
  ])('confirms %o', (tool) => {
    const v = decideAction({ mode: PERMISSION_MODES.ACT, confirmActions: true, tool });
    expect(v.allowed).toBe(true);
    expect(v.confirm).toBe(true);
  });
});

describe('ACT + confirmActions OFF allows all without confirmation', () => {
  test.each(Object.values(TOOLS))('auto-runs %o', (tool) => {
    const v = decideAction({ mode: PERMISSION_MODES.ACT, confirmActions: false, tool });
    expect(v.allowed).toBe(true);
    expect(v.confirm).toBe(false);
  });
});

describe('ACT with missing/garbage confirmActions fails safe to confirming', () => {
  test.each([
    ['undefined', undefined],
    ['null', null],
    ['string', 'full-auto'],
    ['number 0', 0],
  ])('%s → confirms a write', (_label, confirmActions) => {
    const v = decideAction({ mode: PERMISSION_MODES.ACT, confirmActions: confirmActions as any, tool: TOOLS.click });
    expect(v.allowed).toBe(true);
    expect(v.confirm).toBe(true);
  });
});

// ---- normalizers: bad input fails safe ---------------------------------

describe('normalizers fail safe', () => {
  test('unknown mode → plan (read-only)', () => {
    expect(normalizeMode('garbage')).toBe(PERMISSION_MODES.PLAN);
    expect(normalizeMode(undefined)).toBe(PERMISSION_MODES.PLAN);
  });
  test('confirm default is ON', () => {
    expect(DEFAULT_CONFIRM_ACTIONS).toBe(true);
  });
  test('anything but explicit false → confirm ON', () => {
    expect(normalizeConfirmActions('garbage')).toBe(true);
    expect(normalizeConfirmActions(null)).toBe(true);
    expect(normalizeConfirmActions(undefined)).toBe(true);
    expect(normalizeConfirmActions(0)).toBe(true);
    expect(normalizeConfirmActions(true)).toBe(true);
  });
  test('explicit false passes through', () => {
    expect(normalizeConfirmActions(false)).toBe(false);
  });
  test('valid mode values pass through', () => {
    expect(normalizeMode('act')).toBe(PERMISSION_MODES.ACT);
  });
});

// ---- confirmActionsFromRecord: the edge reader --------------------------
//
// Pulls the `confirmActions` boolean off a stored record; anything else
// (missing, non-boolean, null) → undefined so the caller falls through
// its resolution chain.

describe('confirmActionsFromRecord', () => {
  test('explicit false passes through', () => {
    expect(confirmActionsFromRecord({ confirmActions: false })).toBe(false);
  });
  test('explicit true passes through', () => {
    expect(confirmActionsFromRecord({ confirmActions: true })).toBe(true);
  });
  test('non-boolean confirmActions → undefined', () => {
    expect(confirmActionsFromRecord({ confirmActions: 'yes' as any })).toBeUndefined();
  });
  test('missing/nullish record → undefined (caller falls through its chain)', () => {
    expect(confirmActionsFromRecord({})).toBeUndefined();
    expect(confirmActionsFromRecord(null)).toBeUndefined();
    expect(confirmActionsFromRecord(undefined)).toBeUndefined();
  });
});

// ---- dispatcher replay: prove the policy drives the gate + confirm -----
//
// Mirrors dispatcher.js exactly: in Plan, a non-read tool is blocked by
// the persona gate before execute(); in Act, decideAction decides whether
// the async confirm fires. We record confirm() calls + execute() calls to
// assert the observable behavior the real dispatcher produces.

type DispatchOutcome = { blocked: boolean; confirmed: boolean; executed: boolean };

const simulateDispatch = async (
  { mode, confirmActions }: { mode: string; confirmActions: boolean },
  tool: { name: string; sideEffect: string; primitive: string },
): Promise<DispatchOutcome> => {
  const verdict = decideAction({ mode, confirmActions, tool } as any);
  // persona gate: Plan blocks non-read outright.
  if (!verdict.allowed) return { blocked: true, confirmed: false, executed: false };
  // async confirm step.
  let confirmed = false;
  if (verdict.confirm) {
    confirmed = true; // the dispatcher would await ctx.confirm here
  }
  // execute() runs once the action is allowed (and confirmed if required).
  return { blocked: false, confirmed, executed: true };
};

describe('simulated dispatch matches the required scenarios', () => {
  test('Plan blocks a tab write before execute', async () => {
    const r = await simulateDispatch({ mode: 'plan', confirmActions: false }, TOOLS.click);
    expect(r).toEqual({ blocked: true, confirmed: false, executed: false });
  });

  test('confirmations ON confirms then executes a write', async () => {
    const r = await simulateDispatch({ mode: 'act', confirmActions: true }, TOOLS.vm_write_file);
    expect(r).toEqual({ blocked: false, confirmed: true, executed: true });
  });

  test('confirmations ON confirms a shell action too', async () => {
    const r = await simulateDispatch({ mode: 'act', confirmActions: true }, TOOLS.vm_boot);
    expect(r).toEqual({ blocked: false, confirmed: true, executed: true });
  });

  test('confirmations OFF executes everything WITHOUT confirm', async () => {
    const r = await simulateDispatch({ mode: 'act', confirmActions: false }, TOOLS.open_tab);
    expect(r).toEqual({ blocked: false, confirmed: false, executed: true });
  });
});
