# Feature 04 — Slash commands + @-references + command palette (DESIGN)

> Browser-native composer superpowers for peerd. `/command` expands a
> stored markdown body (Claude Code style); `@file` / `@tab` inline
> content (Cursor style); a keyboard-first palette autocompletes both.
>
> Star feature: **`@tab`** — the peerd-native extension of `@file`. It
> inlines the live DOM + URL + visible text of an open tab, under the
> user's authenticated session, straight into the turn. Nothing else in
> the agent space does this from a browser extension.

Code lives in `extension/peerd-runtime/composer/` (logic) +
`extension/sidepanel/components/command-palette.js` + the composer wiring
in `input-bar.js` + SW handlers in `background/service-worker.js`.

---

## 1. `/command` resolution

A message is a command iff it **starts** (after leading whitespace) with
`/<name>` where `<name>` is `[a-zA-Z0-9][a-zA-Z0-9_-]*` and is followed by
whitespace or end-of-string. This mirrors Claude Code and shells: `/foo`
mid-sentence, `//`, `/ foo`, and a pasted `/path/to/file` are all literal
text, never commands. (`parse.js` `parseCommandName`, lookahead `(?=\s|$)`.)

Resolution (`apply.js` `applyComposer`):

1. Parse the command name + same-line free-text argument
   (`/review the auth flow` → name `review`, args `the auth flow`).
2. Look the name up across the wired **command sources** (§5).
3. If found: drop the `/name args` line, substitute the command's
   markdown **body**, then append the user argument as the task, and
   re-attach any further lines (multi-line input survives):
   `{body}\n\n{args}\n{rest}`.
4. If **not** found: leave the text exactly as typed. A `/typo` goes
   through as literal text — we never silently drop the user's message.

Commands are stored in the peerd workspace `.peerd/commands/` surface.
peerd has no real FS, so a "command file" is a record: `{ name, body,
description?, updatedAt }` keyed in KV under `peerd.commands.<name>`
(`command-store.js`). Names map 1:1 to the conceptual
`.peerd/commands/<name>.md`.

## 2. `@-references`

A reference is `@(tab|file)(:arg)?` at a **word boundary** (preceded by
start-of-string or whitespace), so `ariel@tab.com` is never a reference
(`parse.js` `REF_RE`, `parseRefs`). References may appear anywhere in the
message; each carries exact `[start,end)` source offsets so resolution can
splice replacements back **back-to-front** (keeping earlier offsets valid).

| Token              | Meaning                                            |
| ------------------ | -------------------------------------------------- |
| `@tab`             | the **active** tab's live content                  |
| `@tab:123`         | the tab with id 123                                |
| `@file:path/x.md`  | a stored App/sandbox file at that path             |

A trailing sentence punctuation char on a file arg is stripped, so
`@file:readme.md.` resolves `readme.md`.

### 2.1 `@file` resolver

First-party content (Apps/sandbox the user or agent authored inside
peerd). Reads through the injected `appClient.readFile({ path, sessionId })`
— the **same** surface `app_read_file` uses. The body is fenced in
`<peerd_file path="…">…</peerd_file>` with an escaped path attribute.

Why fence first-party files at all: a file may itself contain
**scraped-then-saved** web text. Fencing it as reference DATA (not raw
prose) keeps an injected payload inside such a file from masquerading as
instructions just because the user `@`-mentioned it.

### 2.2 `@tab` resolver — the lethal-trifecta surface

`@tab` pulls **untrusted web content** under the user's authenticated
session straight into the model context. That is exactly the `read_page`
threat model, so the resolver reuses `read_page`'s defenses verbatim
(`resolvers.js`):

- **Untrusted wrap (NON-NEGOTIABLE).** The captured snapshot is wrapped in
  `<untrusted_web_content origin="…" tool="at_tab" retrieved_at="…">…</…>`
  — byte-identical in shape to `read_page`'s wrap (asserted in
  `resolvers.test.ts`). The system prompt already teaches the model to
  treat content inside these tags as DATA, never COMMANDS. `tool="at_tab"`
  (vs `read_page`) marks the provenance: a user-authored `@`-mention, not
  an agent-initiated read.
