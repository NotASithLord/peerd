import { describe, test, expect } from 'bun:test';
// The game framework's PURE core: commit-reveal fairness helpers and the
// match reducer both players run symmetrically (docs/specs/PEERD-GAME-ARENA.md).
import { makeCommit, verifyReveal, combineSeed, randomHex } from '../../extension/peerd-runtime/game/commit-reveal.js';
import {
  createMatch, applyMessage, applySeed, applyVerdict, applyTimeout, finalizeUnsigned,
  decideOutcome, owingPlayers, DEFAULT_DEADLINES, isGameMessage,
} from '../../extension/peerd-runtime/game/match-reducer.js';
import { canonicalResult } from '../../extension/peerd-runtime/game/match-log.js';

const A = 'did:key:zAlice';
const B = 'did:key:zBob';

const fresh = (over: Record<string, unknown> = {}) =>
  createMatch({ matchId: 'm-1', gameId: 'puzzle-race', rulesHash: 'rh-1', challenger: A, acceptor: B, at: 1000, ...over });

const msg = (type: string, body: Record<string, unknown> = {}) => ({ __game: 1 as const, matchId: 'm-1', type, ...body });

// Drive a match to the scoring phase with both answers revealed.
const toScoring = () => {
  let s = fresh();
  s = applyMessage(s, { from: B, at: 1100, msg: msg('accept', { rulesHash: 'rh-1' }) });
  s = applyMessage(s, { from: A, at: 1200, msg: msg('seed_commit', { commit: 'ca' }) });
  s = applyMessage(s, { from: B, at: 1210, msg: msg('seed_commit', { commit: 'cb' }) });
  s = applyMessage(s, { from: A, at: 1300, msg: msg('seed_reveal', { nonce: 'na', salt: 'sa' }), revealOk: true });
  s = applyMessage(s, { from: B, at: 1310, msg: msg('seed_reveal', { nonce: 'nb', salt: 'sb' }), revealOk: true });
  s = applySeed(s, 'seed-hex');
  s = applyMessage(s, { from: A, at: 2000, msg: msg('answer_commit', { commit: 'aa' }) });
  s = applyMessage(s, { from: B, at: 2100, msg: msg('answer_commit', { commit: 'ab' }) });
  s = applyMessage(s, { from: A, at: 2200, msg: msg('answer_reveal', { answer: '42', salt: 'x', sawPeerCommitFirst: false }), revealOk: true });
  s = applyMessage(s, { from: B, at: 2210, msg: msg('answer_reveal', { answer: '41', salt: 'y', sawPeerCommitFirst: true }), revealOk: true });
  return s;
};

describe('commit-reveal', () => {
  test('a reveal verifies against its commit, and only its commit', async () => {
    const salt = randomHex(16);
    const commit = await makeCommit('the answer', salt);
    expect(await verifyReveal({ commit, value: 'the answer', saltHex: salt })).toBe(true);
    expect(await verifyReveal({ commit, value: 'another answer', saltHex: salt })).toBe(false);
    expect(await verifyReveal({ commit, value: 'the answer', saltHex: randomHex(16) })).toBe(false);
  });

  test('the joint seed is order-independent and match-bound', async () => {
    expect(await combineSeed('m-1', ['n1', 'n2'])).toBe(await combineSeed('m-1', ['n2', 'n1']));
    expect(await combineSeed('m-1', ['n1', 'n2'])).not.toBe(await combineSeed('m-2', ['n1', 'n2']));
  });
});

describe('match reducer — happy path', () => {
  test('challenge → accept → seed → solve → reveal → verdicts → co-sign', () => {
    let s = toScoring();
    expect(s.phase).toBe('scoring');
    s = applyVerdict(s, { did: A, correct: true, score: 1, at: 2300 });
    s = applyVerdict(s, { did: B, correct: false, score: 0, at: 2300 });
    expect(s.phase).toBe('signing');
    expect(s.outcome).toMatchObject({ kind: 'win', winner: A, reason: 'correctness' });
    s = applyMessage(s, { from: A, at: 2400, msg: msg('result_sig', { sig: 'sigA' }) });
    expect(s.phase).toBe('signing');
    s = applyMessage(s, { from: B, at: 2410, msg: msg('result_sig', { sig: 'sigB' }) });
    expect(s.phase).toBe('done');
    expect(s.coSigned).toBe(true);
    expect(s.violations).toHaveLength(0);
  });

  test('decline ends it; a rules-hash mismatch aborts (no agreed game to lose)', () => {
    expect(applyMessage(fresh(), { from: B, at: 1100, msg: msg('decline') }).outcome).toMatchObject({ kind: 'declined' });
    const s = applyMessage(fresh(), { from: B, at: 1100, msg: msg('accept', { rulesHash: 'OTHER' }) });
    expect(s.outcome).toMatchObject({ kind: 'aborted', reason: 'rules-mismatch' });
  });
});

