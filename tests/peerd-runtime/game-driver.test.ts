import { describe, test, expect } from 'bun:test';
// End-to-end: TWO match drivers wired back-to-back over an in-memory wire,
// with real commit-reveal hashing — the whole protocol as both players run it,
// then the exported log replayed through the independent verifier.
import { createMatchDriver } from '../../extension/peerd-runtime/game/match-driver.js';
import { verifyMatchLog } from '../../extension/peerd-runtime/game/match-log.js';

const A = 'did:key:zAlice';
const B = 'did:key:zBob';

// Deterministic fake game: the puzzle is the seed's first 8 chars; the right
// answer is that string reversed. check re-derives from the seed alone, the
// same signature the log verifier uses.
const puzzleOf = (seed: string) => seed.slice(0, 8);
const answerFor = (seed: string) => puzzleOf(seed).split('').reverse().join('');
const rules = {
  derive: async (seed: string) => ({ puzzle: puzzleOf(seed) }),
  check: async (seed: string, answer: string) => ({ correct: answer === answerFor(seed), score: answer === answerFor(seed) ? 1 : 0 }),
};

// Fake-but-binding signatures: sig = `sig:${did}:${result}`, verified by
// reconstruction. Signing is injected IO, so the fake exercises the real flow.
const signer = (did: string) => ({
  signResult: async (result: string) => `sig:${did}:${result.length}`,
  verifyResultSig: async (sigDid: string, sig: string, result: string) => sig === `sig:${sigDid}:${result.length}`,
});

type Driver = ReturnType<typeof createMatchDriver>;

// An in-memory wire: async delivery, like the direct channel (fire-and-forget).
const wire = () => {
  const ends = new Map<string, Driver>();
  return {
    register: (did: string, d: Driver) => ends.set(did, d),
    send: (fromDid: string) => async (toDid: string, msg: Record<string, unknown>) => {
      const target = ends.get(toDid);
      if (!target) throw new Error('no link');
      setTimeout(() => target.handleInbound(fromDid, msg), 1);
      return { ok: true };
    },
  };
};

const makePair = (opts: {
  solveA?: (ch: { puzzle: string }, seedAnswer: string) => Promise<string | null>,
  solveB?: (ch: { puzzle: string }, seedAnswer: string) => Promise<string | null>,
  acceptB?: boolean,
  deadlines?: Record<string, number>,
} = {}) => {
  const w = wire();
  const seedOf = (ch: { puzzle: string }) => ch.puzzle.split('').reverse().join('');
  const mk = (did: string, solve: ((ch: { puzzle: string }, ans: string) => Promise<string | null>) | undefined, accept: boolean) =>
    createMatchDriver({
      selfDid: did,
      send: w.send(did),
      rules,
      solve: async (ch: { puzzle: string }) => {
        const ans = solve ? await solve(ch, seedOf(ch)) : seedOf(ch);
        if (ans == null) return await new Promise<never>(() => {}); // never solves
        return { answer: ans };
      },
      ...signer(did),
      acceptPolicy: () => accept,
    });
  const a = mk(A, opts.solveA, true);
  const b = mk(B, opts.solveB, opts.acceptB ?? true);
  w.register(A, a); w.register(B, b);
  return { a, b };
};

// The wire delivers async — wait until a driver has learned about a match
// before awaiting its completion.
const waitKnown = async (d: Driver, id: string) => {
  while (!d.get(id)) await new Promise((r) => setTimeout(r, 2));
};

describe('match driver end-to-end', () => {
  test('a full match: both sides finish co-signed with the same outcome', async () => {
    // A answers instantly; B answers late (20ms) → A commits first and wins.
    const { a, b } = makePair({
      solveB: async (_ch, ans) => { await new Promise((r) => setTimeout(r, 20)); return ans; },
    });
    const matchId = await a.challenge(B, { gameId: 'g', rulesHash: 'rh' });
    await waitKnown(b, matchId);
    const [finalA, finalB] = await Promise.all([a.whenDone(matchId), b.whenDone(matchId)]);

    expect(finalA.outcome).toMatchObject({ kind: 'win', winner: A, reason: 'committed-first' });
    expect(finalB.outcome).toEqual(finalA.outcome);
    expect(finalA.coSigned).toBe(true);
    expect(finalB.coSigned).toBe(true);
    expect(finalA.resultString).toBe(finalB.resultString);
    a.close(); b.close();
  });

  test('a wrong answer loses on correctness', async () => {
    const { a, b } = makePair({ solveB: async () => 'wrong-answer' });
    const matchId = await a.challenge(B, { gameId: 'g', rulesHash: 'rh' });
    const finalA = await a.whenDone(matchId);
    expect(finalA.outcome).toMatchObject({ kind: 'win', winner: A, reason: 'correctness' });
    a.close(); b.close();
  });

  test('the exported log replays through the independent verifier', async () => {
    const { a, b } = makePair({ solveB: async () => 'wrong-answer' });
    const matchId = await a.challenge(B, { gameId: 'g', rulesHash: 'rh' });
    await waitKnown(b, matchId);
    await Promise.all([a.whenDone(matchId), b.whenDone(matchId)]);

    for (const side of [a, b]) {
      const log = side.exportLog(matchId)!;
      expect(log.sigs[A]).toBeDefined();
      expect(log.sigs[B]).toBeDefined();
      const verdict = await verifyMatchLog(log, {
        check: rules.check,
        verifySig: signer('').verifyResultSig,
      });
      expect(verdict.problems).toEqual([]);
      expect(verdict.ok).toBe(true);
      expect(verdict.state?.outcome).toMatchObject({ kind: 'win', winner: A });
    }
    a.close(); b.close();
  });

  test('a tampered log fails verification', async () => {
    const { a, b } = makePair({ solveB: async () => 'wrong-answer' });
    const matchId = await a.challenge(B, { gameId: 'g', rulesHash: 'rh' });
    await a.whenDone(matchId);
    const log = a.exportLog(matchId)!;
    // flip the claimed outcome inside the result string
    const forged = { ...log, result: log.result.replace(`"winner":"${A}"`, `"winner":"${B}"`) };
    const verdict = await verifyMatchLog(forged, { check: rules.check, verifySig: signer('').verifyResultSig });
    expect(verdict.ok).toBe(false);
    a.close(); b.close();
  });

  test('a declined challenge resolves without a game', async () => {
    const { a, b } = makePair({ acceptB: false });
    const matchId = await a.challenge(B, { gameId: 'g', rulesHash: 'rh' });
    const finalA = await a.whenDone(matchId);
    expect(finalA.outcome).toMatchObject({ kind: 'declined' });
    a.close(); b.close();
  });

  test('a solver that never answers forfeits at the solve deadline', async () => {
    const { a, b } = makePair({
      solveB: async () => null,   // B never solves
      deadlines: {},
    });
    // short solve window so the test stays fast
    const matchId = await a.challenge(B, { gameId: 'g', rulesHash: 'rh', deadlines: { solving: 150 } });
    const finalA = await a.whenDone(matchId);
    expect(finalA.outcome).toMatchObject({ kind: 'win', winner: A, reason: 'solving-timeout' });
    a.close(); b.close();
  }, 10_000);
});
