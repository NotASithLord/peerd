# DOM navigation layer — design

> The design for peerd's a11y-tree-+-refs DOM layer (subagent 11). Reads
> on top of `docs/DOM-NAVIGATION-ASSESSMENT.md` (why) and reflects the
> Phase-1 code now in the tree. Phases 2–4 are designed but not built.

---

## Goal

Move observation/action from **raw-DOM + CSS selectors** to **a11y tree +
opaque element refs**, additively (selectors remain the degraded-a11y
fallback). The model picks a ref out of a snapshot; the harness owns the
ref→node mapping and resolves it via CDP. This kills the "model authored a
selector that doesn't exist" failure class and gives denser, more semantic
observations.

---

## Pipelines

### Observation (Phase 1, built)

```
snapshot tool
  → ctx.debuggerPool.getAxTree(tabId)         CDP Accessibility.getFullAXTree
  → serializeAxTree(nodes, {budget})          pure: dom/ax-serialize.js
       • walk tree, emit interactable roles with @e<n> refs
       • emit context roles (heading/dialog/form/…) WITHOUT refs
       • inline state: value="…", [disabled], [checked], [expanded]
       • visible-depth indentation (generic wrappers don't add indent)
       • char budget (default 8 000) + truncation flag
  → ctx.domRefs.setSnapshot(tabId, refs)      dom/ref-registry.js (per-tab)
  → wrapUntrusted(<untrusted_web_content>…)    same wrapper as every DOM tool
  → model
```

The model sees lines like:

```
form "Compose"
  @e1 textbox "To" [value=""]
  @e2 textbox "Subject" [value=""]
  @e3 button "Send" [disabled]
```

### Action (Phase 1, built)

```
click {ref:"@e3"}
  → ctx.domRefs.resolve(tabId, "@e3")          → { backendDOMNodeId, role, name }
       • miss → "stale_ref: re-run snapshot"    (fail-safe, never wrong node)
  → ctx.debuggerPool.clickBackendNode(tabId, backendDOMNodeId)
       CDP DOM.resolveNode → Runtime.callFunctionOn(scrollIntoView + click)
  → { clicked, ref, role, name, tag, text }
```

`click` accepts `ref` (preferred) **or** `selector` (existing path
untouched). `type` will get the same `ref` arm next.

---

## Ref allocation + invalidation