describe('match reducer — cheating and violations', () => {
  test('a reveal that does not match its commit forfeits to the opponent', () => {
    let s = fresh();
    s = applyMessage(s, { from: B, at: 1100, msg: msg('accept', { rulesHash: 'rh-1' }) });
    s = applyMessage(s, { from: A, at: 1200, msg: msg('seed_commit', { commit: 'ca' }) });
    s = applyMessage(s, { from: B, at: 1210, msg: msg('seed_commit', { commit: 'cb' }) });
    s = applyMessage(s, { from: B, at: 1300, msg: msg('seed_reveal', { nonce: 'nb', salt: 'sb' }), revealOk: false });
    expect(s.outcome).toMatchObject({ kind: 'win', winner: A, reason: 'seed-reveal-mismatch' });
  });

  test('mirroring the opponent commit forfeits (seed head-start / answer theft)', () => {
    let s = fresh();
    s = applyMessage(s, { from: B, at: 1100, msg: msg('accept', { rulesHash: 'rh-1' }) });
    s = applyMessage(s, { from: A, at: 1200, msg: msg('seed_commit', { commit: 'same' }) });
    s = applyMessage(s, { from: B, at: 1210, msg: msg('seed_commit', { commit: 'same' }) });
    expect(s.outcome).toMatchObject({ kind: 'win', winner: A, reason: 'mirrored-seed-commit' });

    // the ANSWER mirror (replaying the opponent's reveal = solving by theft)
    let t = fresh();
    t = applyMessage(t, { from: B, at: 1100, msg: msg('accept', { rulesHash: 'rh-1' }) });
    t = applyMessage(t, { from: A, at: 1200, msg: msg('seed_commit', { commit: 'ca' }) });
    t = applyMessage(t, { from: B, at: 1210, msg: msg('seed_commit', { commit: 'cb' }) });
    t = applyMessage(t, { from: A, at: 1300, msg: msg('seed_reveal', { nonce: 'na', salt: 'sa' }), revealOk: true });
    t = applyMessage(t, { from: B, at: 1310, msg: msg('seed_reveal', { nonce: 'nb', salt: 'sb' }), revealOk: true });
    t = applyMessage(t, { from: A, at: 2000, msg: msg('answer_commit', { commit: 'same-answer' }) });
    t = applyMessage(t, { from: B, at: 2100, msg: msg('answer_commit', { commit: 'same-answer' }) });
    expect(t.outcome).toMatchObject({ kind: 'win', winner: A, reason: 'mirrored-answer-commit' });
  });

  test('oversized fields are malformed, never stored (amplification cap)', () => {
    let s = fresh();
    s = applyMessage(s, { from: B, at: 1100, msg: msg('accept', { rulesHash: 'rh-1' }) });
    const next = applyMessage(s, { from: A, at: 1200, msg: msg('seed_commit', { commit: 'x'.repeat(200) }) });
    expect(next.seed.commits[A]).toBeUndefined();
    expect(next.violations.at(-1)).toMatchObject({ from: A, code: 'malformed-seed-commit' });

    let u = fresh();
    u = applyMessage(u, { from: B, at: 1100, msg: msg('accept', { rulesHash: 'rh-1' }) });
    u = applyMessage(u, { from: A, at: 1200, msg: msg('seed_commit', { commit: 'ca' }) });
    u = applyMessage(u, { from: B, at: 1210, msg: msg('seed_commit', { commit: 'cb' }) });
    u = applyMessage(u, { from: A, at: 1300, msg: msg('seed_reveal', { nonce: 'na', salt: 'sa' }), revealOk: true });
    u = applyMessage(u, { from: B, at: 1310, msg: msg('seed_reveal', { nonce: 'nb', salt: 'sb' }), revealOk: true });
    u = applyMessage(u, { from: A, at: 2000, msg: msg('answer_commit', { commit: 'aa' }) });
    u = applyMessage(u, { from: B, at: 2100, msg: msg('answer_commit', { commit: 'ab' }) });
    const big = applyMessage(u, { from: A, at: 2200, msg: msg('answer_reveal', { answer: 'y'.repeat(5000), salt: 'x', sawPeerCommitFirst: false }), revealOk: true });
    expect(big.answers.reveals[A]).toBeUndefined();
    expect(big.violations.at(-1)).toMatchObject({ from: A, code: 'malformed-answer-reveal' });
  });

  test('revealing a seed nonce before both commits is a violation, not a transition', () => {
    let s = fresh();
    s = applyMessage(s, { from: B, at: 1100, msg: msg('accept', { rulesHash: 'rh-1' }) });
    s = applyMessage(s, { from: A, at: 1200, msg: msg('seed_commit', { commit: 'ca' }) });
    const next = applyMessage(s, { from: A, at: 1250, msg: msg('seed_reveal', { nonce: 'na', salt: 'sa' }), revealOk: true });
    expect(next.phase).toBe('seeding');
    expect(next.violations.at(-1)).toMatchObject({ from: A, code: 'seed-reveal-before-commits' });
  });

  test('a non-player and a wrong-match message never advance the state', () => {
    const s = fresh();
    expect(applyMessage(s, { from: 'did:key:zEve', at: 1100, msg: msg('accept', { rulesHash: 'rh-1' }) }).phase).toBe('proposed');
    expect(applyMessage(s, { from: B, at: 1100, msg: { ...msg('accept', { rulesHash: 'rh-1' }), matchId: 'm-OTHER' } }).phase).toBe('proposed');
  });

  test('resign hands the win to the opponent', () => {
    let s = fresh();
    s = applyMessage(s, { from: B, at: 1100, msg: msg('accept', { rulesHash: 'rh-1' }) });
    s = applyMessage(s, { from: B, at: 1200, msg: msg('resign') });
    expect(s.outcome).toMatchObject({ kind: 'win', winner: A, reason: 'resigned' });
  });
});

