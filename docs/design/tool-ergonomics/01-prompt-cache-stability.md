# Design 1 — prompt-cache stability: stop the temporal block from busting the system cache

## The bug

The provider wire puts the entire system prompt in ONE text block with a
single `cache_control:{type:'ephemeral'}` breakpoint at its end
(`extension/peerd-provider/adapters/to-anthropic.js:535-541`), plus a second
breakpoint on the last tool (`:551-566`). Anthropic's cache is prefix-keyed in
order tools → system → messages.

But `renderSystemPrompt` substitutes `{{TEMPORAL_BLOCK}}` with
`<time>now <ISO-8601-with-seconds> …</time>` (`clock/context.js:71-80`) at
template line 265 of 307 — **inside** the cached system block, and it changes
every turn (seconds resolution). So the ~4,757-token system block is a cache
MISS on every turn, forever. If the user has AGENTS.md memory loaded (also in
the system block, above the temporal line), that's ~8,000+ tokens re-billed at
full input price per turn instead of the 10% cache-read rate.

A code comment at `loop/system-prompt.js:159-160` claims the volatile
`<active_tab>` tail sits "after all cache breakpoints." There is no breakpoint
after it — the whole string is one block. The comment is aspirational, not
true.

## Why it matters most

This is pure money, every turn, for every user, on every provider that
supports prompt caching (Anthropic today; the OpenAI-compatible adapters
increasingly do). The static system block is the single largest cacheable
prefix and it never caches. Fixing it is a structural change to WHERE the
volatile bytes live, not new behavior.

## The fix

**Move all per-turn-volatile content OUT of the cached system block and into
the message stream** (or past the final cache breakpoint), so the system
block becomes byte-stable across turns within a session.

Volatile pieces to relocate (all currently inside the system string):
- `{{TEMPORAL_BLOCK}}` — the `now <ISO>` clock (`clock/context.js`,
  wired `turn-driver.js:174-177`).
- `<active_tab>` — the foreground tab URL/title (`system-prompt.js:186-198`).
- The bare `date` line at template line 246-247 (date only, no seconds — this
  one changes at most daily; decide whether it's worth moving).

### Preferred shape: a synthetic leading context turn

The clock already models temporal grounding as *context*, not *identity*.
Emit the volatile block as a synthetic `user` (or system-role, per what the
adapter supports) message injected at the HEAD of the message array each turn
— after the cached system block, before real history. Concretely:

- `renderSystemPrompt` stops substituting `{{TEMPORAL_BLOCK}}` /
  `<active_tab>` into the template; the template keeps a stable placeholder-
  free tail. The system STRING becomes a pure function of
  (channel, memory docs, skills, session instructions) — none of which change
  turn-to-turn within a session (memory/skills change only on explicit edits;
  session instructions are set once).
- `turn-driver.js` builds a small `temporalContext` string and hands it to the
  loop, which prepends it as an ephemeral context message each turn.
- `to-anthropic.js` keeps the system + last-tool breakpoints exactly where
  they are; the new context message lands AFTER them, so it never invalidates
  the cached prefix.

Why a message and not "just move it after the breakpoint in the system
string": Anthropic caches the whole system block up to its breakpoint as one
unit — there is no "system content after the breakpoint" that stays out of the
hashed prefix. The only place genuinely outside the cached prefix is the
message stream. (Alternative considered: a SECOND system block with its own
breakpoint before the volatile part — but multi-block system with a mid-list
breakpoint is fiddlier across adapters than a leading context message, and the
message-stream approach also works for the OpenAI-compatible adapters that
have no system-array concept.)

### Memory block interaction

`{{MEMORY_BLOCK}}` (AGENTS.md) sits in the system template and is re-rendered
every turn but is byte-STABLE within a session (it only changes when the user
edits memory). Once the temporal block leaves, the memory block caches
cleanly. No change needed to memory itself — it's a beneficiary. If memory
CAN change mid-session (a `remember` tool write), invalidating the cache once
on write is correct and cheap; verify whether `remember` writes take effect on
the next turn (it should — a fresh render, one miss, then stable again).

### Correctness guards

- The synthetic context message must be FENCE-NEUTRAL — it's tool-authored
  trusted content (a timestamp + the active tab URL). The active-tab URL is
  low-trust (user's current page) but it's already in the prompt today; no
  regression. Keep it terse.
- Actors: actor turns also render the base template. They get the same
  benefit; confirm the actor prompt path (`system-prompt.js` actor branch)
  also stops embedding volatile bytes.
- The `date` line: if kept in the system block, the cache still busts once per
  UTC-midnight per session — acceptable (a session rarely spans midnight, and
  one miss/day is negligible). Simplest: move the full clock (date+time) to
  the context message and drop the template date line, so the system block has
  zero time-derived bytes. Recommended.

## Touch points

| File | Change |
|---|---|
| `extension/peerd-provider/system-prompt.txt` | drop the `{{TEMPORAL_BLOCK}}` line and the date line; keep the tail placeholder-free |
| `extension/peerd-runtime/loop/system-prompt.js` | stop substituting temporal/active-tab; export a `buildTemporalContext()` (pure); fix the false cache comment at :159 |
| `extension/peerd-runtime/loop/turn-driver.js` | build the context string; pass it to the loop instead of into the system render |
| `extension/peerd-runtime/loop/agent-loop.js` | prepend the ephemeral context message to the outgoing message array each turn |
| `extension/peerd-provider/adapters/to-anthropic.js` | (likely no change — the message just flows through; verify the breakpoints still land on system + last tool, and the context message is after them) |
| `extension/peerd-runtime/clock/context.js` | source of the temporal string (reuse; it's already pure) |

## Tests

- **Bun**: `renderSystemPrompt` output is now byte-identical across two calls
  that differ only in wall-clock (the whole point) — a regression test that
  the system string contains no ISO timestamp. `buildTemporalContext` is pure
  and carries the time. `to-anthropic` mapping: given a system + a leading
  context message, the `cache_control` breakpoints are on the system block and
  the last tool, and the context message carries none (so the cached prefix is
  stable). Assert the system block's text is invariant to the context
  message's content.
- **In-browser / e2e**: a two-turn conversation shows the second turn's
  request reusing the cached system prefix (assert via the recorded request:
  system block bytes identical turn-to-turn; the temporal message differs).
  The e2e verify loop's smoke state already drives two turns.

## Measurement (design 5)

The cost telemetry records `cacheReadTokens` / `cacheWriteTokens` per turn.
The win is directly observable: before, turn 2's `cacheReadTokens` ≈ tools
only (~6k of ~11k); after, ≈ tools + system (~11k). Add a bench assertion or
just read the scorecard's `avgCacheReadTokens` before/after — it should jump
by ~the system-block token count on multi-turn tasks.

## Open questions

1. Context message role: `user` vs a second `system` block vs a dedicated
   ephemeral role — pick what every shipped adapter (anthropic, openai,
   openrouter, glm, ollama) renders cleanly. Recommend a `user`-role message
   with a clear `<context>` wrapper, since all adapters have user messages.
2. Does anything DOWNSTREAM parse the system prompt expecting the temporal
   block in place (tests, snapshots)? Grep and update.
3. Keep the once-daily date in the system block, or move the whole clock out?
   Recommend: move it all out (zero time bytes in system = zero surprise).
