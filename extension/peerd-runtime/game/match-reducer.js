// @ts-check
// peerd-runtime/game/match-reducer.js — the pure state machine of one match.
//
// The trustless core of the game framework (docs/specs/PEERD-GAME-ARENA.md):
// both players run this SAME reducer over the SAME exchanged messages, so the
// verdict needs no referee — a match log replayed through this reducer must
// re-derive the same outcome on any machine. Values in, values out: every
// inbound message is untrusted input that either advances the match or names a
// violation; the reducer NEVER throws mid-match.
//
// why reveals carry a precomputed `revealOk`: checking a reveal against its
// commit is async hashing (commit-reveal.js), and a reducer must stay
// synchronous and pure — so the SHELL (match-driver.js, or the log verifier)
// hashes first and feeds the boolean in. A false revealOk is proof of cheating
// (the reveal doesn't match the commitment) and forfeits the match on the spot.
//
// Phases:  proposed → seeding → solving → revealing → scoring → signing → done
// Any phase can short-circuit to done via decline / resign / timeout / cheat.

/** Wire tag — a game message is `{ __game: 1, matchId, type, ... }`. */
export const GAME_WIRE_TAG = '__game';

/** @param {unknown} d @returns {d is { __game: 1, matchId: string, type: string } & Record<string, any>} */
export const isGameMessage = (d) =>
  !!d && typeof d === 'object'
  && /** @type {any} */ (d).__game === 1
  && typeof (/** @type {any} */ (d).matchId) === 'string'
  && typeof (/** @type {any} */ (d).type) === 'string';

// Per-phase durations (ms) — how long the match waits in a phase before
// applyTimeout forfeits/aborts it. Overridable per match via the challenge.
export const DEFAULT_DEADLINES = Object.freeze({
  proposed: 30_000,   // opponent must accept/decline
  seeding: 20_000,    // both nonce commits + reveals
  solving: 120_000,   // the race itself: solve + commit
  revealing: 20_000,  // both answer reveals
  scoring: 30_000,    // local verdict computation (not a wire phase)
  signing: 20_000,    // co-signature exchange
});

const ACTIVE_PHASES = new Set(['proposed', 'seeding', 'solving', 'revealing', 'scoring', 'signing']);
const MAX_VIOLATIONS = 32;

/**
 * @typedef {{ kind: 'win'|'draw'|'declined'|'aborted', winner?: string, reason: string }} Outcome
 * @typedef {{ at: number, from: string, code: string }} Violation
 * @typedef {{
 *   matchId: string, gameId: string, rulesHash: string,
 *   players: { challenger: string, acceptor: string },
 *   phase: 'proposed'|'seeding'|'solving'|'revealing'|'scoring'|'signing'|'done',
 *   phaseAt: number,
 *   deadlines: Record<string, number>,
 *   seed: { commits: Record<string, string>, reveals: Record<string, { nonce: string, salt: string }>, value: string|null },
 *   answers: { commits: Record<string, { commit: string, at: number }>, reveals: Record<string, { answer: string, salt: string, sawPeerCommitFirst: boolean }> },
 *   verdicts: Record<string, { correct: boolean, score: number }>,
 *   sigs: Record<string, string>,
 *   coSigned: boolean,
 *   outcome: Outcome|null,
 *   violations: Violation[],
 * }} MatchState
 */

/** @param {MatchState} s @returns {number} the current phase's duration budget */
export const phaseDuration = (s) => s.deadlines[s.phase] ?? DEFAULT_DEADLINES.solving;

/** @param {MatchState} s @param {string} did */
const isPlayer = (s, did) => did === s.players.challenger || did === s.players.acceptor;
/** @param {MatchState} s @param {string} did */
const opponentOf = (s, did) => (did === s.players.challenger ? s.players.acceptor : s.players.challenger);
/** @param {MatchState} s */
const bothPlayers = (s) => [s.players.challenger, s.players.acceptor];

/** @param {MatchState} s @param {number} at @param {string} from @param {string} code @returns {MatchState} */
const violate = (s, at, from, code) => ({
  ...s,
  violations: [...s.violations.slice(-(MAX_VIOLATIONS - 1)), { at, from, code }],
});

/** @param {MatchState} s @param {Outcome} outcome @param {number} at @returns {MatchState} */
const finish = (s, outcome, at) => ({ ...s, phase: 'done', phaseAt: at, outcome });

