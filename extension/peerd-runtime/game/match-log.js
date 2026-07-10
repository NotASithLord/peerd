// @ts-check
// peerd-runtime/game/match-log.js — the portable, auditable record of a match.
//
// A match log is the append-only transcript of the exchanged protocol
// messages plus the CANONICAL RESULT both players co-sign. Anyone holding the
// log and the game's rules can replay it through the pure reducer and must
// re-derive the same outcome — that replay IS the audit (no scorer to trust),
// and it's what makes a gossiped leaderboard entry verifiable instead of a
// claim (docs/specs/PEERD-GAME-ARENA.md §3).

import { createMatch, applyMessage, applySeed, applyVerdict, applyTimeout, isGameMessage, finalizeUnsigned, phaseDuration } from './match-reducer.js';
import { verifyReveal, combineSeed } from './commit-reveal.js';

// Domain separation for the result co-signature — every identity-key use in
// peerd is context-tagged (envelopes, DHT items, game commits); an untagged
// signature is a latent cross-protocol confusion. Hosts sign/verify THESE
// bytes, never the raw result JSON.
export const RESULT_SIGN_CONTEXT = 'peerd-game:result:v1';
/** @param {string} resultString */
export const resultSigningBytes = (resultString) => `${RESULT_SIGN_CONTEXT}\n${resultString}`;

/**
 * The canonical result string — the exact bytes both players sign (wrapped in
 * resultSigningBytes for the actual signature). Built with
 * a FIXED key order and did-sorted maps so both sides (and any later
 * verifier) produce byte-identical JSON; JSON.stringify preserves insertion
 * order, so the object literal below is the canonical form.
 * @param {import('./match-reducer.js').MatchState} s
 * @returns {string}
 */
export const canonicalResult = (s) => {
  /** @param {Record<string, any>} m @param {(v: any) => any} pick */
  const sorted = (m, pick) => Object.fromEntries(Object.keys(m).sort().map((k) => [k, pick(m[k])]));
  return JSON.stringify({
    v: 1,
    matchId: s.matchId,
    gameId: s.gameId,
    rulesHash: s.rulesHash,
    challenger: s.players.challenger,
    acceptor: s.players.acceptor,
    seed: s.seed.value,
    answers: sorted(s.answers.reveals, (r) => ({ answer: r.answer })),
    verdicts: sorted(s.verdicts, (v) => ({ correct: v.correct, score: v.score })),
    outcome: { kind: s.outcome?.kind ?? 'aborted', winner: s.outcome?.winner ?? null, reason: s.outcome?.reason ?? 'unknown' },
  });
};

/**
 * @typedef {{ dir: 'in'|'out', from: string, at: number, msg: Record<string, any> }} LogEntry
 * @typedef {{ entries: LogEntry[], result: string, sigs: Record<string, string> }} MatchLog
 */

/**
 * Replay a match log and check that it re-derives the claimed result.
 * `check` re-runs the game's verdict for one revealed answer (the caller owns
 * running the rules module — in a sealed worker when the rules came from a
 * peer); `verifySig` checks one detached signature over the given string (the
 * context wrapping happens HERE, uniformly — hosts inject a generic verifier).
 * Both are injected so this stays host-agnostic and testable.
 *
 * `ok` is transcript CONSISTENCY only. `authenticated` is the authenticity
 * verdict — true only when a verifier was supplied AND both players'
 * signatures over the result verify. A log audited without `verifySig` can be
 * internally consistent yet wholly fabricated; callers must check both.
 *
 * @param {MatchLog} log
 * @param {{
 *   check: (seedHex: string, answer: string) => Promise<{ correct: boolean, score?: number }>,
 *   verifySig?: (did: string, sigHex: string, signedString: string) => Promise<boolean>,
 * }} io
 * @returns {Promise<{ ok: boolean, authenticated: boolean, problems: string[], state: import('./match-reducer.js').MatchState | null }>}
 */
