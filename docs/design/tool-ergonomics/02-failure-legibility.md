# Design 2 — failure legibility: let the model SEE the failure, let the audit COUNT it

Two independent bugs, one theme: peerd already authors good failure
information and then throws it away before anyone (the model, the user, an
analyzer) can use it.

## 2a. Authored error `content` is discarded at the loop seam

### The bug

27 sites across 12 tool files return a failure with BOTH a machine `error`
code and a human `content` explanation, e.g.
`fetch-url.js:113`:
```js
return { ok: false, error: 'declined', content: 'User declined the outbound write.' };
```
But `agent-loop.js:859-863` builds the model-visible block from `.error` only:
```js
const rawContent = dispatchResult.ok
  ? (…content…)
  : (dispatchResult.error ?? 'tool failed');
```
So the model sees the bare token `declined` and cannot distinguish "the user
said no — do not retry" from "a transient system failure — maybe retry." Every
authored explanation on a failure path in the product is dropped.

Full site list (grep `ok: false.*content:` in `tools/defs/`): complete-goal
(×2), dweb-block, dweb-discover, dweb-discovery (×2), dweb-guide,
dweb-install (×3), dweb-peers, dweb-share (×2), fetch-url (×2), remember,
schedule-cancel (×2), schedule-create (×3), schedule-list, site-client-write
(×2), toolbox-write (×2).

### The fix

At the loop seam, on the failure path, prefer the authored `content` when
present, and still surface the code. Shape:
```js
: (typeof dispatchResult.content === 'string' && dispatchResult.content
    ? `${dispatchResult.error ?? 'error'}: ${dispatchResult.content}`
    : (dispatchResult.error ?? 'tool failed'));
```
Rationale for `code: content` (not content alone): the machine code is a
stable anchor the model has learned to recognize (`declined`, `not_found`),
and the prose is the actionable part — keep both, code first. This is one edit
at `agent-loop.js:859-863`.

Provenance: the failure `content` is tool-authored (trusted) in all 27 sites —
none carries untrusted bytes. But do NOT blanket-trust: the change is "render
the content string," and the content still flows through `redactToolResult`
(the 8k backstop) exactly like the success path, and any tool that puts
untrusted bytes in a failure `content` would already be wrapping them
(`wrapUntrusted`) — audit the 27 sites to confirm none needs a fence (they're
all short authored sentences; confirm and note).

### Alternative considered (rejected)

"Just fix the 27 sites to put the prose in `error`." Rejected: `error` is also
the audit/classify key and the UI failure-chip source; overloading it with a
full sentence muddies the code taxonomy and the `failure-classify.js` regexes.
Keeping code + content separate and JOINING them at the render seam is one
edit vs. 27, and preserves the structured code everywhere else.

## 2b. `tool_failed` audit almost never fires

### The bug

`dispatcher.js:381-391` audits `tool_executed` on the non-throw path
UNCONDITIONALLY — it never checks `result.ok`. `tool_failed` is emitted only in
the `catch` (`:426-429`), i.e. only when `tool.execute()` THROWS. But across
`tools/defs/`, there are **348 `{ok:false}` return sites in 68 files vs. exactly
1 file that throws.** So virtually every tool error is audited as a SUCCESS.

Consequences: the Activity page's "Issues (blocked/denied/failed)" filter
(`options/sections/activity.js`) shows the user almost no tool failures; and
any Hermes-style error-class mining from the audit log reports ≈zero errors.
The transcript's `is_error` flag is the accurate source; the audit log lies.

### The fix

In the non-throw branch (`dispatcher.js:383-391`), branch on `result.ok`:
- `result.ok === false` → audit `tool_failed` with
  `{ tool, primitive, dispatch, durationMs, error: result.error }` (carry the
  same rich fields the success path has — the audit gap noted that
  `tool_failed` today lacks `primitive`/`durationMs`; fix that here too so
  BOTH failure sources are uniform).
- `result.ok !== false` → `tool_executed` as today.

Keep the `catch` path's `tool_failed` (for genuine throws) and enrich it with
`durationMs` (already computed at `:418`) + `primitive` for parity.

Also fold in the synthesized-failure gap: dispatch-deadline / abort failures
built at `agent-loop.js:827-834` bypass the dispatcher audit entirely. Emit a
`tool_failed` (kind `aborted`/`timeout`) for those at that seam so the audit
log matches the transcript's `is_error`. (Scope check: if this is more than a
few lines, split it to a follow-up and note it — the dispatcher fix is the
80%.)

### Provenance / security

Audit entries are local, append-only, hash-chained. Adding a `tool_failed`
with `error: result.error` writes the (tool-authored) error string into the
audit `details` — same class as the existing `tool_failed` catch path. No new
untrusted content enters the chain (the error string is tool-authored; if a
tool ever put untrusted bytes in `.error` that's a pre-existing issue, out of
scope). No behavior change to gates or dispatch — audit is observe-only.

## Touch points

| File | Change |
|---|---|
| `extension/peerd-runtime/loop/agent-loop.js` | 2a: prefer `content` on the failure path (`:859-863`); 2b (optional): emit `tool_failed` for synthesized deadline/abort failures (`:827-834`) |
| `extension/peerd-runtime/tools/dispatcher.js` | 2b: branch the non-throw audit on `result.ok`; enrich both failure audits with `primitive`+`durationMs` |
| (verify) the 27 `ok:false…content` sites | confirm none needs `wrapUntrusted`; no code change expected |

## Tests

- **Bun**: dispatcher — a tool returning `{ok:false, error:'x'}` audits
  `tool_failed` (not `tool_executed`), with `primitive` + `durationMs`
  present; a throwing tool still audits `tool_failed`; a success still audits
  `tool_executed`. The dispatcher already has a Bun test file — extend it.
- **Bun**: the loop render — given a failed dispatch with `content`, the
  model-visible block is `code: content`; without `content`, it's the code
  alone; a success is unchanged. (Pure over the block-builder; may need a tiny
  extraction if the seam isn't independently testable.)
- **In-browser**: the Activity page now shows a `tool_failed` row after a
  declined confirmation (end-to-end through the real audit log).

## Measurement (design 5)

2b is a precondition for audit-log mining. After it, `tool_failed` rows per
tool become a real histogram — design 5 and the local analyzer both read it.
2a's win shows up as fewer wasted retry turns on decline/denied paths
(design 5's wasted-turn metric).

## Open questions

1. Should 2a JOIN as `code: content` or render `content` alone with the code
   in a structured field the UI already shows? Recommend `code: content` in
   the model-visible text (the model reads text, not our meta fields).
2. 2b synthesized-failure audit (deadline/abort) — same PR or follow-up?
   Recommend: include if ≤10 lines; else follow-up, noted.
