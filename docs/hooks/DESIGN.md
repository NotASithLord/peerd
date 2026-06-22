# Feature 10 — Lifecycle Hooks (pre/post-tool-use)

> Status: V1 implemented. Two load-bearing events. Wired into the tool
> dispatcher. The egress allowlist ships as a default pre-tool-use hook.

## 1. What this is

A **hook** is a small policy function that runs around a tool call as it
flows through the dispatcher. Two events ship in V1 — the two that carry
weight:

| Event | When | Power |
|---|---|---|
| `pre-tool-use` | after the six sync gates **and** the async confirmation, **before** `tool.execute()` | **BLOCK** the call or **MODIFY** its args |
| `post-tool-use` | after `tool.execute()` returns (success *or* failure) | **OBSERVE** the result (V1: observe-only) |

Reference point is Claude Code's ~30-event hook system; V1 deliberately
ships only the two events that are load-bearing for the lethal-trifecta
defense. The compile/runner seams are built so later events (e.g. a
`session-start` or a WebVM/shell body kind) land without touching the
dispatcher.

This feature is **foundational**: features 03 (plan/act), 05 (Ralph) and
others register hooks through the public API. It is also **central to the
security model** — a pre-tool-use hook is the last programmable veto
before a side effect runs.

## 2. Architecture (functional core / imperative shell)

```
peerd-runtime/tools/hooks/
  runner.js              PURE. runPreToolUse / runPostToolUse / selectHooks / hookMatches.
                         No IO. Hooks + ctx are injected. This is the testability lever.
  registry.js            SHELL over module state + storage. register/list/load/save/remove/export.
  compile.js             UserHookRecord → runnable Hook. declarative + js body kinds. markdown parser.
  defaults/
    egress-allowlist.js  The flagship: the egress allowlist AS a pre-tool-use hook.
    active-tab-guard.js   The browser-native example: inspects ctx.activeTab.
    index.js             DEFAULT_HOOKS (trusted, code, always-on).
  index.js               module barrel → re-exported from peerd-runtime/index.js
```

The split mirrors the gates: `runner.js` is pure functions over values;
the dispatcher (the imperative shell) feeds it the live registry and ctx.

### Hook shape

```js
{
  id: 'egress-allowlist',         // stable
  event: 'pre-tool-use',          // | 'post-tool-use'
  enabled: true,                  // default true
  order: 10,                      // lower runs first; default 100
  match: '*',                     // tool-name glob: '*' | 'click' | 'page_*'
  run: (inv) => decision,         // inv: { event, toolName, args, result?, ctx }
}
```

A pre-hook returns a `HookDecision`:

```js
{ action: 'allow' }                                  // or no return at all
{ action: 'block',  reason }                          // fail-closed veto
{ action: 'modify', args: <replacement>, reason }     // rewrite the call
```

## 3. Exact dispatcher integration (`peerd-runtime/tools/dispatcher.js`)

The dispatcher's order is now:

```
getTool → [persona, exposure, origin, confirmation, egress, audit] sync gates
        → async confirmation (if settings.confirmActionsEnabled)
        → PRE-TOOL-USE HOOKS         ← new
        → execute()
        → POST-TOOL-USE HOOKS        ← new
        → return ToolResult { meta: { gates, hooks, durationMs } }
```

Concretely:

- `args` became `let` — a pre-hook may rewrite it. Gates still see the
  original args (gates are authorization, not transformation).
- `const hooks = ctx.hooks ?? listHooks();` — injected for tests, falls
  back to the live registry in production.
- A `hookCtx = { ...ctx, getToolMeta }` is passed to hooks so the egress
  hook can read a tool's `sideEffect` / `origins` without the dispatcher
  special-casing it.
- `runPreToolUse(...)`: if `!allowed`, audit `tool_blocked` (gate
  `pre-tool-use-hook`) and return `hook_blocked:pre-tool-use:<reason>`.
  Otherwise `args = pre.args` (adopt rewrites) and continue to execute.
- After execute (both the success and the catch branch),
  `runPostToolUse(...)` runs; its outcomes are appended to `meta.hooks`.
- `meta.hooks: HookOutcome[]` was added to `ToolMeta`
  (`shared/tool-types.js`). The side-panel lineage renderer can show
  hooks next to gates with zero new plumbing — same shape.

The placement (after confirmation) is deliberate: a deterministic policy
hook can overrule a human "yes". A seatbelt should not be bypassable by
clicking through a prompt.

## 4. Fail-closed semantics (the whole point)

A pre-tool-use hook is the last veto before a side effect. So **errors
block, never pass**. `runPreToolUse` converts each of these to a BLOCK:

| Condition | Result |
|---|---|
| hook `run()` throws | block — `"<id>: threw (...) — failing closed"` |
| returns a non-object | block |
| `action: 'modify'` with no replacement `args` | block |
| unknown `action` verb | block |
| (with injected `invoke`) hook times out / hangs | block |
| compile fails (bad regexp, CSP refuses `Function`) | hook is **skipped** at load — it simply never runs |

The FIRST block short-circuits remaining pre-hooks. Modify decisions
**compose**: each hook sees the args as left by the previous one, in a
deterministic `order`-then-`id` sequence (so modify chains are
reproducible).

**Post-hooks are the exception** and intentionally do **not** fail
closed: the side effect already happened. A throwing post-hook is
recorded in `meta.hooks` and ignored — failing closed there would mean
misreporting an effect that already occurred to the model.

## 5. The egress allowlist as a DEFAULT hook (dogfooding the model)

