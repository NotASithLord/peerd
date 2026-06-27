// @ts-check
// Permission policy — Plan/Act mode + the confirm-actions toggle (Feature 03).
//
// This is the FOUNDATIONAL write-authorization layer. Features 02, 08,
// 09, 05 route every write through `decideAction` here. It is a pure
// function (functional core): given (mode, confirmActions, tool) → a
// verdict the dispatcher acts on. No IO, no chrome.*, no awaits. The
// dispatcher's imperative shell turns the verdict into a gate-block or a
// confirm round-trip.
//
// WHY a second axis on top of the origin gate (the denylist):
//   - The origin gate (peerd-egress) answers "which ORIGINS may a tool
//     touch."
//   - This policy answers "may the agent WRITE at all, and must it ask
//     first." Cline's Plan/Act is the reference. The two axes compose:
//     an action must clear BOTH the origin gate AND this permission gate.
//
// HISTORY (owner decision, 2026-06-12): Act used to carry three Codex-
// CLI-style tiers (suggest / auto-edit / full-auto). Nobody could say
// what full-auto *was* relative to Plan/Act, and the middle tier did
// overlapping work — so the tiers collapsed into ONE boolean,
// `confirmActions`: ON = the old suggest (every non-read confirms),
// OFF = the old full-auto (nothing confirms). Records carry only
// `confirmActions`; `confirmActionsFromRecord` below reads it off a
// stored record.
//
// WHY it lives in peerd-runtime/permissions (not peerd-egress):
//   Plan/Act is an ORCHESTRATION concern — it's about what the agent is
//   allowed to DO in a session, mirroring personas (Read/Act) which the
//   ARCHITECTURE already homes in peerd-runtime. The denylist stays in
//   egress because it's about the network/origin security boundary.
//   ARCHITECTURE.md §2.4 reserves peerd-runtime/personas for exactly
//   this "whether the agent can act at all" axis; Plan/Act is its V1
//   realization, generalized from terminal Build/Plan to the browser's
//   bigger surface (DOM + tabs + fetch + shell, not just files).

/** @typedef {import('/shared/tool-types.js').Tool} Tool */
/** @typedef {import('/shared/tool-types.js').SideEffect} SideEffect */

// --- Modes (the top axis) --------------------------------------------------

export const PERMISSION_MODES = Object.freeze({
  // PLAN — read-only plus pure navigation. The agent may observe (read
  // pages, query the DOM, inspect state, search) and LOAD URLs (the
  // navigation carve-out below), but may NOT mutate anything: no
  // file/workspace writes, no shell, no side-effecting fetch, and — the
  // browser-native part — no side-effecting DOM actions (click/type/
  // navigate/page_exec). Bigger blast radius than a terminal's
  // "plan", so the block list is bigger too.
  PLAN: /** @type {const} */ ('plan'),
  // ACT — writes allowed, subject to the confirmActions toggle.
  ACT: /** @type {const} */ ('act'),
});

// Safe FLOOR (read-only): the value the normalizers and the dispatcher's
// defensive fallback land on for garbage/missing input. NOTE: peerd's actual
// product default for a fresh install is ACT (acting on the browser is the
// point) — that's applied in the SW's resolvePermission, not here, so a
// corrupted record still fails safe to read-only.
export const DEFAULT_PERMISSION_MODE = PERMISSION_MODES.PLAN;

// --- The confirm toggle (the ACT sub-axis) ----------------------------------
//
// ON  (true)  — every non-read action round-trips to the user first.
// OFF (false) — nothing confirms; the agent runs until the user halts.
//
// Safe FLOOR (most-confirming) for garbage/missing input is ON. The
// fresh-install product default is OFF (act without nagging) — applied in
// the SW's resolvePermission, not here, so a corrupted record still fails
// safe to confirming.
export const DEFAULT_CONFIRM_ACTIONS = true;

// --- Action-class taxonomy -------------------------------------------------
//
// Tools carry a `sideEffect` (read | write | mutate_external |
// destructive) and a `primitive` (inspect | tab | web | webvm | notebook
// | app | subagent | time). The policy collapses the (sideEffect,
// primitive) pair into ONE of four action CLASSES. The confirm rule
// itself no longer distinguishes the non-read classes (anything non-read
// confirms when confirmActions is ON), but the taxonomy STAYS: the
// lineage UI and the confirm prompt label actions by class, and the
// review orchestrator intersects on READ. This is the single place the
// taxonomy is encoded; the dispatcher and the UI both read it from here.