export const verifyMatchLog = async (log, { check, verifySig }) => {
  /** @type {string[]} */
  const problems = [];
  const entries = Array.isArray(log?.entries) ? log.entries : [];
  const challengeEntry = entries.find((e) => isGameMessage(e?.msg) && e.msg.type === 'challenge');
  if (!challengeEntry) return { ok: false, authenticated: false, problems: ['no challenge entry'], state: null };

  const c = challengeEntry.msg;
  const acceptEntry = entries.find((e) => isGameMessage(e?.msg) && e.msg.type === 'accept');
  let state = createMatch({
    matchId: c.matchId, gameId: String(c.gameId ?? ''), rulesHash: String(c.rulesHash ?? ''),
    challenger: challengeEntry.from, acceptor: String(acceptEntry?.from ?? c.to ?? ''),
    deadlines: c.deadlines, at: challengeEntry.at,
  });

  for (const e of entries) {
    if (!isGameMessage(e?.msg) || e.msg.type === 'challenge') continue;
    /** @type {boolean | undefined} */
    let revealOk;
    if (e.msg.type === 'seed_reveal') {
      revealOk = await verifyReveal({ commit: state.seed.commits[e.from] ?? '', value: e.msg.nonce, saltHex: e.msg.salt });
    } else if (e.msg.type === 'answer_reveal') {
      revealOk = await verifyReveal({ commit: state.answers.commits[e.from]?.commit ?? '', value: e.msg.answer, saltHex: e.msg.salt });
    }
    state = applyMessage(state, { from: e.from, at: e.at, msg: e.msg, revealOk });
    // Re-derive the joint seed at the same point the players did — the moment
    // both nonce reveals are in (applySeed only lands while phase is solving).
    if (state.phase === 'solving' && !state.seed.value) {
      const reveals = Object.values(state.seed.reveals);
      if (reveals.length === 2) state = applySeed(state, await combineSeed(state.matchId, reveals.map((r) => r.nonce)));
    }
  }

  // A transcript that simply STOPS mid-phase is how a timeout-decided match
  // looks (the deciding "event" is the deadline passing, never a message) —
  // replay the deadline the same way the players' clocks did, so forfeit and
  // abort outcomes re-derive too. Scoring is exempt: its pending work is the
  // verdicts, recomputed below.
  if (state.phase !== 'done' && state.phase !== 'scoring') {
    state = applyTimeout(state, state.phaseAt + phaseDuration(state) + 1);
  }

  // Re-derive the verdicts exactly as the players did.
  if (state.phase === 'scoring') {
    for (const [did, r] of Object.entries(state.answers.reveals)) {
      const v = await check(/** @type {string} */(state.seed.value), r.answer).catch(() => ({ correct: false, score: 0 }));
      state = applyVerdict(state, { did, correct: !!v.correct, score: v.score ?? 0, at: entries[entries.length - 1]?.at ?? 0 });
    }
  }
  state = finalizeUnsigned(state, entries[entries.length - 1]?.at ?? 0);

  if (state.phase !== 'done' || !state.outcome) problems.push(`replay did not finish (phase ${state.phase})`);
  const rederived = canonicalResult(state);
  if (typeof log.result === 'string' && log.result !== rederived) problems.push('result does not match the replayed transcript');

  // Authenticity: BOTH players' signatures over the context-wrapped result.
  let authenticated = false;
  if (verifySig && log.sigs && typeof log.result === 'string') {
    let verified = 0;
    for (const [did, sig] of Object.entries(log.sigs)) {
      if (await verifySig(did, sig, resultSigningBytes(log.result)).catch(() => false)) verified += 1;
      else problems.push(`signature by ${did.slice(-8)} does not verify`);
    }
    const players = [state.players.challenger, state.players.acceptor];
    authenticated = verified >= 2 && players.every((p) => typeof log.sigs[p] === 'string');
  }
  return { ok: problems.length === 0, authenticated, problems, state };
};
