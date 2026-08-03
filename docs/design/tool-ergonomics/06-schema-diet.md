# Design 6 — schema diet + repeat-injection dedup

The static surface is ~10,972 tok/turn, 57% of it tool descriptors. The top 3
tools are 40.6% of the main tool surface. And several large tool-RESULT
injections repeat with no dedup. Trim both, without losing capability.

## 6a. Schema diet on the dominant tools

Measured main-surface descriptor sizes (name+desc+schema, chars):

| tool | desc | schema | total | note |
|---|---|---|---|---|
| message_actor | 1880 | **2561** | 4454 | schema > desc; 17.9% of surface |
| script | 2811 | 520 | 3337 | desc-heavy (5 modes) |
| sandbox_create | 1304 | 975 | 2293 | |

Targets, in order:

1. **`message_actor` schema (2,561 chars — the single biggest schema).** A
   2.5k-char JSON schema for a delegation tool is almost certainly
   over-specified: enums re-listed in prose, per-field descriptions that repeat
   the tool description, optional knobs (oneShot, bareReply, timeoutMs) each
   with a paragraph. Diet: move the explanatory prose to the tool DESCRIPTION
   (paid once) and leave the schema with terse field descriptions (paid in the
   schema every turn too, but shorter); collapse any redundant enum/const
   restatements; drop descriptions on self-evident fields (`to`, `message`).
   Target: schema under ~1,200 chars with NO capability loss — every field
   stays, just described tersely. Verify against the tool's execute() that no
   field is removed.
2. **`script` description (2,811 chars).** It now documents 4 modes (compute,
   code-mode+extract, orchestration/actors, sub-model calls) + peerd:std +
   peerd:wasi + workspace + toolbox. Some of this is genuinely load-bearing
   lore. Diet conservatively: fold the peerd:std helper list and the wasi smoke
   note into the once-per-session `JS_PITFALLS_NOTE` (already appended to the
   first script result) rather than the every-turn description; keep the mode
   list terse. Target: trim ~600–800 chars by moving reference material to the
   once-per-session note, keeping the every-turn description to WHAT the modes
   are, not HOW to use each.
3. **`sandbox_create` (2,293).** Likely lists per-kind detail that belongs in
   each kind's create-result note (`NOTEBOOK_NOTE` / `APP_RUNTIME_NOTE` already
   exist for exactly this). Move per-kind how-to out of the every-turn schema
   into the create result.

Rule for all three: **no field, no mode, no capability is removed** — only
reference/how-to prose moves from the every-turn surface to a once-per-session
or on-result surface. Measure before/after chars and assert the net main-surface
delta is meaningfully negative.

## 6b. Repeat-injection dedup

Tool-RESULT injections accumulate in history and re-ship every turn. Audited:

| injection | size | dedup today |
|---|---|---|
| `load_skill` body | ≤64k | **NONE** — full body re-injected per call, stays in history |
| `dweb_guide` BRIDGE_GUIDE | 3,506 | **NONE** |
| `NOTEBOOK_NOTE` | 1,900 | **NONE per session** (per create) |
| `APP_RUNTIME_NOTE` | 866 | **NONE per session** |
| `JS_PITFALLS_NOTE` | 1,501 | **YES** — `pitfallsDisclosed` Set, once/session |

`JS_PITFALLS_NOTE` already has the exact pattern. Apply it to the repeaters:

- **`load_skill`**: if the same skill was already loaded this session, don't
  re-inject the full body — return a short "already loaded this session (see
  the earlier load); re-stating the skill name" pointer. Track a per-session
  `Set<skillName>` like `pitfallsDisclosed`. This is Hermes's "repeat-view
  dedup" (~24.8k tok saved per repeat there). Guard: if the skill body could
  have scrolled out of the context window (history trimmed), a re-load SHOULD
  re-inject — so key the dedup on "still present in the live context," or
  simpler and safe: dedup only within a short recency window / only if the
  prior load is still in untrimmed history. Simplest correct v1: dedup unless
  the session has trimmed since the prior load (`trimSummary.covered` moved
  past the prior load's message). Document the boundary.
- **`dweb_guide`**: once-per-session Set (dweb actor only; small blast radius).
- **`NOTEBOOK_NOTE` / `APP_RUNTIME_NOTE`**: once-per-session — the second
  notebook/app create in a session doesn't need the full runtime note again; a
  one-line pointer suffices.

All of these reuse the `pitfallsDisclosed`-style guard (a `Set` keyed by
session id, re-armed on SW restart). Factor a tiny shared
`oncePerSession(sessionId, key)` helper so the four call sites don't each
hand-roll it.

## Interaction with design 4

4b may spill/​page `load_skill`. 6b dedups repeat loads. Order: 4 first (paging
a body), then 6 (dedup a repeat). They compose: first load pages if huge;
second load in the same session is deduped to a pointer. Keep them consistent
(the pointer names how to re-page if needed).

## Touch points

| File | Change |
|---|---|
| `extension/peerd-runtime/tools/defs/message-actor.js` | schema diet (6a) |
| `extension/peerd-runtime/tools/defs/script.js` | description diet; move reference prose to `JS_PITFALLS_NOTE` (6a) |
| `extension/peerd-runtime/tools/defs/sandbox-create.js` | move per-kind how-to to the create-result notes (6a) |
| `extension/peerd-runtime/tools/defs/code-style-note.js` / `js-create.js` | receive the moved prose; add the note bodies |
| `extension/peerd-runtime/skills/load-skill-tool.js` | once-per-session dedup (6b) |
| `extension/peerd-runtime/tools/defs/dweb-guide.js` | once-per-session dedup (6b) |
| a small shared `oncePerSession` helper | dedup the guard pattern |

## Tests

- **Bun**: descriptor sizes — assert `message_actor`/`script`/`sandbox_create`
  descriptor chars dropped by the targeted amounts AND that the schema still
  contains every field name the tool's execute reads (no capability loss);
  net main-surface delta < 0.
- **Bun**: `oncePerSession` returns true once then false; re-arms per session
  id.
- **In-browser**: loading the same skill twice in a session injects the full
  body once, a pointer the second time; a notebook created twice gets the note
  once.

## Measurement (design 5) + invariant

Design 5's static-surface token count is the scorecard for 6a (must drop). The
batch invariant (README #2): net always-on prompt surface delta ≤ 0 — 6a must
more than pay for any description text designs 1–4 added. Report the final
number.

## Open questions

1. `load_skill` dedup safety — key on "still in untrimmed history" vs. a simple
   once-per-session? Recommend once-per-session BUT re-inject if the session
   trimmed past the prior load (so a scrolled-out skill can be recovered).
2. How aggressive on `message_actor`'s schema — target 1,200 chars, or just
   remove redundant enum restatements? Recommend: measure each field's cost,
   cut prose duplication first, stop when capability is at risk. Report the
   achieved number.