/** A proven cheat (bad reveal) forfeits immediately — the opponent wins.
 * @param {MatchState} s @param {string} cheater @param {string} reason @param {number} at
 * @returns {MatchState} */
const forfeitTo = (s, cheater, reason, at) =>
  finish(violate(s, at, cheater, reason), { kind: 'win', winner: opponentOf(s, cheater), reason }, at);

/**
 * Create a match from an exchanged challenge. Both sides build the identical
 * initial state (the challenger before sending, the acceptor on receipt).
 * @param {{ matchId: string, gameId: string, rulesHash: string, challenger: string, acceptor: string,
 *           deadlines?: Partial<Record<string, number>>, at: number }} args
 * @returns {MatchState}
 */
export const createMatch = ({ matchId, gameId, rulesHash, challenger, acceptor, deadlines = {}, at }) => ({
  matchId, gameId, rulesHash,
  players: { challenger, acceptor },
  phase: 'proposed',
  phaseAt: at,
  // why merged per-match: a game may legitimately want a longer solve window;
  // the CHALLENGE carries the overrides so both sides run identical clocks.
  deadlines: { ...DEFAULT_DEADLINES, ...Object.fromEntries(Object.entries(deadlines).filter(([, v]) => Number.isFinite(v) && /** @type {number} */ (v) > 0)) },
  seed: { commits: {}, reveals: {}, value: null },
  answers: { commits: {}, reveals: {} },
  verdicts: {},
  sigs: {},
  coSigned: false,
  outcome: null,
  violations: [],
});

/**
 * Apply one protocol message (inbound OR our own outbound — the reducer is
 * symmetric). `revealOk` MUST accompany seed_reveal / answer_reveal (the shell
 * verifies the reveal against the stored commit first).
 * @param {MatchState} s
 * @param {{ from: string, at: number, msg: Record<string, any>, revealOk?: boolean }} input
 * @returns {MatchState}
 */
