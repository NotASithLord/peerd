# DESIGN-13 — memory v2: addressable entries, batch ops, and recall at scale

> Status: DESIGN. Nothing here is implemented. Feature number 13
> (01 memory, 02 edit, 03 plan/act, 06 cost, 07 skills, 08 schedule,
> 09 undo-redo, 10 export, 11 async-subagents, 12 home-spa are taken).
> This EXTENDS the shipped memory system (DESIGN-01); it does not
> replace it. Read DESIGN-01-memory.md first.

## Motivation

peerd already has real cross-session memory: file-based AGENTS.md docs
in IndexedDB, hierarchical scopes (`user` / `project` / `subtree`),
always-loaded budget trimming into `{{MEMORY_BLOCK}}`, an `/init`
scanner, confirm-gated `remember`, and session-end auto-extraction into
a pending-suggestions queue (DESIGN-01, DESIGN-09). The foundation is
sound. This design is about the next reach: making memory **robust at
scale** the way the Hermes memory-management tool is.

The prompt for this work was the Hermes Agent "memory batch operations"
result (Teknium, 2026-06): a single memory tool that does `add` /
`remove` / `replace` in **one batched call**, reported as ~52% fewer
tool-call turns versus single-edit updates, and the headline use case of
"saving many turns of tool calls" into durable memory.

### The honest gap in today's `remember`

peerd's `remember` (`extension/peerd-runtime/tools/defs/remember.js`)
takes a **full markdown `body`** that *replaces the entire doc for a
scope*. That is fine while a doc is small. It does not scale:

- **Re-emission cost.** To add one fact or fix one line, the model must
  reproduce the *entire* doc body in the tool call. As the user/project
  doc grows toward the 24,000-char `MAX_DOC_CHARS` cap, every edit pays
  output tokens proportional to the whole doc — exactly the cost Hermes'
  batch ops eliminate.
- **Clobber risk.** A full-body rewrite can silently drop content the
  model forgot to re-type. The confirm diff catches gross changes, but a
  one-line omission inside a 180-line doc is easy to approve by mistake.
- **No addressing.** There is no way to say "remove the third bullet
  under ## Preferences" or "replace the fact tagged `deploy-cmd`." Memory
  is an opaque blob, so the agent can only think in whole-doc terms.

So peerd is, paradoxically, *already* "batched" in the trivial sense
(one call rewrites everything) — but it pays the worst-case token cost
on every edit and offers no surgical operations. The Hermes win for
peerd is **targeted, addressable block operations** that avoid full-doc
re-emission while preserving the confirmation seam.

## What v2 adds (three capabilities)

1. **Addressable entries** — a doc is parsed into stable, ID-anchored
   blocks. Edits target a block, not the whole body.
2. **Batched `memory_update`** — one tool call carrying an *array* of
   ops (`add` / `replace` / `remove` / `move`), one confirm, one diff.
3. **Recall at scale** — when memory outgrows the always-loaded budget,
   a `search_memory` retrieval path and a summarize/evict step keep the
   prompt block small without losing the long tail.

Each is independently shippable; ship in that order.

---

## 1. Addressable entries (the data-model change)

Keep markdown as the source of truth — it stays human-editable in
Options → Memory, exportable, diffable, and prompt-friendly. Add a thin
**block index** layered over the existing `body` string. No new object
store; the `MemoryDoc` shape (DESIGN-01 §data-model) is unchanged on
disk. Blocks are *derived*, not stored separately — the body remains the
single truth, so import/export and the Options editor keep working
untouched.

A **block** is a contiguous markdown region with a stable anchor. Anchor
strategy, in preference order:

- **Explicit anchor comment** the writer emits:
  `<!-- peerd:id=deploy-cmd -->` immediately before a heading or
  paragraph. Survives reordering and rewording. This is how the agent's
  own writes are anchored.
- **Heading path** as a fallback for hand-authored docs with no anchors:
  a block is addressed by its heading trail, e.g.
  `Preferences > Deploy`. Stable across body edits that don't touch
  headings.

Pure functions to add to `memory.js` (the testable core):

```js
// parse a body into ordered blocks with anchors + char ranges
parseBlocks(body) -> [{ id, anchor:'comment'|'heading', heading, text, start, end }]
// apply a validated op list to a body, returning the new body
applyMemoryOps(body, ops) -> { body, applied:[...], rejected:[...] }
// build the confirm diff from old/new bodies (reuse buildWriteProposal seam)
```

`applyMemoryOps` is pure and total: unknown-id `replace`/`remove` ops are
*rejected* (collected, returned, never throw) so a partially-stale batch
degrades gracefully instead of clobbering. The op list is validated
before any confirm is shown.

---

## 2. Batched `memory_update`

