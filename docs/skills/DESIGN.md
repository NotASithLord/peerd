# Feature 07 — Progressive-disclosure Skills (SKILL.md)

Implements the **Agent Skills** open standard (Anthropic Skills / Linux
Foundation "Agent Skills") inside peerd: a skill is a `SKILL.md` file with
YAML frontmatter; at startup peerd loads only the **descriptions** (cheap)
into the system prompt; on invocation it injects the full **body**
(expensive). Skills install from a local directory (paste/import), a git
URL, or a static manifest URL. No peerd cloud, no MCP, no telemetry.

Module: `extension/peerd-runtime/skills/` (public surface re-exported via
`/peerd-runtime/index.js`). It is functional-core/imperative-shell: the
parser and registry are pure over their inputs; all IO (storage,
`webFetch`) is injected.

---

## 1. SKILL.md parsing + frontmatter (`parse.js`, pure)

A SKILL.md is a Markdown doc fenced by `---` with YAML frontmatter, then
an instruction body:

```
---
name: pdf-filler
description: Fill PDF forms from a data map. Use when the user...
version: 1.2.0
allowed-tools: [Bash, Read, Edit]      # Claude Code / Codex compat
---
# PDF Filler
<full instructions...>
```

`parseSkillMd(text)` → `{ name, description, version, license,
allowedTools, extra, body }`.

- **Hand-rolled YAML subset, not a vendored parser.** Skill frontmatter is
  a flat key→scalar/list map in every real-world skill (Claude Code, Codex
  CLI, Gemini CLI emit the same shape). A full YAML engine is a large
  untrusted-input attack surface for ~6 fields — anchors, tags, and
  type-construction we don't want when parsing bytes fetched from a git
  URL. The reader supports exactly: `key: scalar`, block lists (`- item`),
  inline flow lists (`[a, b]`), quoted scalars, one level of nested map,
  `#` comments. Anything else is kept as a raw string and **never
  executed**.
- **Known vs extra keys.** `name`, `description`, `version`, `license`,
  `allowed-tools`/`allowed_tools` become first-class fields. Every other
  key (`metadata`, `author`, future Claude Code additions) is preserved
  verbatim under `extra` and **never interpreted as behaviour** — a skill
  cannot set a key that peerd acts on.
- **`allowed-tools` is advisory.** Parsed and surfaced for display, but
  peerd never auto-grants anything from it. The dispatcher's six gates
  remain the sole authority.
- **Validation:** missing fence / missing `name` / missing `description`
  throw `SkillParseError`. Body is capped at 64 KiB (≈16k tokens) by
  byte length so one giant SKILL.md can't blow context or memory.
- **`normalizeName`** lowercases + hyphenates the name (same constraint
  the standard puts on the skill directory name); `"PDF Filler"` →
  `pdf-filler`. Normalize-not-reject so authored-loosely skills still
  install.

## 2. The registry (`registry.js`, core deliverable)

`createSkillRegistry({ store, audit })` owns the progressive-disclosure
contract and an in-memory description index (rebuilt cheaply from the meta
store on cold SW start).

| method | tier | reads |
|---|---|---|
| `install(text, opts)` | — | parses, persists meta+body, caches meta |
| `list()` | cheap | meta store only |
| `describeForPrompt()` | cheap | meta store only → system-prompt block |
| `loadBody(name)` | **expensive** | body store, **only on invocation** |
| `setEnabled(name, on)` | — | toggle without uninstalling |
| `remove(name)` | — | uninstall (reversibility) |

The registry **never executes anything**. Installing only records text.
`allowedTools` is exposed for the UI but never acted on.

## 3. Startup descriptions vs on-invocation body injection

This is the whole point — the lean-memory budget (<200 lines of skill
context at startup) is met by never loading a body until it's needed.

**Cheap half — startup, every turn.** The SW calls
`skillRegistry.describeForPrompt()` once per turn. It renders ONLY enabled
skills as `name — one-line description` and stitches them into the system
prompt at the `{{SKILLS_BLOCK}}` placeholder (added to
`peerd-provider/system-prompt.txt`, substituted in
`peerd-runtime/loop/system-prompt.js` alongside `{{TEMPORAL_BLOCK}}`).
With no skills installed it returns `''` and the placeholder collapses —
zero token cost. No skill body is ever deserialized here.

**Expensive half — on invocation.** The block tells the model: when a
request matches a skill, call `load_skill("<name>")`. That tool
(`load-skill-tool.js`, primitive `inspect`, sideEffect `read`) reads the
full SKILL.md body from the body store and returns it wrapped in
`<skill name="...">…</skill>` as a tool result. The body enters context
exactly once, exactly when wanted. The agent loop is untouched — a skill
loads like any other tool call, with full lineage + audit.

