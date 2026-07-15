# Adaptive per-origin action pacing — design spec

> Status: **PROPOSED — for review.** This is the concrete design that
> resolves `ANTI-BOT-POSTURE.md` **Option 0** (human-cadence pacing) in a
> specific direction: not a blanket setting and not a hardcoded site list,
> but a **learned, per-origin, self-adapting** rate limiter that lives in
> **code, not prompt**. Companion to `ANTI-BOT-POSTURE.md` (which frames the
> whole posture) and `OPEN-DECISIONS.md`.

## The idea, in one paragraph

peerd starts with **no** action pacing anywhere — every origin runs at full
speed. When the web actor *observes* that a site pushed back (a 429, a
velocity/CAPTCHA wall, a "you're going too fast" interstitial), peerd writes
a small persistent **rule** for that origin: *"actions at ~this cadence got
us blocked → hold at least this long between actions here."* The rule is a
number in a store, not a sentence in a prompt. It **sticks to the origin**,
so every future web-actor session that touches that origin inherits it. And
it **decays**: after a long quiet stretch peerd relaxes the rule (or the
agent deliberately probes it) to find out whether the site still cares — so
a one-off block doesn't tax an origin forever.

The whole thing is a control loop: **observe → learn → enforce → decay/probe**,
with the model in the loop only for the occasional deliberate tweak.

---

## Why this shape (the constraints it satisfies)

| Constraint (owner direction) | How the design meets it |
|---|---|
| **Code, not prompt** | Enforcement is an `await`-ing pre-tool-use hook; the "rule" is a persisted numeric record. The model neither sees nor drives the per-action delay. |
| **Learned, not hardcoded** | Rules are *created from observed blocks*. The shipped seed is **empty** — no site list to maintain as protections drift. |
| **Targeted, not blanket** | Default `minIntervalMs = 0` for every origin. Pacing only ever applies to **action** tools on an origin that *earned* a rule. Reads are never paced; un-flagged sites pay nothing. |
| **Self-adapting** | A block escalates the interval (sized from the speed that actually got blocked); quiet time decays it back toward zero. |
| **Persistent, per-origin** | The rule lives in `peerd-egress` storage keyed by origin, read at each dispatch — so a brand-new actor session for that origin is paced from its first action. |
| **Agent can tweak, temporarily** | A small bounded, audited tool lets the web actor / orchestrator read the rule, force a staleness **probe**, set an interval it has a real signal for, or clear it. It tweaks a *variable*, it does not re-implement pacing in prose. |

**The floor is "off."** This is the honest inversion of a blanket pacer: the
system does nothing until a site tells us, in its own response bytes, that it
minds.

---

## Where it plugs into peerd (two existing chokepoints)

peerd already has the exact two seams this needs — the **pre/post tool-use
hook** pipeline (`peerd-runtime/tools/hooks/`), the same load-bearing policy
layer the egress allowlist rides. No new dispatch machinery.

### Enforcement — a default PRE-tool-use hook (`web-pace`)

Pre-tool-use hooks may return `allow | block | modify`, **and they can be
async** (`Promise<HookDecision | void>`). That last fact is the whole trick:
a hook that `await`s before returning `allow` *is* a rate limiter. So:

- **Scope by tag, not by name list.** Pace exactly the web **action** tools:
  `primitive:'tab' && sideEffect:'write'` — today that's `click`, `type`,
  `navigate`, `page_keys`. Reads (`sideEffect:'read'`: `snapshot`,
  `read_page`, `query_dom`, `read_state`) are exempt by construction, so
  observing a page is always free. (Open question C: whether a same-origin
  session `fetch_url` POST should also be paced.)
- **Key by the tab's origin.** `ctx.activeTab.origin` is already resolved
  SW-side in `buildToolContext`; the hook reads the rule for that origin from
  its injected store.
- **First action free; delay is a catch-up, not a fixed tax.** The wait is
  `max(0, (minInterval + jitter) − (now − lastActionAt))`. Back-to-back
  clicks get spaced; an action that naturally followed a slow read waits
  little or nothing.