- **Origin / denylist gate.** `decideTabGate({ url, denylist })` runs
  BEFORE any capture. It refuses (a) `chrome://`/`about:`/extension/
  devtools schemes outright (don't leak browser internals into a prompt),
  and (b) any host matching the egress **denylist** (banks, health, etc.)
  using the SAME `findDenylistMatch` the DOM tools' origin gate uses —
  boundary-safe (`evilchase.com` ≠ `*.chase.com`).
- **Re-gate after capture.** The injected capture reports `location.href`;
  we re-derive the origin from THAT (a redirect could have moved the page
  onto a denylisted host between the tab record and the read) and re-gate.
  Only then do we build the payload.

Capture itself is a self-contained injected function (serialized by
`chrome.scripting.executeScript`, re-evaluated in the page world, `'use
strict'`, closes over nothing) — same constraints as `read-page.js`. Text
is capped at 4000 chars (~1k tokens), matching `read_page`'s budget.

A resolution failure (denylisted, no tab, capture error) does **not**
abort the turn: the raw token is left inline with a
`(could not resolve: <reason>)` note and the message proceeds.

## 3. Functional core / imperative shell split

| Pure (Bun-tested, no IO)                              | Shell (IO injected)               |
| ---------------------------------------------------- | --------------------------------- |
| `parse.js` — tokenize command + refs, `activeTrigger`| `command-store.js` — KV-backed    |
| `palette-filter.js` — fuzzy filter/rank              | `resolvers.js` resolve* — scripting/appClient |
| `decideTabGate` / `buildTabPayload` / `buildFilePayload` | `apply.js` — orchestration     |
| `command-sources.js` — merge/adapter logic           |                                   |

The resolver core imports its leaf deps (`./wrap.js`,
`../../peerd-egress/denylist/denylist.js`) **relatively**, not via the
extension's leading-slash form, so the pure functions stay testable under
Bun without a browser. `wrap.js` carries a dependency-light copy of
`prompt-wrap.js`'s wrap (same output, no `/shared/util.js`); a test pins
the exact tag shape so the two never drift.

## 4. Command palette — UX + a11y

The palette (`command-palette.js`) is a popup ABOVE the textarea, driven
by `activeTrigger(text, caret)` which detects the in-progress `/` or `@`
token at the caret and returns `{ type, kind?, query, from, to }`.
`input-bar.js` owns the textarea and routes keys to the palette.

Candidate flow:
- `/` → list commands (`commands/list`), filter by name.
- `@` (no kind) → offer the two kinds (`tab`, `file`).
- `@tab` → the active-tab shortcut + every other open tab
  (`composer/tabs`); denylisted/unsupported tabs are shown **disabled**.
- `@file:` → the current chat's App files (`composer/files`).

Selecting a candidate splices its `insert` text over `[from, to)` and
restores focus + caret after the redraw.

Filtering is **subsequence (fuzzy)** matching like every IDE palette
(`palette-filter.js`): query chars must appear in order, not contiguously
(`rvw`→`review`, `qd`→`query-dom`). Ranking: exact-prefix ≫ word-boundary
hits (`-`/`_`/`/`/`.`/space/camel seams) ≫ brevity ≫ earlier first match.
Deterministic + stable for ties.

### Accessibility (non-negotiable)

- Popup is `role="listbox"`; each row `role="option"` with
  `aria-selected` / `aria-disabled`.
- Textarea wires `aria-autocomplete="list"`, `aria-expanded`,
  `aria-controls="composer-palette"`, and `aria-activedescendant` →
  the active option id, so screen readers announce the highlighted item.
- **Fully keyboard-navigable**: ArrowUp/Down move, Enter/Tab commit,
  Esc closes — all without focus leaving the textarea (typing
  uninterrupted). Cmd/Ctrl+Enter still SENDS even with the palette open.
- Mouse selection uses `mousedown` + `preventDefault` so the pick commits
  before the textarea blurs.
- **No reduced-motion violation**: the only transition is a CSS
  `background` fade on the active row, gated off under
  `@media (prefers-reduced-motion: reduce)`. No JS-driven motion.

## 5. Command sources + the feature-07 (skills) adapter

`commandSources` is a `{ list() → [{name, body, description?}] }` contract
(`command-sources.js`). V1 wires one source: `localStoreSource(store)`
over the `.peerd/commands/` KV store. The slash-parser, @-resolver, and
palette depend on the **contract**, not on 07.

Feature 07 (skills, built in parallel) can EXPOSE commands. The integrator
adds a second source and merges:

```js
import { mergeSources, localStoreSource, skillRegistrySource } from '/peerd-runtime/index.js';
const commandSources = mergeSources([
  localStoreSource(commandStore),          // user's local commands WIN on name collision
  skillRegistrySource(skillRegistry),      // 07's registry; needs listCommands()
]);
```

`skillRegistrySource` depends only on a `listCommands()` returning
`{ name, body, description? }` — if 07 names it differently, change the
single call site, nothing else moves. `mergeSources` dedupes by name
(earlier source wins, so a user can always shadow a skill command),
sorts, and **tolerates a throwing source** (07 not yet wired → that
source degrades to `[]`, the palette still works).

## 6. Cross-cutting checklist

- **Lethal trifecta** — `@tab` wraps in `<untrusted_web_content>` + origin
  denylist gate, pre- and post-capture. `@file` fenced as DATA. ✅
- **No MCP / no bare fetch** — resolvers use injected `scripting` /
  `appClient`; no network. ✅
- **MV3 30s SW** — composer expansion is a few awaits (one tab query +
  one scripting inject per @tab, one KV read for commands); no long work,
  no blocking the dispatch. ✅
- **Reversibility** — commands are deletable KV records; nothing migrates
  the shared IDB schema. Removing the feature leaves no orphan stores. ✅
- **No telemetry** — references/commands are audited LOCALLY only
  (`composer_reference` / `composer_command` audit-log entries). ✅
- **Lean** — every composer source file < 200 lines. ✅
- **a11y / reduced-motion** — see §4. ✅
- **Vanilla JS ES modules, no build step; index.js public API; `// why:`
  comments.** ✅
