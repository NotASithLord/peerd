# Feature 10 — Hooks: DEV-NOTES

Integrator-facing notes. Read DESIGN.md first for the model.

## Entry points

| Thing | File |
|---|---|
| Pure runner (block/modify/observe/fail-closed) | `extension/peerd-runtime/tools/hooks/runner.js` |
| Registry (register/list/load/save/remove/export) | `extension/peerd-runtime/tools/hooks/registry.js` |
| Compiler (record → Hook; markdown parser) | `extension/peerd-runtime/tools/hooks/compile.js` |
| Default egress-allowlist hook | `extension/peerd-runtime/tools/hooks/defaults/egress-allowlist.js` |
| Hooks settings UI | `extension/sidepanel/components/hooks-view.js`, mounted as the `'hooks'` section of `extension/options/components/options-app.js` |
| Module barrel | `extension/peerd-runtime/tools/hooks/index.js` |
| Public re-export | `extension/peerd-runtime/index.js` |
| Dispatcher wiring | `extension/peerd-runtime/tools/dispatcher.js` |
| SW boot + handlers + ctx.allowlist | `extension/background/service-worker.js` |
| Tests | `tests/peerd-runtime/hooks.test.ts` |

## Storage keys

- `hooks.user.v1` → `UserHookRecord[]` in `chrome.storage.local` (via the
  `kv` wrapper). Versioned namespaced key, `settings.v1` convention.
- No IDB store added — user hooks are small and serializable, so KV
  (chrome.storage.local) is the right tier (IDB is for blobs/queues).

## Dispatcher changes (review these)

In `dispatcher.js`:
1. New imports: `listHooks` (registry), `runPreToolUse` / `runPostToolUse`
   (runner).
2. `args` is now `let` (pre-hooks may rewrite it).
3. `const hooks = ctx.hooks ?? listHooks()` — injection seam for tests.
4. `hookCtx = { ...ctx, getToolMeta }` passed to hooks (gives the egress
   hook a read view of any tool's `sideEffect` / `origins`).
5. Pre-hook phase after the async confirmation step, before `execute()`.
   Block → `hook_blocked:pre-tool-use:<reason>` + `tool_blocked` audit.
6. Post-hook phase after `execute()` in BOTH the success and catch
   branches.
7. `meta.hooks: HookOutcome[]` added to every return path (and to
   `ToolMeta` in `shared/tool-types.js`).

## SW changes

- Imports added from `/peerd-runtime/index.js`: `registerHook`,
  `listHooks`, `loadUserHooks`, `saveUserHook`, `removeHook`,
  `clearUserHooks`, `exportHooks`, `parseHookMarkdown`, `DEFAULT_HOOKS`.
- Boot: `for (const h of DEFAULT_HOOKS) registerHook(h)` then
  `loadUserHooks({ kv })` (fire-and-forget).
- `buildToolContext` now returns `allowlist: [...HARDCODED_ALLOWLIST,
  ...userEndpoints]` (egress hook input) and `now: Date.now`
  (provenance).
- Message handlers added: `hooks/list`, `hooks/save`, `hooks/remove`,
  `hooks/toggle`.

## How a feature registers a hook (03 plan/act, …)

```js
import { registerHook } from '/peerd-runtime/index.js';

registerHook({
  id: 'step-budget-guard',
  event: 'pre-tool-use',
  order: 30,
  match: '*',
  run: (inv) => {
    if (overBudget(inv.ctx)) return { action: 'block', reason: 'step budget exhausted' };
  },
});
```

Register at SW boot (alongside the `DEFAULT_HOOKS` loop) for a trusted
code hook, or persist a `UserHookRecord` via `saveUserHook({ kv }, record)`
for a user-config hook.

## Authoring a user hook (markdown)

```
---
id: block-secret-typing
event: pre-tool-use
match: type
order: 50
trusted: true
---
Block the type tool from entering anything that looks like an API key.

```js
if (/sk-[A-Za-z0-9]{20,}/.test(inv.args.text ?? "")) {
  return { action: "block", reason: "looks like a secret" };
}
```
```

Declarative (no code, safe under any CSP):

```
---
id: no-evil
event: pre-tool-use
rule:
  matchArg: url
  pattern: evil\.com
  onMatch: block
---
```

Save via `parseHookMarkdown(text)` → record → `saveUserHook`, or send the
raw markdown to the `hooks/save` SW handler (`{ markdown }`).

## Gotchas

- **Bun can't resolve `/peerd-*/` absolute imports.** That's why the test
  exercises the runner/registry/compile directly (no absolute imports)
  plus a mini-dispatcher, instead of importing the real dispatcher (which
  transitively imports `/peerd-egress/index.js`). The egress hook's
  *pure decision logic* mirrors `safeFetch`'s allowlist check; its
  integration belongs in the in-browser suite (see below).
- **Post-hooks do NOT fail closed.** By design — the effect already ran.
  Don't "fix" this into a block.
- **`modify` MUST carry replacement `args`.** A modify without args is a
  fail-closed block, not a silent original-args execution.
- **`new Function` and CSP.** The `js` body kind uses `AsyncFunction`
  construction. Under a strict page CSP this throws and the hook is
  skipped at load — fine for user config (it just doesn't run), and the
  always-on egress hook is code so it's unaffected. If MV3's extension
  CSP ever blocks `Function` in the SW world, the `js` kind degrades to
  unavailable and only `declarative` hooks work — acceptable, and the
  fail-closed direction.
- **`getToolMeta` is dispatcher-injected**, not on the base ctx. A hook
  that needs a tool's sideEffect must read `inv.ctx.getToolMeta(name)`
  and tolerate `undefined` (unknown tool).
- **Order ties:** defaults are listed before user hooks, so a same-`order`
  default wins a tie (you can't out-prioritize the egress floor with an
  equal order — use a lower number deliberately if you mean to).

## Shipped UI

- **Settings UI.** The Hooks section (`hooks-view.js`, mounted as the
  `'hooks'` section of the options page) lists/edits hooks over the SW
  `hooks/*` handlers, with per-hook enable/disable via the `hooks/toggle`
  route (the `enabled` field is honored by `selectHooks`).

## V1.x gaps (deliberately not built)

- **Shell / WebVM body kind.** `compile.js` reserves the seam; a hook
  body could run as a shell script in the sandboxed Linux VM. Not in V1.
- **More events.** Only `pre-tool-use` / `post-tool-use` ship. Adding
  `session-start` etc. is a new event string + a runner call at the new
  site; the registry/compile layers don't change.
- **Post-hook veto / result rewrite.** V1 post-hooks observe only.
- **Hook execution timeout in production.** `runPreToolUse` accepts an
  injectable `invoke` (tested with a 5ms race); the SW does not yet pass
  one. Wire a timeout `invoke` when untrusted hook bodies become common.

## In-browser test to add (V1.x)

The Bun suite covers the pure core. Add an in-browser case at
`extension/tests/runner.html` that dispatches a `mutate_external` tool
with an off-allowlist origin through the REAL `dispatchToolCall` and
asserts `hook_blocked:pre-tool-use:egress-allowlist`. This needs the
browser (chrome.*, the egress absolute import), which is exactly the
in-browser suite's job.
```
