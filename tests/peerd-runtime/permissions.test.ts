// Plan/Act + confirm-actions permission policy (Feature 03; tiers
// collapsed to one boolean 2026-06-12).
//
// The policy is a PURE function (peerd-runtime/permissions/policy.js) with
// no IO and no `/peerd-*` absolute imports, so it's directly importable
// under Bun. Test the pure decision table here; exact service-worker
// confirmation and lifecycle custody are exercised at their real authority
// boundary in the controller protocol suites.

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
  script:        { name: 'script',        sideEffect: 'write',           primitive: 'notebook' },
  click:         { name: 'click',         sideEffect: 'write',           primitive: 'tab' },
  type:          { name: 'type',          sideEffect: 'write',           primitive: 'tab' },
  navigate:      { name: 'navigate',      sideEffect: 'write',           primitive: 'tab' },
  open_tab:      { name: 'open_tab',      sideEffect: 'mutate_external',  primitive: 'tab' },
  vm_delete:     { name: 'vm_delete',     sideEffect: 'destructive',      primitive: 'webvm' },
  message_actor: { name: 'message_actor', sideEffect: 'write',            primitive: 'spawned' },
  page_code:     { name: 'page_code',     sideEffect: 'write',            primitive: 'web' },
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
    // design 7.4: script (headless JS with egress + delegation) must not carry
    // a softer confirm class than the other code lanes via its notebook primitive.
    expect(classifyAction(TOOLS.script)).toBe(ACTION_CLASSES.SHELL);
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
    ['shell / script', TOOLS.script],
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

  // Delegation carve-out: message_actor is the orchestrator's ONLY page-content
  // path (do/get/check folded into the actor). Plan must allow the DELEGATION —
  // the actor it mints inherits Plan, so its inner turn is the real write barrier
  // (its read_page runs, its click/type still block). Without this, Plan can't
  // read a single character of a page ("go look at X and tell me Y").
  test('allows message_actor in Plan — the actor inherits Plan; its inner turn is the barrier', () => {
    const v = decideAction({ mode: PERMISSION_MODES.PLAN, confirmActions: true, tool: TOOLS.message_actor });
    expect(v.allowed).toBe(true);
    expect(v.confirm).toBe(false);
    expect(v.reason).toContain('delegation carve-out');
  });

  // Scope guard (#7 deliberately NOT in this change): the delegation carve-out is
  // Plan-only. In ACT + confirm-ON a delegation still round-trips — the
  // write-classification stands for confirmation until #7 is tackled.
  test('the delegation carve-out is Plan-only — ACT + confirm still confirms message_actor', () => {
    const v = decideAction({ mode: PERMISSION_MODES.ACT, confirmActions: true, tool: TOOLS.message_actor });
    expect(v.allowed).toBe(true);
    expect(v.confirm).toBe(true);
  });

  test('allows page_code composition in Plan while retaining its external write classification', () => {
    const plan = decideAction({
      mode: PERMISSION_MODES.PLAN, confirmActions: true, tool: TOOLS.page_code,
    });
    expect(plan).toMatchObject({
      allowed: true, confirm: false, actionClass: ACTION_CLASSES.EXTERNAL,
    });
    expect(plan.reason).toContain('composition carve-out');
    expect(decideAction({
      mode: PERMISSION_MODES.ACT, confirmActions: true, tool: TOOLS.page_code,
    })).toMatchObject({ allowed: true, confirm: true, actionClass: ACTION_CLASSES.EXTERNAL });
  });
});

describe('ACT + confirmActions ON confirms every non-read', () => {
  test('reads never confirm', () => {
    expect(decideAction({ mode: PERMISSION_MODES.ACT, confirmActions: true, tool: TOOLS.read_page }).confirm).toBe(false);
  });

  test.each([
    TOOLS.vm_write_file, TOOLS.js_notebook, TOOLS.vm_boot, TOOLS.script,
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
