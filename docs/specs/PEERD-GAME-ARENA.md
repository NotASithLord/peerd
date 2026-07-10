# peerd game arena — trustless agent-vs-agent games as dwapps

> Status: **accepted, MVP in flight.** The design for competitive /
> collaborative games between peerd agents over the mesh: one reusable
> **game-dwapp framework** (which includes the tournament machinery), a
> **rules module** per game, and **content** (puzzles) inside a game's
> dwapp. First game: the **puzzle race**, shipping on the web demo surface
> (see `docs/specs/PEERD-WEB-SURFACE.md`). This document is the design
> rationale; the code under `extension/peerd-runtime/game/` is the spec of
> record for live behavior.

---

## 1. What this is

dwapps are extensions of an agent's capabilities — app + mini-harness +
skill (the dwapp-actor work made that literal: an installed dwapp can BE a
specialized actor). A **game** is the same idea pointed at other agents:
a dwapp two or more agents install and then *play against each other over
the mesh*, with no server, no referee, and no trust in the opponent.

The demo narrative this serves, end to end: *here's the agent web, it's
visual, you can see who you connect to. Now that we're connected, we're
discovering dwapps — including games. Download this game. Done — let's
play it, all p2p. You can trade these dwapps back and forth; they're
extensions of your actor mesh, and they can even be competitive or
collaborative games.*

## 2. The two layers (and what goes where)

The layering rule, converged with the owner: **the tournament machinery is
part of the game framework** — matchmaking, commit–reveal, the match log,
verification, leaderboards, the arena UI are boilerplate every game reuses.
Only things that are genuinely *general peerd capabilities* (useful far
beyond games) are core primitives. A specific game is a **rules module**;
its puzzles/scenarios are **content inside that one game dwapp**, never
per-puzzle dwapps.

```
content        puzzles / scenarios (data + pure generator code)      ── inside the game dwapp
rules module   one game's meta + derive + check/score                ── per game
game framework match protocol, commit–reveal, match log, verify,     ── reused by every game
               matchmaking, leaderboard, arena UI  (the "tournament machinery")
core peerd     identity/signing, direct channel, gossip/presence,    ── already shipped
               content addressing, dwapp meta/library/discovery,
               sealed worker, a2a correlation
```

### Core primitives reused as-is

- **did:key identity + Ed25519 signing** — `peerd-distributed/identity/`.
  Every match message is attributable and non-repudiable.
- **Signed 1:1 direct channel** — `peerd-distributed/messaging/direct.js`.
  The match wire. The mesh authenticates the sender, so the protocol can
  bind replies to a did (the same property `actor/a2a-dispatch.js` leans on).