- Refs are allocated **in document order during serialization** (`@e1`,
  `@e2`, …) and **only to interactable roles**. Context/structure roles
  are shown for orientation but carry no ref (you can't click a heading).
- The registry is **per-tab, per-snapshot**: a new snapshot REPLACES the
  tab's refs and bumps a generation counter.
- **Invalidation (Phase 1):** a snapshot replaces refs; tab-close clears
  them (`tabs.onRemoved`). After a navigation the old `backendDOMNodeId`s
  are simply unresolvable — `DOM.resolveNode` fails, the tool errors,
  the model re-snapshots. **Fail-safe: a stale ref never clicks the wrong
  node.** Navigation-time auto-clear is a Phase-2 item (lands with
  `webNavigation`).
- **Survival across mutations (Phase 2):** refs will additionally carry
  stable identity (`aria-*` / `data-*` / role+name) so the MutationObserver
  can re-base a ref to the same logical element between snapshots. Class
  names and `nth-child` are never used as identity (frameworks regenerate
  them).

---

## Defense (already enforced, unchanged by this layer)

- **Egress allowlist (default-deny)** — agent `fetch` reaches only
  provider endpoints. Untouched. (`page_eval`'s MAIN-world fetch inherits
  the user's session by design — a documented seam, gated by the origin
  check before the tool runs.)
- **Untrusted tagging** — `snapshot` output goes through the same
  `wrapUntrusted()` as every DOM tool. Consistent by construction.
- **Sensitive-site denylist** — the origin gate already fires before any
  DOM tool (including `snapshot`) runs, so observation of a denylisted
  site is refused without per-tool work. The brief's "refuse to observe
  sensitive sites" is satisfied by the existing gate; the only addition
  for Phase 3 is a user-visible per-session opt-in prompt at attach time.

---

## Forward phases (designed, not built)

### Phase 2 — content script + diffable snapshots
- First content script in `extension/content/`: maintains an a11y/DOM
  mirror + **MutationObserver**, streams compact deltas (`+button @e47
  "Send"`, `~textbox @e12 value="…"`, `-li @e23`) to the SW. Context grows
  with **actions**, not page size. Re-baseline on navigation.
- **Action-result attribution:** capture the mutation window ~500ms after
  a click and return it as the action's result.
- MV3: content script dies on reload; the SW holds the registry; state
  shuttles through the SW + `chrome.storage`, not SW memory (30s timeout).
- **MutationObserver scoping:** observe the focused interactive subtree(s)
  (forms, dialogs, main landmark), not `document`. Filter out
  self-induced mutations by correlating with the just-issued action.

### Phase 3 — multi-tab pool + SPA routes + framework reads
- **Tab pool** (default 5): one *focused* tab (full snapshot each turn),
  others *summary* (URL, title, last-mutation ts, pending notifications).
  This is where `@tab` (the brief's subagent 04) becomes first-class.
  Data model: `Map<tabId, { focused, lastSnapshotGen, summary }>`.
- Add the `webNavigation` permission; use `onCommitted` /
  `onHistoryStateUpdated` for real SPA route detection (replaces
  `tabs.onUpdated` polling) and ref auto-invalidation.
- **Framework-state reads:** at attach, sniff React/Vue/Svelte markers; if
  present expose `readComponentState(@e<n>)` via MAIN-world injection.

### Phase 4 — visual fallback (Set-of-Marks)
- `captureVisibleTab` → composite numbered SoM boxes (bboxes come free
  from the AX nodes via `DOM.getBoxModel`) onto the screenshot in a
  canvas → send as a real **vision block** to the model. Requires a
  provider vision path (today `capture` strips pixels by design — a real
  change) and an opt-in "visual mode" per tab. Used only when a11y is
  degraded (canvas / p5.js / heavily-custom widgets).

---

## Token-budget analysis

- Snapshot default budget: **8 000 chars ≈ 2 000 tokens** for one focused
  tab. Gmail/Linear compose-level surfaces fit well under this; the
  truncation flag tells the model to narrow (focus a region/tab) rather
  than silently dropping content.
- Target for the multi-tab pool (Phase 3): 1 focused (~2K tok) + 4 summary
  (~50 tok each) ≈ **~2.2K tokens** for 5 tabs of awareness — vs re-reading
  a single heavy page at 20–30K with `read_page`. Diff-only observation
  (Phase 2) drops the steady-state cost toward zero on stable pages.

---

## File map (Phase 1, in tree)

| Piece | File | Tested |
|---|---|---|
| AX serializer (pure) | `peerd-runtime/dom/ax-serialize.js` | ✅ unit |
| Ref registry | `peerd-runtime/dom/ref-registry.js` | ✅ unit |
| Module surface | `peerd-runtime/dom/index.js` | — |
| CDP fetch + ref-click | `background/debugger-pool.js` (`getAxTree`, `clickBackendNode`) | ⛔ needs browser |
| snapshot tool | `peerd-runtime/tools/defs/snapshot.js` | ⛔ needs browser |
| click `{ref}` arm | `peerd-runtime/tools/defs/click.js` | ⛔ needs browser |
| SW wiring | `background/service-worker.js` (`domRefs` singleton + ctx) | ⛔ needs browser |

---

## Built since Phase 1 (now in tree)

- **`type {ref}`** — the action surface's other half. `type.js` got a
  `ref` arm; `debugger-pool.setValueBackendNode` resolves the node and
  sets the value via the native setter (+ input/change, optional Enter /
  requestSubmit), args passed via CDP `arguments` (no interpolation).
- **Diffable observation (CDP re-snapshot variant)** — `snapshot
  {diff:true}` returns only `+added / ~changed / -removed` since the last
  snapshot of that tab. `dom/snapshot-diff.js` is pure (keys on
  backendDOMNodeId, since refs reallocate) and unit-tested; the registry
  retains the prior ref list to diff against. This is the cheap
  action-result read. (The content-script **MutationObserver streaming**
  variant — true incremental, lower latency — is still the optimization;
  this re-fetches the full AX tree and diffs, which gets the token win
  but not the perf win.)
- **Ref invalidation on navigation** — `tabs.onUpdated` (status
  'loading') clears a tab's refs. Chose this over a new `webNavigation`
  permission (CWS scrutiny); SPA route slips still fail safe.
- **Action-result attribution** — every `click {ref}` / `type {ref}` now
  reports what it CHANGED. The CDP `callFunctionOn` body wraps the action
  in a `MutationObserver` (set up before, ~400ms bounded window after),
  collecting added/removed nodes + attribute changes SEMANTICALLY (role +
  accessible name). `dom/action-result.js` formats it (pure, unit-tested);
  the tool returns a `result` line. Navigation-causing actions are caught
  (context-destroyed) and reported as "page navigated". Bounded in TIME,
  not space → no persistent observer, no perf firehose. **The observer
  logic was validated live on httpbin via Claude-in-Chrome** before
  shipping (it captured a synthesized dialog-open + button-disable).
- **Validated against a real page** — the serializer's role assumptions
  were checked against httpbin's live a11y tree (via Claude-in-Chrome):
  textbox/radio/checkbox/button all covered. A fixture derived from it is
  in the serializer test.

- **Streaming watcher (`watch_changes`)** — the continuous variant of
  action-result. Injects a persistent MutationObserver (chrome.scripting,
  ISOLATED world → no debugger banner) that accumulates a rolling delta log
  on a page global; first call baselines, each later call drains "what
  changed since last look". Catches ASYNC updates the per-action window
  misses — slow results, websocket/live updates, notifications. Opt-in per
  tab, resets on navigation (perf-scoped, not a firehose). Observer logic
  validated live on react.dev (caught a post-baseline `alert` injection).
- **Framework-state reads (`read_state {ref}`)** — reads the React fiber /
  Vue component behind a ref (MAIN world via CDP): component name + props +
  state (useState hook values walked from the fiber's hook list; class
  state; Vue 3 setupState / Vue 2 $data). Cleaner than scraping rendered
  DOM, and impossible for a selector-based agent. Validated live on
  react.dev (extracted a component's props).
- **Multi-tab** — every DOM tool takes `tabId`; refs (`domRefs`) and the
  watcher are per-tab; `list_tabs` enumerates. So the agent already
  observes/acts across multiple tabs independently. A dedicated "focus
  pool" with per-tab change summaries is optional sugar on top.

Still deferred: Phase 4 visual / Set-of-Marks (needs a provider vision
path — the largest, most separate lift); a dedicated multi-tab focus-pool
abstraction (the per-tab primitives above already cover the capability).

## Verification reality

The pure core (serialize, refs) is unit-tested and green. Everything that
touches CDP / a live tab **cannot be verified in this harness** — it needs
a real browser on real sites. The Phase-1 acceptance loop is the human's:

1. `snapshot` on `mail.google.com` (logged in) → readable tree < ~10K tok.
2. Pick a ref, `click {ref}` → it actuates the right element.
3. `snapshot` a denylisted site → refused by the origin gate.
4. Re-`snapshot` an unchanged page → refs reallocated consistently.

Phases 2–4 raise the bar (diffing, multi-tab, visual) and each needs its
own real-browser loop. The architecture is built so each phase ships and
is testable on its own.