export const applyMessage = (s, { from, at, msg, revealOk }) => {
  if (!isGameMessage(msg) || msg.matchId !== s.matchId) return violate(s, at, from, 'wrong-match');
  if (!isPlayer(s, from)) return violate(s, at, from, 'not-a-player');
  if (s.phase === 'done') return violate(s, at, from, 'match-over');

  switch (msg.type) {
    case 'challenge':
      // The state was CREATED from the challenge; seeing it (log replay, or the
      // wire echo) is a no-op when consistent, a violation otherwise.
      return (s.phase === 'proposed' && from === s.players.challenger) ? s : violate(s, at, from, 'stray-challenge');

    case 'decline':
      if (s.phase !== 'proposed' || from !== s.players.acceptor) return violate(s, at, from, 'stray-decline');
      return finish(s, { kind: 'declined', reason: typeof msg.reason === 'string' ? msg.reason.slice(0, 120) : 'declined' }, at);

    case 'accept': {
      if (s.phase !== 'proposed' || from !== s.players.acceptor) return violate(s, at, from, 'stray-accept');
      // why abort (not forfeit): a rules-hash mismatch means the two sides hold
      // DIFFERENT game code — there is no agreed game to lose.
      if (msg.rulesHash !== s.rulesHash) return finish(violate(s, at, from, 'rules-mismatch'), { kind: 'aborted', reason: 'rules-mismatch' }, at);
      return { ...s, phase: 'seeding', phaseAt: at };
    }

    case 'resign':
      if (!ACTIVE_PHASES.has(s.phase) || s.phase === 'proposed') return violate(s, at, from, 'stray-resign');
      return finish(s, { kind: 'win', winner: opponentOf(s, from), reason: 'resigned' }, at);

    case 'seed_commit': {
      if (s.phase !== 'seeding') return violate(s, at, from, 'stray-seed-commit');
      if (s.seed.commits[from]) return violate(s, at, from, 'duplicate-seed-commit');
      if (typeof msg.commit !== 'string' || !msg.commit) return violate(s, at, from, 'malformed-seed-commit');
      // why the mirror check: echoing the opponent's commit lets a peer replay
      // their reveal too — and know the seed BEFORE sending its own reveal (a
      // solving head start). An honest collision is 2^-256; forfeit the echoer.
      if (msg.commit === s.seed.commits[opponentOf(s, from)]) return forfeitTo(s, from, 'mirrored-seed-commit', at);
      return { ...s, seed: { ...s.seed, commits: { ...s.seed.commits, [from]: msg.commit } } };
    }

    case 'seed_reveal': {
      if (s.phase !== 'seeding') return violate(s, at, from, 'stray-seed-reveal');
      // why reveal-before-both-commits is a violation, not just early: revealing
      // a nonce before the opponent committed lets the opponent steer the seed.
      if (!bothPlayers(s).every((p) => s.seed.commits[p])) return violate(s, at, from, 'seed-reveal-before-commits');
      if (s.seed.reveals[from]) return violate(s, at, from, 'duplicate-seed-reveal');
      if (typeof msg.nonce !== 'string' || typeof msg.salt !== 'string') return violate(s, at, from, 'malformed-seed-reveal');
      if (revealOk !== true) return forfeitTo(s, from, 'seed-reveal-mismatch', at);
      const reveals = { ...s.seed.reveals, [from]: { nonce: msg.nonce, salt: msg.salt } };
      const both = bothPlayers(s).every((p) => reveals[p]);
      return { ...s, seed: { ...s.seed, reveals }, ...(both ? { phase: 'solving', phaseAt: at } : {}) };
    }

    case 'answer_commit': {
      if (s.phase !== 'solving') return violate(s, at, from, 'stray-answer-commit');
      if (s.answers.commits[from]) return violate(s, at, from, 'duplicate-answer-commit');
      if (typeof msg.commit !== 'string' || !msg.commit) return violate(s, at, from, 'malformed-answer-commit');
      // Mirroring an answer commit = replaying the opponent's reveal later —
      // "solving" by theft. Same forfeit as the seed mirror.
      if (msg.commit === s.answers.commits[opponentOf(s, from)]?.commit) return forfeitTo(s, from, 'mirrored-answer-commit', at);
      const commits = { ...s.answers.commits, [from]: { commit: msg.commit, at } };
      const both = bothPlayers(s).every((p) => commits[p]);
      return { ...s, answers: { ...s.answers, commits }, ...(both ? { phase: 'revealing', phaseAt: at } : {}) };
    }

    case 'answer_reveal': {
      if (s.phase !== 'revealing') return violate(s, at, from, 'stray-answer-reveal');
      if (s.answers.reveals[from]) return violate(s, at, from, 'duplicate-answer-reveal');
      if (typeof msg.answer !== 'string' || typeof msg.salt !== 'string') return violate(s, at, from, 'malformed-answer-reveal');
      if (revealOk !== true) return forfeitTo(s, from, 'answer-reveal-mismatch', at);
      const reveals = { ...s.answers.reveals, [from]: { answer: msg.answer, salt: msg.salt, sawPeerCommitFirst: !!msg.sawPeerCommitFirst } };
      const both = bothPlayers(s).every((p) => reveals[p]);
      return { ...s, answers: { ...s.answers, reveals }, ...(both ? { phase: 'scoring', phaseAt: at } : {}) };
    }

    case 'result_sig': {
      if (s.phase !== 'signing') return violate(s, at, from, 'stray-result-sig');
      if (s.sigs[from]) return violate(s, at, from, 'duplicate-result-sig');
      if (typeof msg.sig !== 'string' || !msg.sig) return violate(s, at, from, 'malformed-result-sig');
      // why the shell verifies the signature BEFORE applying: signature checking
      // is async crypto; an invalid sig is simply never applied (and logged as a
      // violation by the driver), so a stored sig is a verified one.
      const sigs = { ...s.sigs, [from]: msg.sig };
      const both = bothPlayers(s).every((p) => sigs[p]);
      return { ...s, sigs, ...(both ? { coSigned: true, phase: 'done', phaseAt: at } : {}) };
    }

    default:
      return violate(s, at, from, `unknown-type:${String(msg.type).slice(0, 24)}`);
  }
};

/** Record the jointly-derived seed (async-hashed by the shell after both
 * reveals; see combineSeed). @param {MatchState} s @param {string} seedHex
 * @returns {MatchState} */
export const applySeed = (s, seedHex) =>
  (s.phase === 'solving' && !s.seed.value ? { ...s, seed: { ...s.seed, value: seedHex } } : s);

/**
 * Record one player's verdict (the shell ran rules.check in the sealed
 * worker). When both are in, the outcome is decided and the match moves to
 * signing. @param {MatchState} s @param {{ did: string, correct: boolean, score?: number, at: number }} v
 * @returns {MatchState}
 */
