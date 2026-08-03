# Tool-ergonomics batch — the tool surface as a UX for the model

> Point-in-time proposals (2026-08). Prompted by the Hermes "Core Toolset
> Performance Batch" (schema diet, failure hints, recoverable truncation,
> repeat-view dedup) and grounded in a three-part audit of peerd's own tool
> surface. Once a design lands, the code is the spec — cull the doc to a
> pointer in the landing PR.

## Thesis

Most of an agent's cost is invisible: tokens paid every turn for static
surface, turns burned on uninformative errors, and second calls forced by
truncation that threw away the remainder. peerd measures none of it today.
This batch attacks all three, and fixes four confirmed bugs found while
auditing.

The Hermes headline was "especially for smaller/weaker/local models." peerd
ships a keyless Ollama adapter and gates a local WebGPU engine — bad tool
affordances are exactly what makes weak models unusable, so this is worth
disproportionately more here than in a Claude-only harness.

## The measured baseline (what we're improving from)

- **Static surface per main turn: ~10,972 tok** (57% tool descriptors,
  43% system prompt). Top 3 tools (`message_actor`, `script`,
  `sandbox_create`) = 40.6% of the main tool surface.
- **~77% of 183 distinct error strings are bare codes** (`cmd_required`,
  `no_target_tab` ×12) with no next step.
- **Exactly two spill paths exist** (web cache, run cache); every other
  large-payload tool is cap-and-lose. Both spill readers page at 16,000
  chars/call into an **8,000-char redact ceiling** — half of every recovered
  page is re-elided.
- **No tool-error or wasted-turn metric** anywhere in the eval scorecard.

## The designs

| # | Design | One-liner | Danger zone |
|---|--------|-----------|-------------|
| 1 | [prompt-cache-stability](01-prompt-cache-stability.md) | Stop the volatile temporal block from cache-busting the whole system prompt every turn | prompt assembly / provider wire |
| 2 | [failure-legibility](02-failure-legibility.md) | Deliver authored error `content` to the model; make `tool_failed` audit fire on `{ok:false}` | loop seam / audit |
| 3 | [edit-robustness](03-edit-robustness.md) | edit_file: no silent wrong-path writes; already-applied no-op; match locations; whitespace diagnosis | edit subsystem |
| 4 | [universal-spill](04-universal-spill.md) | One shared spill helper; reconcile the 16k/8k ceiling; extend recovery to the cap-and-lose tools | truncation / result plumbing |
| 5 | [tool-error-metrics](05-tool-error-metrics.md) | Tool errors + wasted turns in the eval scorecard, so the rest is A/B-provable | eval harness (no runtime) |
| 6 | [schema-diet](06-schema-diet.md) | Trim the top-3 tool schemas; dedup repeat `load_skill`/guide injections | tool descriptors / skills |

## Land order & dependencies

- **5 lands FIRST** where possible — it's how every other design proves its
  delta. It's eval-harness-only (no runtime risk).
- 1, 2, 3 are the four confirmed bugs — independent, small, highest value per
  line. Any order.
- 4 depends on nothing but shares files with 2 (result plumbing) and 6
  (load_skill); integrate 2 before 4, 4 before 6.
- 6 is last (surface polish); its `load_skill` dedup composes with 4's spill.

## Shared invariants

1. **Fencing is preserved.** Every change that alters what reaches the model
   keeps `wrapUntrusted` on untrusted-provenance bytes. A more-legible error
   is still tool-authored (trusted); a recovered spill slice is still fenced.
2. **No new always-on prompt surface** without removing at least as much.
   This batch's net token delta on the static surface must be ≤ 0.
3. **Security/gate behavior is unchanged.** These are ergonomics + legibility
   fixes; no gate, capability, or exposure rule loosens.
4. **Every behavioral change is measurable** via design 5's new metrics or a
   Bun test — no "trust me it's better."
