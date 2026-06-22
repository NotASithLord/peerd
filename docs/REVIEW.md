# Clean-context review (feature 08)

> Settled design intent for the review subagent. Companion to
> `docs/SUBAGENTS.md` — review is built ON the subagent machinery, not
> beside it.

## The claim

**A reviewer with a clean context catches what the author rationalized
past.** The writer agent carries the reasoning that produced a bug; a
second agent that sees ONLY the diff — never the conversation — is a
genuine fresh pair of eyes (Cognition's clean-context review; Amp's
oracle).

Review is not a new engine kind and not a new orchestrator. It is the
`spawn_subagent` primitive, called with:

- the **diff** as the task (the reviewer's entire context),
- a **read-only** tool subset (the reviewer cannot edit), and
- a required **structured output** the parent acts on programmatically.

## Why read-only is non-negotiable

peerd is single-threaded for writes: only the writer edits. A reviewer
that could click/type/navigate/run code would be a second writer racing
the first — and, because it reads the diff (possibly untrusted web content
the writer pulled in), a lethal-trifecta amplifier. Read-only removes the
third leg of the trifecta and preserves the single-writer invariant.

Enforced twice: the reviewer is *granted* only `sideEffect:'read'` tools
(what it sees), and a dispatch guard refuses any non-read call at call time
(what it can do, fail-closed).

## The structured summary

```json
{
  "verdict": "approve | request_changes | comment",
  "severity": "critical | high | medium | low | info",
  "summary": "one paragraph",
  "issues": [{ "severity", "title", "detail", "location", "fix" }]
}
```

`severity` is derived from the worst issue; an over-optimistic `approve`
with a high+ issue is coerced to `request_changes`. Parsing is tolerant —
a malformed reviewer never crashes the parent's turn.

## Two surfaces

| Surface | Caller | Use case |
|---|---|---|
| `request_review` tool | the model | "I finished a change; get a second opinion before I move on." |
| `review/run` SW route | `/review` command, sandbox `peerd.review()` | user/programmatic invocation over snapshots or a checkpoint diff |

Both route through one bound `requestReview`, which routes through the one
bound `spawnSubagent`. Same audit, same gates, same trust inheritance.

## Diff sources

1. explicit `before`/`after` file-tree snapshots → diffed standalone;
2. an explicit `diff` changeset;
3. `checkpoints.diffSince(since)` (feature 02) when wired.

## Browser-native review

The reviewer's read-only tools include `read_page`, `query_dom`, and
`app_read_file`. For an App change it can open the changed App in its
sandboxed iframe and inspect the running DOM/console — reviewing the
*artifact*, not just the diff text. That's the peerd edge a terminal
reviewer can't reach.

## Specifically NOT to do

- A reviewer with write tools (breaks single-writer + trifecta defense).
- A separate review orchestrator (reuse `spawnSubagent`).
- Auto-applying the reviewer's fixes (the writer applies; review reports).
- Trusting the model's self-reported severity over the derived one.