describe('match reducer — deadlines', () => {
  test('one player owing at the deadline forfeits; both owing aborts', () => {
    let s = fresh();
    s = applyMessage(s, { from: B, at: 1100, msg: msg('accept', { rulesHash: 'rh-1' }) });
    s = applyMessage(s, { from: A, at: 1200, msg: msg('seed_commit', { commit: 'ca' }) });
    s = applyMessage(s, { from: B, at: 1210, msg: msg('seed_commit', { commit: 'cb' }) });
    s = applyMessage(s, { from: A, at: 1300, msg: msg('seed_reveal', { nonce: 'na', salt: 'sa' }), revealOk: true });
    s = applyMessage(s, { from: B, at: 1310, msg: msg('seed_reveal', { nonce: 'nb', salt: 'sb' }), revealOk: true });
    // solving: A commits, B never does → B forfeits at the solve deadline
    s = applyMessage(s, { from: A, at: 2000, msg: msg('answer_commit', { commit: 'aa' }) });
    expect(owingPlayers(s)).toEqual([B]);
    const afterDeadline = applyTimeout(s, 1310 + DEFAULT_DEADLINES.solving + 1);
    expect(afterDeadline.outcome).toMatchObject({ kind: 'win', winner: A, reason: 'solving-timeout' });

    // neither commits → aborted, nothing proven
    let both = fresh();
    both = applyMessage(both, { from: B, at: 1100, msg: msg('accept', { rulesHash: 'rh-1' }) });
    expect(applyTimeout(both, 1100 + DEFAULT_DEADLINES.seeding + 1).outcome).toMatchObject({ kind: 'aborted' });
  });

  test('before the deadline applyTimeout is a no-op; sign-timeout keeps the outcome', () => {
    let s = toScoring();
    expect(applyTimeout(s, 2211)).toBe(s);
    s = applyVerdict(s, { did: A, correct: true, score: 1, at: 2300 });
    s = applyVerdict(s, { did: B, correct: true, score: 1, at: 2300 });
    s = applyMessage(s, { from: A, at: 2400, msg: msg('result_sig', { sig: 'sigA' }) });
    const timedOut = applyTimeout(s, 2300 + DEFAULT_DEADLINES.signing + 1);
    expect(timedOut.phase).toBe('done');
    expect(timedOut.coSigned).toBe(false);
    expect(timedOut.outcome).toMatchObject({ kind: 'win', winner: A, reason: 'committed-first' });
    expect(timedOut.violations.at(-1)).toMatchObject({ from: B, code: 'sign-timeout' });
  });
});