`defaults/egress-allowlist.js` re-expresses peerd's single most important
security primitive — the network-origin allowlist that `safeFetch`
enforces — as a pre-tool-use hook:

- It runs for `mutate_external` tools (the network bucket). It resolves
  the call's declared origins via the tool's own `origins(args, ctx)`
  (the same function the origin gate uses), normalizes each with
  `originOf` (imported from `/peerd-egress/index.js`), and **blocks** any
  origin not on `ctx.allowlist` (hardcoded providers + user endpoints,
  the exact list `safeFetch` checks).
- `order: 10` so the network veto runs before softer policy hooks.
- Fail-closed: a throwing `origins()` or an unparseable target **blocks**
  — an unenumerable footprint is exactly the injection shape we refuse.

This is **defense in depth, not replacement**: `safeFetch` is still the
hard floor at the actual fetch boundary inside `peerd-egress`. The hook
adds an *earlier* veto at the dispatcher layer and proves the hook system
is a real policy chokepoint — if the allowlist can be a hook, hooks are
load-bearing. The egress hook is **code, not config**: it can't be
exported away or disabled through the user-hook surface.

## 6. Browser-native angle (the mandate)

`defaults/active-tab-guard.js` is the browser-native example. Where the
egress hook reasons about a declared network origin, this one reaches
into **the live browser context** — `ctx.activeTab` (the tab the agent is
driving) — and, for DOM-write tools (`type`, `click`, `page_exec`,
`page_keys`, `navigate`), stamps a `_browserContext` provenance field
onto the call (origin, path, a credential-sensitive heuristic, a
timestamp). This is the `modify` decision path firing on a
browser-native signal: a pre-hook is the only layer that can see "the
model wants to TYPE, and the page it will type into is a login form."

V1 annotates rather than blocks (the denylist + origin gate own hard
origin blocks); a user can ship a lower-`order` pre-hook to hard-block
instead — hooks compose.

## 7. Storage model — `.peerd/hooks/` without a filesystem

peerd's workspace is logical: there is no real FS. A user authors hooks
as markdown-with-frontmatter at the logical path `.peerd/hooks/<id>.md`,
but the bytes live in `chrome.storage.local` under:

```
hooks.user.v1   →  UserHookRecord[]   (serializable; versioned key)
```

`parseHookMarkdown(text)` (compile.js) splits frontmatter + the first
```js fence into a `UserHookRecord`; `compileUserHook(record)` turns it
into a runnable Hook. Two body kinds:

- **`declarative`** — a `{ matchArg, pattern, onMatch }` JSON rule. No
  code execution, safe under any CSP. The recommended shape.
- **`js`** — a function body compiled via `new (AsyncFunction)('inv',
  body)`. Gated behind `trusted: true` (the user must explicitly opt in
  to running hook code). Under a strict CSP `Function` construction
  throws → the hook is skipped (correct fail-closed result). The
  always-on egress hook is code, not config, so it is unaffected.

V1.x reserves a **shell/WebVM body kind** (run a hook as a shell script
in the sandboxed Linux VM) — the compile seam is where it lands.

## 8. Reversibility (hard constraint)

User hooks are plain serializable records — nothing hidden in opaque
state:

- `exportHooks()` → `UserHookRecord[]` for download.
- `saveUserHook` / `removeHook` / `clearUserHooks` — full CRUD; the SW is
  the single writer (single-threaded writes).
- SW message handlers: `hooks/list`, `hooks/save`, `hooks/remove`,
  `hooks/export`, `hooks/clear`. Default hooks appear in `hooks/list`
  with `isDefault: true` and are refused by `hooks/remove`.

## 9. MV3 / persistence

Default hooks register synchronously at SW boot (idempotent — safe across
the 30s idle restart). User hooks load async from storage on each boot;
the dispatcher reads the live registry per call, so a load completing
after the SW wakes is picked up immediately. A load failure leaves only
the defaults installed — the safe degraded state.

## 10. Public API (`peerd-runtime/index.js`)

```
registerHook, unregisterHook, listHooks, exportHooks,
loadUserHooks, saveUserHook, removeHook, clearUserHooks, HOOKS_STORAGE_KEY,
runPreToolUse, runPostToolUse, selectHooks, hookMatches,
compileUserHook, parseHookMarkdown,
DEFAULT_HOOKS, egressAllowlistHook, activeTabGuardHook
```

## 11. Cross-cutting checklist

- [x] **Lethal-trifecta**: pre-hook is the last veto; this feature is central to it.
- [x] **Fail-closed**: throw/garbage/timeout/malformed-modify → block. Post-hooks intentionally observe-only.
- [x] **No MCP.** Pure in-tree JS.
- [x] **Single-threaded writes.** SW is the only writer of `hooks.user.v1`.
- [x] **Lean memory.** runner.js + registry.js + compile.js each well under 200 lines.
- [x] **MV3 30s idle.** State persisted to storage; defaults re-register on boot.
- [x] **No telemetry.** Hook outcomes stay in `meta` + the local audit log.
- [x] **Reversibility.** export / remove / clear; records are plain JSON.
- [x] **Bare fetch forbidden.** Egress hook reuses egress `originOf`; no fetch here.
- [x] **a11y / reduced-motion.** No UI shipped in this slice (settings UI is V1.x — see DEV-NOTES); the SW handlers it will call are in place.
- [x] **Browser-native.** active-tab-guard inspects `ctx.activeTab`.
- [x] **index.js public API.** Module barrel re-exported from runtime index.
- [x] **Comments say WHY.**