export const ACTION_CLASSES = Object.freeze({
  READ: /** @type {const} */ ('read'),
  // Writes confined to the agent's OWN workspace: WebVM disk, Notebook
  // OPFS, App bodies. Reversible, sandboxed, no effect on the user's live
  // web session.
  WORKSPACE_WRITE: /** @type {const} */ ('workspace_write'),
  // Code execution: booting a VM, eval in the Notebook, page_exec/page_eval
  // (arbitrary JS in a live page). Higher stakes than a file write — can
  // do anything within its runtime.
  SHELL: /** @type {const} */ ('shell'),
  // Acts on the user's LIVE web session or the outside world: DOM
  // mutations on real pages (click/type/navigate/page_keys), tab opens,
  // form submits, downloads, cross-origin fetch, deletes. The dangerous
  // bucket.
  EXTERNAL: /** @type {const} */ ('external'),
});

// Primitives whose *writes* are LOCAL — the agent's own sandbox (webvm/
// notebook/app) or the dweb node's own state (dweb_block's blocklist,
// dweb_discovery's switch) — rather than against the user's live browser
// session. A `write` sideEffect on one of these is WORKSPACE_WRITE; a `write`
// on a `tab` primitive (click/type/navigate) is EXTERNAL. (dweb_share/install
// are `mutate_external`, so they're EXTERNAL regardless of primitive.)
const WORKSPACE_PRIMITIVES = Object.freeze(new Set(['webvm', 'notebook', 'app', 'dweb']));

// Specific tools whose write is really code EXECUTION, not a file edit.
// These live in workspace primitives but get classified SHELL so the
// lineage and confirm prompt say what they are (booting a VM or
// evaluating arbitrary JS is a bigger step than writing a file).
const SHELL_TOOLS = Object.freeze(new Set([
  'vm_boot',     // boots/executes the Linux VM
  'js_notebook',     // runs arbitrary JS in the Notebook worker
  'page_exec',   // CDP Runtime.evaluate in a live page
  'page_eval',   // executeScript in a live page
]));

/**
 * Classify a tool into one of ACTION_CLASSES. Pure — depends only on the
 * tool's declared `sideEffect` + `primitive` (+ a small name list for
 * the shell carve-out). Leverages the EXISTING sideEffect field per the
 * brief rather than inventing a parallel annotation.
 *
 * @param {{ name?: string, sideEffect?: SideEffect | 'destructive', primitive?: string }} tool
 * @returns {typeof ACTION_CLASSES[keyof typeof ACTION_CLASSES]}
 */
export const classifyAction = (tool) => {
  const sideEffect = tool?.sideEffect ?? 'read';
  if (sideEffect === 'read') return ACTION_CLASSES.READ;

  // Code execution outranks file-write classification.
  if (tool?.name && SHELL_TOOLS.has(tool.name)) return ACTION_CLASSES.SHELL;

  // `mutate_external` and `destructive` are always the dangerous bucket —
  // form submits, downloads, cross-origin fetch, deletes.
  if (sideEffect === 'mutate_external' || sideEffect === 'destructive') {
    return ACTION_CLASSES.EXTERNAL;
  }

  // sideEffect === 'write' from here. Split by primitive: a write to the
  // agent's own sandbox is WORKSPACE_WRITE; a write to the user's live
  // page/tab (DOM tools) is EXTERNAL.
  if (WORKSPACE_PRIMITIVES.has(tool?.primitive ?? '')) return ACTION_CLASSES.WORKSPACE_WRITE;
  return ACTION_CLASSES.EXTERNAL;
};

// Plan-mode navigation carve-out (decision 2026-06-12; docs/DECISIONS.md).
// why: the owner wants Plan to support "go look at X" workflows, and a
// pure URL load mutates no page state — but at the tool layer "click a
// hyperlink" is indistinguishable from "click Delete", so a click
// carve-out would quietly break the read-only guarantee. Only the two
// tools whose ENTIRE effect is loading a URL qualify: `navigate`
// (runner-side, current tab) and `open_tab` (main-agent surface, fresh
// tab — classified mutate_external for tier purposes, but its effect is
// the same pure load). The denylist origin gate still applies to both.
export const PLAN_NAVIGATION_TOOLS = Object.freeze(new Set(['navigate', 'open_tab']));