- **Gossip + presence** — `peerd-distributed/gossip/`. Matchmaking roster
  (who's playing, which games they hold) and leaderboard fan-out.
- **Content addressing + signed dwapp cards** — `peerd-distributed/apps/meta.js`,
  `library.js`, `discovery.js`, `content/`. A game dwapp is discovered,
  fetched, and hash-verified like any dwapp. Crucially: **the content hash
  of the game dwapp is the rules commitment** — two players confirm they
  hold byte-identical rules before a match starts by comparing the card's
  content address.
- **The sealed worker** — the Notebook substrate (realm-sealed: no
  fetch/XHR/WS, no DOM). Peer-authored rules code and puzzle solving both
  run ONLY here. This is the verifiable-compute referee: same
  content-addressed code + same inputs ⇒ same verdict on both machines.
- **a2a correlation** — `peerd-runtime/actor/a2a-dispatch.js` is the
  pattern the match driver copies: a pure core with every IO surface
  injected, so the protocol is unit-testable with fakes.

### New core primitives — specified here, NOT built in the MVP

The puzzle-race MVP deliberately needs **none** of these; they harden and
generalize the arena later, and each is a general capability (hence core,
not framework):

1. **Verifiable shared randomness (N-party beacon).** The framework ships
   a 2-party commit–reveal seed (each side commits a nonce, reveals after
   both commits; seed = hash of both nonces — neither side can steer it).
   The core primitive is the N-party generalization with dropout handling,
   useful for lotteries, sampling, and any multi-party fairness — not just
   games.
2. **Signed mergeable shared state (CRDT).** MVP leaderboards are
   per-peer aggregations of signed match results heard on gossip
   (grow-only, first-write-wins per match id — a co-signed result is
   immutable, so duplicates and replays simply drop). The core primitive
   is a general signed-CRDT layer for any dwapp state.
3. **did:key reputation.** Win/loss and forfeit history accumulate into a
   portable, self-certifying reputation. Deferred entirely; it changes
   incentives, not mechanics.

A fourth (BFT/anti-equivocation ordered event log) stays on the far
backlog: only large contested free-for-alls need it, and the framework
dodges it by making every MVP interaction **pairwise and co-signed**.

## 3. Trustless invariants (what makes a match believable)

Each mechanism answers one specific attack:

| Invariant | Mechanism | Defeats |
|---|---|---|
| Neither player picks the puzzle | 2-party commit–reveal seed → puzzle derived deterministically from the joint seed | opponent pre-solving a chosen puzzle |
| Answers are simultaneous | commit `hash(answer ‖ salt)` first; reveal only after both commits | copying the opponent's answer; deciding after seeing theirs |
| The verdict needs no referee | scoring is a **pure reducer** over the two signed transcripts, run in the sealed worker on both machines | "the scorer cheated" — there is no scorer |
| Results are non-repudiable | every protocol message is sender-signed (direct channel); the final result record is **co-signed** by both players | denying a loss; forging a win |
| Rules are agreed | dwapp content hash exchanged in the handshake must match | playing against modified rules |
| A stalling opponent can't hang you | per-phase deadlines in the reducer; a timeout forfeit re-derives from the transcript (the verifier replays the deadline) | griefing by silence |
| A leaderboard can't be poisoned by fiat | entries are verifiable match results (co-signed), aggregated locally per peer, and **scoped per rules-hash** — a rigged game co-signs "wins" happily, so it only ever poisons its own board, never another game's standings | fake standings; rigged-rules laundering |

What this does NOT solve (known, accepted): a player can run arbitrary
compute to solve faster (that's the game); wall-clock timing between
mutually-distrusting machines is only *bounded*, not exact — which is why
game #1's verdict is decided by an **objective score recomputed from the
revealed answer** (§5), never by timing claims (the framework keeps a
commit-order tie-break as a generic fallback, but a game that relies on it
inherits its honesty bound: an order lie can downgrade a loss to a draw);
and hidden-state games (mafia/imposter) need mental-poker crypto or a
committed ephemeral narrator (a dwapp-actor GM whose transcript is
committed and revealed post-game) — explicitly out of scope for game #1.

## 4. The game-dwapp boilerplate (framework contract)

The framework splits across the dependency graph like everything else in
peerd: the **protocol pieces** (commit–reveal, reducer, log, driver) are
core code under `extension/peerd-runtime/game/`; the **host wiring** —
matchmaking over presence, the leaderboard plane, the arena UI — lives with
the host (today `web/public/web/arena.js`; the extension's dweb actor is
the later host). Both layers are "the game framework" in §2's sense — a
new game reuses all of it — but only the protocol pieces are
host-agnostic. House pattern throughout (functional core, injected IO —
the files themselves are the live surface):

- **commit–reveal** — pure helpers: commit a value with a salt, verify a
  reveal against a commit, combine nonce reveals into a match seed.
- **match reducer** — a pure state machine over signed protocol messages:
  `challenge → accept (rules-hash check) → seed (commit, then reveal) →
  solve → commit → reveal → verify → result`, with per-phase deadlines and
  forfeit transitions. Values in, values out; every transition either
  advances the match or names the violation.
- **match log** — the append-only transcript of exchanged signed messages
  plus the co-signed result record; `verify` replays the log through the
  reducer + the rules module and must re-derive the same outcome. Anyone
  holding the log and the game dwapp can audit a match.
- **match driver** — the imperative shell (the `makeMeshDispatch` twin):
  every IO surface injected (the wire send, the rules runner, the solver,
  the result signer/verifier, the accept policy, the clock and timers — the
  live parameter list lives in `match-driver.js`), drives a live match,
  emits UI events. No `chrome.*`, no dweb imports — the host (web shell
  today, the extension's dweb actor later) wires the mesh in.

A **rules module** is what a game author writes (and what ships inside the
game dwapp as content-addressed code, executed only in the sealed worker).
The contract of record is the header of the reference module
(`web/public/web/games/puzzle-race.js`); its shape: a plain script — no
imports, no exports, no host access — whose last binding is `const rules`,
with `rules.meta` (id / name / version / description),
`rules.derive(seedHex)` (deterministic: joint seed → the puzzle, which is
the game's content), `rules.check(seedHex, answer)` (a pure verdict that
*re-derives* from the seed — that re-derivation is what lets any verifier
audit with nothing but the seed and the answer), and `rules.solve(challenge)`
(a *reference* solver — content like everything else; a competitor may bring
a better one). `derive`/`check` must be deterministic and side-effect-free —
the reducer treats them as math; `solve` may randomize (that's the race).

## 5. Game #1: the puzzle race (v2: the mining race)

Two agents, one joint seed, a **fixed solve window**: whoever holds the
best answer when the window closes wins. Chosen first because it has **no
hidden state** — every trustless invariant in §3 covers it with zero new
crypto.

- **The objective is IN the answer** (the v2 fairness fix): the puzzle is
  "minimize `fnv1a32(tag:n)`" — the score is recomputed from the revealed
  answer by any verifier, so the winner is decided by pure math, not by
  anyone's claim. v1 was "first correct commit," which leaned on each
  side's self-reported arrival order (honesty-bounded: a liar could
  downgrade a loss to a draw). v2 removes timing from the verdict
  entirely: search harder in the window → lower hash → higher objective
  score; committing early just means you searched less. Exact score ties
  are ~2⁻³². The framework's commit-order tie-break survives as a generic
  fallback for future games, but game #1 no longer touches it.
- **Puzzles are content**: the generator + objective live inside the one
  puzzle-race dwapp; new puzzle kinds are a content update (a new bundle
  hash), never a new dwapp.
- **Two ladders, later**: solvers (win races) and creators (author puzzle
  packs others race on). MVP ships the solver loop; creator submissions
  ride the same dwapp-share path and are a content update, not new
  machinery.
- **Solving is the competitor's business**: the demo's auto-player runs
  the dwapp's reference solver as sealed-worker bursts (best-so-far shown
  live — the opponent's stays sealed until reveal, which is commit-reveal
  giving the UI an honest dramatic beat for free); a model or a stronger
  hand-written solver just replaces the burst loop.

## 6. MVP scope (the web demo slice)

Ships on the peerd-lite page (`web/public/`), on the isolated demo lobby —
never the production base network:

1. **Arena surface** — a tab in the emulated browser: discover games,
   install, challenge a peer, watch the phases (seed → commit → reveal →
   verdict) live, lobby leaderboard.
2. **Share → discover → install, for real** — the sharer announces a
   signed game card on the lobby; the installer fetches the bundle over
   the direct channel and **hash-verifies it against the card** before
   accepting (single-DM transfer at MVP size; the chunked `content/`
   transfer takes over when bundles outgrow a DM).
3. **Auto-accept + auto-solve** — a demo peer accepts challenges and
   solves in its sealed worker, so two tabs demo the whole arc; a loaded
   local model can play instead.
4. **Framework + rules split honored from day one** — the arena UI talks
   only to the framework driver; the puzzle-race rules module is content
   the driver loads into the sealed worker.

Deferred beyond the MVP: the three core primitives (§2), extension-side
arena (the dweb actor hosting matches headlessly), creator ladder,
multi-party games, hidden-state games, reputation-weighted matchmaking.

## 7. Security posture

- **Peer-authored code never touches the page.** Rules modules and
  puzzle generators from an installed dwapp execute exclusively in the
  sealed worker (no network, no DOM, no `chrome.*`), the same substrate
  the notebook already trusts for untrusted code.
- **Every inbound protocol message is untrusted input** to a pure reducer
  that validates sender-binding (mesh-authenticated did), phase, deadline,
  and signature shape before any transition; malformed input names a
  violation, it never throws mid-match.
- **The demo lobby is isolated** (`peerd/demo/1` namespace) with demo
  auto-consent between demo agents — honest to the real first-contact
  gate, pre-cleared, exactly as the existing agent-mesh demo does.
- **No new egress**: everything rides the existing mesh transport; the
  rendezvous server stays introduction-only.

## 8. Open questions

- Whether the N-party beacon should subsume the framework's 2-party seed
  once built (likely yes; the framework keeps the seed *interface*).
- Where match logs live long-term (session-scoped now; content-addressed
  archives would make ladders portable).
- Anti-grind identity cost for ladders (did:key is free to mint; the
  reputation primitive owns this).
