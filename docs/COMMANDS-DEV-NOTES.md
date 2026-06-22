# Feature 04 — Slash commands + @-references + palette (DEV-NOTES)

Integrator-facing notes. Pairs with `docs/COMMANDS-DESIGN.md`.

## Entry points

| Concern                         | File                                                                 |
| ------------------------------- | ------------------------------------------------------------------- |
| Module public API               | `extension/peerd-runtime/composer/index.js` (re-exported by `peerd-runtime/index.js`) |
| Parse command + refs (pure)     | `extension/peerd-runtime/composer/parse.js`                         |
| Live palette trigger (pure)     | `parse.js` `activeTrigger(text, caret)`                              |
| Fuzzy filter/rank (pure)        | `extension/peerd-runtime/composer/palette-filter.js`               |
| Commands store (KV)             | `extension/peerd-runtime/composer/command-store.js`                |
| Command sources + 07 adapter    | `extension/peerd-runtime/composer/command-sources.js`             |
| `@file` / `@tab` resolvers      | `extension/peerd-runtime/composer/resolvers.js`                    |
| Untrusted wrap (Bun-safe copy)  | `extension/peerd-runtime/composer/wrap.js`                          |
| Per-turn orchestration          | `extension/peerd-runtime/composer/apply.js` `applyComposer`        |
| Palette UI                      | `extension/sidepanel/components/command-palette.js`               |
| Composer wiring into textarea   | `extension/sidepanel/components/input-bar.js`                      |
| Palette CSS                     | `extension/sidepanel/styles.css` (`.command-palette` block)        |
| SW wiring                       | `extension/background/service-worker.js`                            |

## SW message handlers (added)

| type               | returns                                              |
| ------------------ | --------------------------------------------------- |
| `commands/list`    | `{ commands: [{name, description}] }` (all sources) |
| `commands/put`     | author/overwrite a LOCAL command                    |
| `commands/delete`  | remove a local command (idempotent)                 |
| `composer/tabs`    | `{ tabs: [{id,title,origin,active,blocked}] }` — `blocked` = denylisted/unsupported |
| `composer/files`   | `{ files: [path] }` — current chat's App files      |

`agent/send` now runs `applyComposer({ text, commandSources, ctx })`
BEFORE `runAgentTurn`, rewriting the text and emitting local audit
entries (`composer_command`, `composer_reference`). If expansion throws,
it falls back to sending the raw text (never blocks a turn).

## Storage keys

- Commands: `peerd.commands.<name>` in `kv` (chrome.storage.local),
  prefix `COMMAND_KEY_PREFIX` (`peerd.commands.`). Record:
  `{ name, body, description, updatedAt }`. Markdown bodies are small;
  well under the KV record budget. No IDB schema bump — fully reversible.

## `@tab` security wrap (read this before touching resolvers)

1. `decideTabGate({ url, denylist })` runs **before** capture: refuses
   chrome/about/extension/devtools schemes and any denylisted host
   (`findDenylistMatch`, boundary-safe).
2. Capture injects a self-contained `'use strict'` function (closes over
   nothing) via `ctx.scripting.executeScript` — same rules as
   `read-page.js`. Text capped at 4000 chars.
3. **Re-gate** on the page-reported `location.href` (redirect defense).
4. `buildTabPayload` wraps in
   `<untrusted_web_content origin tool="at_tab" retrieved_at>` — output
   shape is byte-identical to `read_page`'s wrap (pinned by a test).

If you add a new `@`-kind, route it through the same gate+wrap. Never
inline raw page text without the `<untrusted_web_content>` fence.

## The feature-07 (skills) adapter — wiring

The composer depends on a thin `commandSources` contract, not on 07.
Today the SW wires only the local store:

```js
// background/service-worker.js
const commandStore = createCommandStore({ kv });
const commandSources = localStoreSource(commandStore);
```

When 07's skill registry exists, change those two lines to:

```js
import { mergeSources, localStoreSource, skillRegistrySource } from '/peerd-runtime/index.js';
const commandStore = createCommandStore({ kv });
const commandSources = mergeSources([
  localStoreSource(commandStore),
  skillRegistrySource(skillRegistry),   // 07 provides skillRegistry.listCommands()
]);
```

Contract `skillRegistrySource` needs: `skillRegistry.listCommands()` →
`Promise<[{ name, body, description? }]>`. If 07 uses a different method
name, edit the single call in `command-sources.js`
`skillRegistrySource`. `mergeSources`: earlier source wins on name
collision (user shadows skill), dedup + sort, throwing source → `[]`.

## Tests

`tests/peerd-runtime/composer/*.test.ts` (61 tests, run `bun test ./tests`):
- `parse.test.ts` — command parse, ref parse (incl. email non-match,
  trailing-period strip, offsets), `activeTrigger`.
- `palette-filter.test.ts` — subsequence match, prefix/boundary ranking,
  stability, limit.
- `resolvers.test.ts` — denylist gate (incl. look-alike boundary +
  scheme refusal), untrusted-wrap shape (exact byte match vs read_page),
  `@tab` capture + pre/post-capture re-gate, `@file` read, back-to-front
  splice, graceful failure note.
- `store-and-apply.test.ts` — KV store round-trip, name validation,
  source merge + 07 adapter (incl. throwing-source tolerance),
  `applyComposer` command expansion + ref splice end-to-end.

## V1.x gaps / non-goals

- **Command body templating** — `$ARGUMENTS` / positional placeholders
  (Claude Code style) are NOT interpolated; the user arg is appended as a
  trailing block. Add a templating pass in `apply.js` if wanted.
- **`@file` across Apps** — resolves only the CURRENT chat's app subtree
  (via `appClient`'s session default). No cross-app `@file:appId/path`
  yet; the resolver already threads `sessionId`, so add an `appId` arg
  parse if needed.
- **Palette tab data freshness** — `composer/tabs`/`composer/files` are
  fetched once per trigger-type per open and cached client-side; they
  don't live-update if tabs change while the palette is open. Re-open to
  refresh. Cheap to make reactive later.
- **No fuzzy match on command DESCRIPTIONS** — filtering matches the
  name/label only; description is display-only.
- **Skill commands are read-only here** — `commands/put`/`delete` only
  touch the local store. 07 owns skill-command lifecycle.