Storage mirrors the split: meta and body are separate IDB object stores
(`store.js`), so the startup `listMeta()` never touches a single body
byte.

## 4. Install sources + the egress/safety story

Three sources (`install.js`), all funneling raw SKILL.md text into
`registry.install`:

- **(a) local** — `installFromLocal` — pasted/imported text. No egress.
- **(b) git** — `installFromGit` — `resolveGitRawUrl` maps a GitHub
  blob/tree/repo (or any) URL to the single raw `SKILL.md` over HTTPS,
  then fetches it. We deliberately do **not** `git clone`: there's no git
  binary in the browser and cloning a whole repo is an open-ended fetch
  surface. One file, tight + auditable.
- **(c) manifest** — `installFromManifest` — a **static** JSON file the
  user points at (`{ "skills": [{ "url": "...SKILL.md" }] }`). NO peerd
  cloud. Each entry installs independently; one bad entry fails soft.

**Lethal-trifecta defense.** A git/manifest URL is UNTRUSTED CONTENT.

1. **Every remote fetch goes through the injected `webFetch`** (peerd-
   egress: scheme check + denylist + audit). NEVER bare `fetch`. A skill
   cannot reach a denylisted host even to fetch itself; a denied fetch
   surfaces as a clean `SkillInstallError`, and the bytes never arrive.
   Transport guards on top: 256 KiB per-document cap, 50-skill manifest
   cap.
2. **Installing only records text.** The parser refuses to interpret
   unknown frontmatter as behaviour, and the registry executes nothing.
   A skill **cannot silently widen egress or auto-run code** by being
   installed. Anything it later asks the agent to do still passes the six
   gates — `load_skill` itself is `read`/no-egress, so reading a playbook
   you installed is friction-free, but the playbook is data, not a policy
   override (framed like `<untrusted_web_content>`).

Audit events: `skill_installed`, `skill_invoked`, `skill_removed`.

## 5. Browser-native angle

A peerd skill is a browser-native playbook, not just a CLI recipe. Because
the body is plain instruction text the agent reads on demand, a skill can
teach a peerd-specific workflow: drive a specific SaaS via the tab tools
(`navigate`/`read_page`/`query_dom`/`click`/`type`/`page_exec`), or a
WebVM recipe (`vm_create`/`vm_boot`). The standard's compatibility means a
skill authored for Claude Code / Codex CLI / Gemini CLI parses unchanged;
peerd just maps its `load_skill` invocation onto the same SKILL.md.

## 6. Cross-cutting checklist

- **No MCP / no telemetry / single-threaded writes.** ✓ (IDB txns;
  registry cache is module-instance state).
- **MV3 30s SW death.** Skills persisted in IDB (`peerd-skills` DB),
  rehydrated on cold start from the meta store. Tested.
- **Lean memory <200 lines.** Only descriptions at startup; bodies on
  demand. `describeForPrompt` clamps each description to one line / 300
  chars.
- **Reversibility.** `remove` uninstalls (meta+body dropped);
  `setEnabled(false)` hides without deleting.
- **a11y / reduced-motion.** Skills UI uses real `<button>`/`<label>`,
  `aria-live` status, checkbox toggles; no animation.
- **Egress.** All remote fetch via `webFetch`; no bare `fetch`; no
  cross-module deep imports.
- **Conventions.** Vanilla ESM strict, `index.js` public API, functional
  core / injected IO, `// why:` comments.

## 7. The feature-01 storage adapter

Feature 01 (file-based memory) owns the real peerd workspace store
(read/write/list under a namespace in IDB/OPFS) and is built in parallel.
Until it lands, `store.js` is a thin, self-contained two-tier IDB adapter
peerd-skills owns: `createSkillStore({ idbFactory })` →
`{ put, listMeta, getBody, getMeta, remove }`. The registry consumes ONLY
this interface — it never touches IDB directly.

**Integrator handoff:** replace `createSkillStore()` in the SW with a thin
wrapper over feature 01's workspace store under a `skills/` namespace,
keeping two logical records per id (a small `meta` and a large `body`) so
the startup path still reads descriptions without touching bodies. The
registry, the tool, the prompt injection, and the UI need no changes. See
DEV-NOTES.md "01 adapter".

## 8. V1.x gaps (documented, not front-run)

- Real `git clone` of a multi-file skill bundle (scripts/assets alongside
  SKILL.md) via WebVM — V1 fetches the single SKILL.md only.
- Bundled skill resources (a skill referencing sibling files) — the
  standard allows them; V1 reads the body only.
- Per-skill egress grant prompts when a skill's playbook wants a new host
  — V1 leans on the existing denylist + per-tool gates.
- Subagents don't get the skills block (the SW's subagent prompt wrapper
  is synchronous; main turns get it). Trivial to extend when wanted.