// --- The decision ----------------------------------------------------------

/**
 * @typedef {Object} PermissionVerdict
 * @property {boolean} allowed       false = block outright (Plan mode)
 * @property {boolean} confirm       true = must round-trip to the user
 *                                    before running (only meaningful when
 *                                    allowed)
 * @property {string} actionClass    one of ACTION_CLASSES
 * @property {string} reason         human-readable; rendered in lineage UI
 */

/**
 * The core policy. Given the session's permission mode + confirm toggle
 * and a tool, decide whether the call is blocked, auto-allowed, or
 * confirm-gated. Pure.
 *
 * Plan mode: anything that isn't READ is blocked (allowed:false). This is
 * the read-only guarantee — and it's browser-native: it blocks not just
 * file writes but click/type/navigate/page_exec and side-effecting fetch.
 *
 * Act mode:
 *   confirmActions ON   READ auto · everything else confirms
 *   confirmActions OFF  everything auto
 *
 * Missing/garbage confirmActions fails safe to ON (most-confirming) —
 * only an explicit `false` turns confirmation off.
 *
 * @param {Object} input
 * @param {typeof PERMISSION_MODES[keyof typeof PERMISSION_MODES]} input.mode
 * @param {boolean} [input.confirmActions]
 * @param {{ name?: string, sideEffect?: SideEffect | 'destructive', primitive?: string }} input.tool
 * @returns {PermissionVerdict}
 */
export const decideAction = ({ mode, confirmActions, tool }) => {
  const actionClass = classifyAction(tool);

  // Reads are always allowed without confirmation, in every mode.
  // (Plan mode is precisely "reads only.")
  if (actionClass === ACTION_CLASSES.READ) {
    return { allowed: true, confirm: false, actionClass, reason: 'read-only action' };
  }

  // PLAN mode blocks every non-read action — the read-only contract —
  // with one carve-out: pure URL loads (see PLAN_NAVIGATION_TOOLS).
  if (mode !== PERMISSION_MODES.ACT) {
    if (tool?.name && PLAN_NAVIGATION_TOOLS.has(tool.name)) {
      return {
        allowed: true,
        confirm: false,
        actionClass,
        reason: 'plan: navigation carve-out — a pure URL load mutates no page state',
      };
    }
    return {
      allowed: false,
      confirm: false,
      actionClass,
      reason: `plan mode is read-only; blocks ${actionClass} actions`,
    };
  }

  // ACT mode — the confirm toggle decides. Only an explicit OFF skips
  // the round-trip; anything else fails safe to confirming.
  if (confirmActions === false) {
    return { allowed: true, confirm: false, actionClass, reason: 'confirmations off: runs without asking' };
  }
  return { allowed: true, confirm: true, actionClass, reason: `confirmations on: confirms ${actionClass}` };
};

// --- Normalizers (imperative-shell helpers, still pure) --------------------

/**
 * Coerce an arbitrary stored value into a valid permission mode. Used by
 * the SW when reading a possibly-legacy/garbage session record. Unknown
 * → the safe default (PLAN, read-only).
 * @param {unknown} v
 */
export const normalizeMode = (v) =>
  v === PERMISSION_MODES.ACT || v === PERMISSION_MODES.PLAN
    ? v
    : DEFAULT_PERMISSION_MODE;

/**
 * Coerce an arbitrary stored value into the confirmActions boolean.
 * Anything but an explicit `false` → ON (most-confirming) — a garbage
 * record can never silently disable confirmation.
 * @param {unknown} v
 * @returns {boolean}
 */
export const normalizeConfirmActions = (v) => v !== false;

/**
 * Read the effective confirmActions off a stored record (session record,
 * sessionCache snapshot). An explicit `confirmActions` boolean wins;
 * otherwise undefined, so callers can fall through their resolution chain.
 *
 * @param {{ confirmActions?: unknown } | null | undefined} record
 * @returns {boolean | undefined}
 */
export const confirmActionsFromRecord = (record) => {
  const v = record?.confirmActions;
  return v === true || v === false ? v : undefined;
};