describe('decideOutcome', () => {
  const withVerdicts = (va: { correct: boolean; score: number }, vb: { correct: boolean; score: number },
    sawA = false, sawB = true) => {
    let s = toScoring();
    // toScoring reveals: A sawPeerCommitFirst=false, B=true (A committed first).
    s = { ...s, answers: { ...s.answers, reveals: {
      [A]: { ...s.answers.reveals[A], sawPeerCommitFirst: sawA },
      [B]: { ...s.answers.reveals[B], sawPeerCommitFirst: sawB },
    } } };
    s = applyVerdict(s, { did: A, ...va, at: 2300 });
    s = applyVerdict(s, { did: B, ...vb, at: 2300 });
    return s.outcome!;
  };

  test('correctness dominates, then score, then commit order', () => {
    expect(withVerdicts({ correct: false, score: 0 }, { correct: true, score: 1 })).toMatchObject({ kind: 'win', winner: B, reason: 'correctness' });
    expect(withVerdicts({ correct: true, score: 3 }, { correct: true, score: 1 })).toMatchObject({ kind: 'win', winner: A, reason: 'score' });
    expect(withVerdicts({ correct: true, score: 1 }, { correct: true, score: 1 })).toMatchObject({ kind: 'win', winner: A, reason: 'committed-first' });
    expect(withVerdicts({ correct: false, score: 0 }, { correct: false, score: 0 })).toMatchObject({ kind: 'draw', reason: 'neither-correct' });
  });

  test('order claims that disagree are a draw — the reducer never guesses', () => {
    // both claim self-first (a genuine near-tie)
    expect(withVerdicts({ correct: true, score: 1 }, { correct: true, score: 1 }, false, false)).toMatchObject({ kind: 'draw', reason: 'simultaneous' });
    // both claim peer-first (someone is lying politely)
    expect(withVerdicts({ correct: true, score: 1 }, { correct: true, score: 1 }, true, true)).toMatchObject({ kind: 'draw', reason: 'order-disputed' });
  });
});

describe('canonical result', () => {
  test('byte-identical regardless of who serializes (did-sorted maps, fixed keys)', () => {
    let s = toScoring();
    s = applyVerdict(s, { did: A, correct: true, score: 1, at: 2300 });
    s = applyVerdict(s, { did: B, correct: false, score: 0, at: 2300 });
    const r1 = canonicalResult(s);
    // reversed insertion order for the maps must not change the bytes
    const reversed = {
      ...s,
      verdicts: Object.fromEntries(Object.entries(s.verdicts).reverse()),
      answers: { ...s.answers, reveals: Object.fromEntries(Object.entries(s.answers.reveals).reverse()) },
    };
    expect(canonicalResult(reversed as typeof s)).toBe(r1);
    expect(JSON.parse(r1)).toMatchObject({ v: 1, matchId: 'm-1', outcome: { kind: 'win', winner: A } });
  });
});

describe('wire guard', () => {
  test('isGameMessage accepts only the tagged shape', () => {
    expect(isGameMessage(msg('accept'))).toBe(true);
    expect(isGameMessage({ matchId: 'm-1', type: 'accept' })).toBe(false);
    expect(isGameMessage({ __a2a: 1, kind: 'ask', reqId: 'r' })).toBe(false);
    expect(isGameMessage(null)).toBe(false);
  });

  test('finalizeUnsigned closes a signing match without signatures', () => {
    let s = toScoring();
    s = applyVerdict(s, { did: A, correct: true, score: 1, at: 2300 });
    s = applyVerdict(s, { did: B, correct: true, score: 1, at: 2300 });
    const closed = finalizeUnsigned(s, 2400);
    expect(closed.phase).toBe('done');
    expect(closed.coSigned).toBe(false);
  });
});