A new tool sits alongside `remember` and `read_memory`. `remember` stays
(it is the right primitive for "write this whole short doc" and for
`/init`'s draft). `memory_update` is the surgical, scale-friendly path.

```jsonc
{
  "name": "memory_update",
  "primitive": "memory",
  "sideEffect": "write",
  "description": "Apply a batch of targeted edits to memory in ONE call: add / replace / remove / move blocks across one scope. The user confirms the combined diff once. Prefer this over `remember` for docs you are not rewriting wholesale.",
  "schema": {
    "type": "object",
    "required": ["scope", "ops"],
    "properties": {
      "scope":     { "enum": ["user", "project", "subtree"] },
      "workspace": { "type": "string" },
      "subpath":   { "type": "string" },
      "ops": {
        "type": "array", "minItems": 1, "maxItems": 20,
        "items": {
          "type": "object",
          "required": ["op"],
          "properties": {
            "op":     { "enum": ["add", "replace", "remove", "move"] },
            "id":     { "type": "string", "description": "anchor id or heading path; required for replace/remove/move" },
            "after":  { "type": "string", "description": "anchor to insert after (add/move); omit = append" },
            "text":   { "type": "string", "description": "markdown for add/replace" }
          }
        }
      }
    }
  }
}
```

### One confirm for the whole batch

This is the load-bearing security point. peerd's memory writes are the
**lethal-trifecta seam** (DESIGN-01): an agent that can read untrusted
web content AND write durable memory AND have that memory steer future
behavior is the classic prompt-injection laundering path, so **agent
writes always require user confirmation**. v2 does not weaken that — it
makes it *cheaper and clearer*:

- The N ops are applied to a working copy → one combined diff →
  **one** `confirm()` call (same `kind:'memory_write'` channel
  `remember` uses today, same Options-panel diff renderer).
- The diff is rendered block-aware: "+2 blocks, ~1 replaced, −1 removed"
  with the per-block before/after, instead of a wall-of-text whole-doc
  diff. Easier to approve correctly — which is the real safety win, not
  just the token win.
- `origin:'user'` edits from the Options panel keep skipping confirm
  (user action *is* consent), exactly as today.

So the 52%-fewer-calls property comes from two places: (1) the agent
stops re-emitting the whole doc per edit, and (2) several edits collapse
into one confirmed call instead of one `remember` per edit.

### "Saving many turns of tool calls"

The Hermes headline use ("save many turns of tool calls into memory") is
two distinct needs in peerd, and they split cleanly:

- **Durable facts/preferences learned from a session** → memory v2. The
  auto-memory extractor (DESIGN-09) already distills a session into
  candidate notes; point its approved output at `memory_update` (block
  `add`s with anchors) instead of the current append-to-user-doc helper,
  so auto-memory and manual memory share one write path.
- **A replayable *procedure* (the sequence of tool calls itself)** →
  that is a **workflow/recipe, not memory**. See DESIGN-14. Memory
  stores *what is true*; workflows store *what to do*. Keeping that
  boundary is what stops memory from rotting into an un-versioned,
  un-permissioned script store.

---

## 3. Recall at scale

Today only `user` + `project` docs are always-loaded, trimmed to a
200-line budget (`ALWAYS_LOADED_LINE_BUDGET`), with `subtree` docs read
on demand via `read_memory`. That holds for a while. The scale work,
when docs get large:

- **`search_memory` tool** (`primitive:'memory'`, `sideEffect:'read'`):
  substring/keyword search across all scopes (and into the trimmed tail
  of always-loaded docs), returning matching blocks with their anchors so
  the agent can then `read_memory` or `memory_update` them by id. Pure
  matcher in `memory.js`; no embeddings in v1 (no model dependency, no
  egress, deterministic, Bun-testable). Semantic recall is a later,
  flagged option — note it in ROADMAP, don't front-run it.
- **Budget overflow → summarize-and-link.** When a doc exceeds budget,
  the always-loaded block shows a generated *summary head* plus the
  existing "load on demand" marker, instead of a hard truncation. The
  full blocks stay addressable via `search_memory` / `read_memory`. The
  summary is produced by the same cheap clean-context call auto-memory
  uses, and is itself a block (anchor `peerd:id=__summary__`) the user
  can inspect and edit.

---

## Phasing

1. **Block index + `memory_update`** (the core ask). Pure
   `parseBlocks` / `applyMemoryOps` + the batched tool + block-aware
   confirm diff. Repoint auto-memory's approved notes at it. Ships the
   Hermes parity win.
2. **`search_memory`** + the Options panel surfacing block anchors so
   users can see/copy the ids the agent edits by.
3. **Summarize-and-link budget overflow.** Only once real docs are
   hitting the budget in the field.

## Security / invariants (unchanged from DESIGN-01)

- Agent writes confirm. Always. v2 reduces the *number* of confirms,
  never removes the gate. The "memory autopilot, no confirm" idea is
  explicitly **out of scope** — it reopens the lethal trifecta.
- Memory never touches web origins (`origins: () => []`), so the
  origin/egress gates stay trivial passes; the confirm gate is the teeth.
- Body stays the single source of truth; blocks are derived. Export /
  import / Options editing are unaffected.
- All new logic lands in the pure core (`memory.js`) with Bun tests
  under `tests/peerd-runtime/memory/`; the store/shell only gains the
  thin `applyMemoryOps`-then-`writeWithConfirm` wiring.

## Open questions

- Anchor collisions on hand-edited docs (two blocks resolving to the
  same heading path). Proposal: dedupe by appending the ordinal; reject
  ambiguous `replace`/`remove` and surface to the agent.
- Do `move` ops earn their keep in v1, or defer? Leaning defer —
  add/replace/remove cover the Hermes result; `move` is polish.
- Should `search_memory` count against the cost meter? It's local-only
  (no model call in v1), so no — but the future semantic variant would.