- **The sleep is abort-aware.** It races `ctx.abortSignal` (the same signal
  plumbed by the hung-dispatch fix, #205, and the a2a abort work, #207), so
  Stop / the turn timeout unwinds a paced action instead of parking it. A
  pace wait is also bounded well under the dispatch deadline.

### Detection — a default POST-tool-use hook (`web-pace-observe`)

Post-tool-use hooks see the `ToolResult` but can't change it — exactly right
for *learning without interfering*:

- Match web tools; scan the result for a **block signal**:
  - HTTP **429 / 403** and a **`Retry-After`** header (`fetch_url` already
    returns `status` + `headers`; a same-origin XHR the DOM tools surface can
    too).
  - **Challenge / verification DOM signatures** for the major vendors
    (reCAPTCHA / Turnstile / DataDome interstitials) — a detector, reused
    from Option 1's hand-back work.
  - Explicit **rate-limit text** ("try again later", "unusual activity",
    "you're doing that too much").
- On a hit, feed the origin's rule through the escalation reducer and
  **persist** it, and append an **audit** entry (lineage: which origin, what
  signal, old→new interval).

Both hooks run **SW-side** during `actor/tool-dispatch`, i.e. *inside the
trusted shell, behind the actor-heap fence*. The offscreen worker can neither
observe nor bypass the limiter, and none of it is ever surfaced to the model
as prompt or to skills. That's what "in code, not prompt" buys: an untrusted
reasoning heap can't talk peerd out of pacing.

---

## The persisted state

One record per origin, stored in `peerd-egress` (mirroring the denylist
store's IDB pattern), so it survives SW eviction and binds every future
session. Illustrative shape — **field set is the contract; the numbers are
seeds that live in code, not doctrine:**

```js
// peerd-egress/pace/pace-rule.js (proposed)
/**
 * @typedef {Object} PaceRule
 * @property {string}  origin          // the key (see Open Question A: exact vs eTLD+1)
 * @property {number}  minIntervalMs   // 0 == effectively no rule (the default)
 * @property {number}  jitterFrac      // e.g. 0.3 → ±30% so timing isn't uniform (uniform IS a tell)
 * @property {number}  observations    // how many blocks have fed this rule
 * @property {number}  lastBlockAt      // ms; drives decay eligibility
 * @property {number}  lastDecayAt
 * @property {number}  createdAt
 * @property {number}  updatedAt
 * @property {'learned'|'retry-after'|'agent'} source
 * @property {null | { trialMs: number, until: number, prevMinIntervalMs: number }} probe
 */
```

Plus a small **ephemeral, in-memory** per-origin tracker (not persisted —
losing it just means the next first action isn't paced):

- `lastActionAt` — for the catch-up delay.
- a short ring of recent **inter-action intervals** — so that at block time
  we know *how fast we were actually going*, and can back off relative to the
  speed that got us blocked rather than by a blind constant.

---

## The pure core (functional core, injected IO)

All the policy is pure reducers over `(rule, signal, now)` — no storage, no
clock, no `Math.random` inside. The clock and RNG are injected, so every
transition is deterministic under Bun. Signatures (bodies omitted; the code
is the spec once written):

```js
// peerd-runtime/web-pace/reducer.js (proposed) — PURE

/** A block was observed → escalate, sized from the speed that got blocked. */
nextRuleOnBlock(rule, { recentIntervalMs, retryAfterMs, now }, K) → PaceRule
// minIntervalMs = clamp(
//   max(rule.minIntervalMs * K.growth,        // multiplicative on repeats
//       recentIntervalMs   * K.slowdownMult,  // "we were doing X and got blocked → go slower than X"
//       retryAfterMs ?? 0),                    // honor an explicit server ask
//   0, K.maxPaceMs)                            // never silently sleep for minutes (see below)
// observations++, lastBlockAt = now, probe = null

/** Time passed with no block → relax toward zero (a one-off block self-heals). */
decay(rule, now, K) → PaceRule
// if (now - rule.lastBlockAt) > K.quietMs && !rule.probe:
//   minIntervalMs *= K.decay ; retire (delete) once it falls under a floor

/** The per-action delay. First action (no lastActionAt) → 0. */
waitForAction(rule, lastActionAt, now, rng) → ms
// max(0, (minIntervalMs + jitter(minIntervalMs, jitterFrac, rng)) - (now - lastActionAt))

/** Staleness test: temporarily drop to a trial interval for a bounded window. */
startProbe(rule, trialMs, windowMs, now) → PaceRule
resolveProbe(rule, blockedDuringProbe, now, K) → PaceRule
// blocked  → snap back to prevMinIntervalMs, re-escalate, reset quiet timer
// clean    → adopt the lower trial value (maybe retire the rule entirely)
```

`K` is the tunables bundle (growth, decay, quietMs, slowdownMult, maxPaceMs,
jitterFrac, floor). **Per house rules these live in a constants/settings
module, not in this prose** — the values here are only to show the shape of
the arithmetic.

---

## The self-adaptation lifecycle

```
        no rule
        (minInterval = 0, full speed)
           │  first block observed
           ▼
   ┌─────────────────┐   repeat block    ┌──────────────────────┐
   │  PACED           │ ────────────────▶ │ PACED (higher)        │
   │  interval sized  │                   │ multiplicative growth │
   │  from the block  │ ◀──────────────── │ bounded by maxPaceMs  │
   └─────────────────┘   quiet: decay     └──────────────────────┘
           │  quiet period elapses / agent asks
           ▼
   ┌─────────────────┐   block recurs     snap back + re-escalate
   │  PROBING         │ ─────────────────▶ (reset quiet timer)
   │  trial interval  │
   │  for a window    │   window clean → adopt lower value
   └─────────────────┘ ─────────────────▶ decay continues → RETIRED (rule deleted)
```

- **Escalation is informed, not blind.** A first block sets the interval from
  the cadence that actually tripped it (times a slowdown multiplier), so we
  land near the right speed in one step instead of ramping through many
  blocks.
- **Decay is automatic.** A site that rate-limited us once during a burst but
  doesn't otherwise care will see its rule shrink and eventually **retire**
  itself — no manual cleanup, no permanent tax.
- **The ceiling is a hand-off, not a nap.** If the required interval would
  exceed `maxPaceMs` (a site wants us *much* slower, or its `Retry-After` is
  minutes), the limiter does **not** silently sleep — it escalates to the
  posture ladder: surface a challenge/hand-back (Option 1) or drop the origin
  to **assist-only** (Option 6). Pacing is for shaving seconds, not for
  stalling a turn for five minutes.

---

## The agent control surface (bounded, optional)

The common case is fully automatic — no tool call needed. The tool exists for
the **deliberate** tweak the owner described ("if the rule's been established
a long time, the actor may decide to test whether it's still needed"):

```
pace_rule({ action: 'get' | 'probe' | 'set' | 'clear', origin?, minIntervalMs? })
```

- **get** — introspect the current rule (so the actor can *reason and report*:
  "I'm pacing X because it 429'd us twice; want me to test if it still does?").
- **probe** — force a staleness test *now* (start a probe window at a low trial
  interval). This is the agent-initiated half of decay.
- **set** — a manual interval when the agent has a **real** signal: a site's
  `Retry-After: 30`, or the user saying "slow down on this one." Clamped to
  `[0, maxPaceMs]`.
- **clear** — retire a rule the agent is confident is stale.

Properties that keep it honest:

- **Web-actor / orchestrator only**, exposed like any actor tool; the worker's
  args are **re-checked SW-side** and never trusted (same defense as every
  relayed actor call).
- **Bounded + audited.** Every set/probe/clear is clamped and appended to the
  audit log with its origin and reason. The agent adjusts a number within a
  fixed range — it cannot invent a new pacing mechanism, disable the limiter
  globally, or *speed past* the user's intent.
- **Not a prompt behavior.** The tool mutates the same persisted record the
  automatic loop uses; there is exactly one limiter, and it's in code.

---

## Scope, persistence, and the fence

- **Origin-keyed**, persisted in `peerd-egress` IDB → survives SW restarts and
  **binds every future web-actor session** for that origin. This is the
  "sticks to the origin" requirement: a fresh session doesn't relearn from
  scratch.
- **State lives SW-side (trusted).** The offscreen actor heap never holds or
  controls the rule; the model never receives it as prompt; skills can't read
  it. Not channel-gated, not dweb — this is core web-actor safety, on every
  build.
- **Composes with the posture ladder.** The limiter is the "automate, but
  paced" rung of Option 6; its ceiling is where a site graduates to
  hand-back / assist-only.

---

## What it deliberately does NOT do

- **No blanket pacing.** Zero cost on un-flagged origins; reads never paced.
- **No shipped site list.** Rules are learned; the only seed is empty. Sites
  and their protections drift — this design *follows* that drift instead of
  chasing it whack-a-mole.
- **No fingerprint / UA spoofing, proxies, or CAPTCHA-solvers.** The
  `ANTI-BOT-POSTURE.md` reject list stands; this changes *cadence* only and
  preserves peerd's naturally-clean real-session fingerprint.
- **No silent multi-minute sleeps.** Bounded by `maxPaceMs`; past that it hands
  off, it doesn't stall.

---

## Open questions (decide before / during build)

- **A. Origin granularity.** Exact origin, or registrable domain (eTLD+1)? A
  velocity wall often spans subdomains (login vs app), arguing for eTLD+1; but
  eTLD+1 over-paces unrelated subdomains. Proposal: start **exact-origin**,
  add an opt-in domain roll-up if field data shows walls crossing subdomains.
- **B. Should `fetch_url` be paced at all?** Cross-site `fetch_url` is
  sessionless and cheap; probably pace only **tab actions** + same-origin
  **session** POSTs, leaving public GETs unthrottled.
- **C. Decay cadence.** Lazy (recompute on next access to that origin) vs a
  periodic sweep. Lazy is simpler and avoids a timer; proposal: **lazy**.
- **D. Probe visibility.** Does a probe warrant a subtle UI note ("testing
  whether SITE still rate-limits")? Leaning yes for transparency, no for a
  fully silent background decay.
- **E. Profile scope.** Per-profile rules (rides the Profiles backlog item) or
  global? Proposal: per-profile once profiles land; global until then.
- **F. Seed constants.** `growth`, `decay`, `quietMs`, `slowdownMult`,
  `maxPaceMs`, `jitterFrac`, retire-floor — start conservative, tune from the
  eval harness + field reports. Values live in code.

---

## Test plan

- **Bun (pure core).** The reducers with an injected clock + RNG: a block
  escalates from the observed cadence; repeats grow (bounded); quiet decays
  and eventually retires; `waitForAction` gives 0 on first action and stays
  within the jitter band; probe transitions (clean adopts, blocked snaps back
  and re-escalates). Deterministic, <1s.
- **In-browser (the hooks).** Wire both hooks into a fake dispatch: a
  simulated 429 result writes a rule; a subsequent `click` on that origin is
  delayed while a `snapshot` is not; a fresh actor session for the same origin
  inherits the rule; **Stop unwinds a paced sleep** (abort-signal race).

---

## Relationship to `ANTI-BOT-POSTURE.md`

This spec is the concrete resolution of **Option 0's `DECISION:` line** —
replacing the "blanket setting + default hook" sketch with a learned,
per-origin, self-adapting limiter that defaults to *off*. It is also the
"automate, paced" rung that **Option 6** (site-posture tiers) escalates out
of at its ceiling, and it dovetails with **Option 1** (challenge hand-back) as
the ceiling response. It changes nothing about the rejected techniques.