export const applyVerdict = (s, { did, correct, score = 0, at }) => {
  if (s.phase !== 'scoring' || !isPlayer(s, did) || s.verdicts[did]) return violate(s, at, did, 'stray-verdict');
  const verdicts = { ...s.verdicts, [did]: { correct: !!correct, score: Number.isFinite(score) ? score : 0 } };
  const next = { ...s, verdicts };
  if (!bothPlayers(s).every((p) => verdicts[p])) return next;
  return { ...next, outcome: decideOutcome(next), phase: 'signing', phaseAt: at };
};

/**
 * The pure outcome rule, symmetric by construction:
 *   correctness → score → committed-first, and any order dispute is a draw
 * (the reducer never guesses between two mutually-exclusive claims).
 * `sawPeerCommitFirst` is each revealer's own claim about arrival order; a
 * liar can only downgrade a loss to a draw — a bounded, accepted distortion
 * (spec §5). @param {MatchState} s @returns {Outcome}
 */
export const decideOutcome = (s) => {
  const [a, b] = bothPlayers(s);
  const va = s.verdicts[a], vb = s.verdicts[b];
  if (!va || !vb) return { kind: 'aborted', reason: 'missing-verdict' };
  if (va.correct !== vb.correct) return { kind: 'win', winner: va.correct ? a : b, reason: 'correctness' };
  if (!va.correct) return { kind: 'draw', reason: 'neither-correct' };
  if (va.score !== vb.score) return { kind: 'win', winner: va.score > vb.score ? a : b, reason: 'score' };
  const ra = s.answers.reveals[a], rb = s.answers.reveals[b];
  const aClaimsBFirst = !!ra?.sawPeerCommitFirst, bClaimsAFirst = !!rb?.sawPeerCommitFirst;
  if (aClaimsBFirst && !bClaimsAFirst) return { kind: 'win', winner: b, reason: 'committed-first' };
  if (bClaimsAFirst && !aClaimsBFirst) return { kind: 'win', winner: a, reason: 'committed-first' };
  return { kind: 'draw', reason: aClaimsBFirst ? 'order-disputed' : 'simultaneous' };
};

/** Which players owe the current phase's pending message — the timeout blame.
 * @param {MatchState} s @returns {string[]} */
export const owingPlayers = (s) => {
  const players = bothPlayers(s);
  switch (s.phase) {
    case 'proposed': return [s.players.acceptor];
    case 'seeding':
      return players.every((p) => s.seed.commits[p])
        ? players.filter((p) => !s.seed.reveals[p])
        : players.filter((p) => !s.seed.commits[p]);
    case 'solving': return players.filter((p) => !s.answers.commits[p]);
    case 'revealing': return players.filter((p) => !s.answers.reveals[p]);
    case 'signing': return players.filter((p) => !s.sigs[p]);
    default: return [];
  }
};

/**
 * Enforce the current phase's deadline. One player owing → they forfeit (or
 * the proposal/signing degrades gracefully); both owing → aborted, nothing
 * proven. @param {MatchState} s @param {number} at @returns {MatchState}
 */
export const applyTimeout = (s, at) => {
  if (s.phase === 'done' || at < s.phaseAt + phaseDuration(s)) return s;
  const owing = owingPlayers(s);
  switch (s.phase) {
    case 'proposed':
      return finish(s, { kind: 'aborted', reason: 'accept-timeout' }, at);
    case 'scoring':
      // verdicts are local computation, not an opponent's move — nobody forfeits.
      return finish(s, { kind: 'aborted', reason: 'scoring-stalled' }, at);
    case 'signing': {
      // The outcome already stands; a missing counter-signature only costs the
      // log its co-signed status (and is recorded against the non-signer).
      const blamed = owing.reduce((st, p) => violate(st, at, p, 'sign-timeout'), s);
      return { ...blamed, phase: 'done', phaseAt: at, coSigned: false };
    }
    default: {
      if (owing.length === 1) return finish(violate(s, at, owing[0], `${s.phase}-timeout`), { kind: 'win', winner: opponentOf(s, owing[0]), reason: `${s.phase}-timeout` }, at);
      return finish(s, { kind: 'aborted', reason: `${s.phase}-timeout` }, at);
    }
  }
};

/** Close a decided match without signatures (no signer wired — e.g. a host
 * without an identity). @param {MatchState} s @param {number} at
 * @returns {MatchState} */
export const finalizeUnsigned = (s, at) =>
  (s.phase === 'signing' ? { ...s, phase: 'done', phaseAt: at, coSigned: false } : s);
