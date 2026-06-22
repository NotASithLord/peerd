# Feature 07 — Skills — DEV-NOTES

Quick map for the integrator. Everything ships behind
`/peerd-runtime/index.js`; the SW wires it.

## Entry points

| Concern | File |
|---|---|
| Parse SKILL.md (pure) | `extension/peerd-runtime/skills/parse.js` |
| Storage adapter (two-tier IDB) | `extension/peerd-runtime/skills/store.js` |
| Registry (progressive disclosure) | `extension/peerd-runtime/skills/registry.js` |
| Install sources (local/git/manifest) | `extension/peerd-runtime/skills/install.js` |
| `load_skill` tool (body on invocation) | `extension/peerd-runtime/skills/load-skill-tool.js` |
| Public surface | `extension/peerd-runtime/skills/index.js` → `peerd-runtime/index.js` |
| SW wiring | `extension/background/service-worker.js` |
| System-prompt placeholder | `extension/peerd-provider/system-prompt.txt` (`{{SKILLS_BLOCK}}`) + `extension/peerd-runtime/loop/system-prompt.js` |
| UI | `extension/sidepanel/components/skills-view.js`, mounted as the `'skills'` section of `extension/options/components/options-app.js` (the full-tab options page) |
| Tests | `tests/peerd-runtime/skills/{parse,registry,install}.test.ts` |

## Storage keys

- IDB database **`peerd-skills`**, version 1, two object stores:
  - `meta`   — keyPath `id` — `{ id, name, description, version, license,
    allowedTools, source, origin, sizeBytes, enabled, installedAt }`.
    `id` = normalized name = the invocation handle. **Startup reads this
    store only.**
  - `bodies` — keyPath `id` — `{ id, body }` — full SKILL.md text. Read
    only by `load_skill`.
- No `chrome.storage` keys added. Skills are not on the global `pushState`
  payload — the UI fetches via `skills/list` on mount and after mutations.

## System-prompt injection point

`peerd-provider/system-prompt.txt` gained a `{{SKILLS_BLOCK}}` placeholder
(after the tool list, before `{{WEB_TAB_POLICY}}`).
`renderSystemPrompt(ctx)` substitutes `ctx.skillsBlock` (empty string →
collapses). The SW builds the block once per turn:

```js
const skillsBlock = await skillRegistry.describeForPrompt();
const getSystemPrompt = (trustMode) =>
  renderSystemPrompt({ trustMode, temporalBlock, skillsBlock, backgroundTabsEnabled });
```

`describeForPrompt()` emits only enabled skills as `name — description`
plus a one-paragraph instruction to call `load_skill`. The body is NEVER
in the prompt.

## Tool wiring

`load_skill` is registered like a built-in: `registerTool(loadSkillTool)`.
The registry is attached to the ToolContext as `ctx.skills` in
`buildToolContext`, so the tool's `execute` can call
`ctx.skills.loadBody(name)`. Primitive `inspect`, sideEffect `read`, no
origins → no confirmation/egress gate friction for reading an installed
playbook.

## Install / egress notes

- SW message handlers (in `makeDispatcher`): `skills/list`,
  `skills/installLocal`, `skills/installGit`, `skills/installManifest`,
  `skills/setEnabled`, `skills/remove`. Replies follow `{ ok, ... }`;
  install errors map to stable codes (`already-installed`, `parse-failed`,
  `install-failed`) via `skillInstallError`.
- git + manifest install use the SW's **`webFetch`** (egress denylist +
  scheme + audit). `installFromLocal` and `installFromManifest` take their
  fetch as a dep — never bare `fetch`. Caps: 256 KiB/doc, 50 skills/
  manifest, 64 KiB/body (parser).
- `resolveGitRawUrl` handles github.com blob/tree/repo URLs (→
  raw.githubusercontent.com) and passes through already-raw / generic
  `.../SKILL.md` URLs.

## The feature-01 adapter

`store.js` is the seam. The registry depends ONLY on the store interface
`{ put(meta, body), listMeta(), getBody(id), getMeta(id), remove(id) }`.

To repoint at feature 01's workspace store:

1. In the SW, replace `const skillStore = createSkillStore();` with a thin
   object implementing the five methods over feature 01's namespaced
   store (namespace `skills/`). Keep two logical records per id — a small
   `meta` and a large `body` — so `listMeta()` stays cheap (descriptions
   without bodies).
2. Nothing else changes: registry, `load_skill`, prompt injection, UI, and
   tests all sit above the seam.

If feature 01 exposes only a flat `read/write/list`, store meta under
`skills/meta/<id>` and body under `skills/body/<id>`, and make `listMeta`
list the `skills/meta/` prefix.

## V1.x gaps

- Single-file fetch only (no `git clone`, no bundled skill resources).
  Real multi-file bundles → WebVM clone, deferred.
- No per-skill egress grant prompt (a skill's playbook reaches new hosts
  through the normal denylist + per-tool gates).
- Subagents don't receive the skills block (SW subagent prompt wrapper is
  sync; main turns get it). Extend `renderSystemPrompt` call in
  `makeSpawnSubagent` wiring if subagents should see skills.

## Tests

Run `bun test ./tests` for the full suite. The skills-specific suite at
`tests/peerd-runtime/skills` covers frontmatter+body parse,
Claude-Code/Codex format, registry lists descriptions only, body on
invocation, git-URL resolution, manifest fan-out via a fake `webFetch`, and
the `load_skill` tool.
