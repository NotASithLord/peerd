// @ts-check
// peerd-runtime/game/match-driver.js — the imperative shell that plays a match.
//
// The makeMeshDispatch twin (actor/a2a-dispatch.js): every IO surface is
// INJECTED — send (the signed direct channel), the rules module runner (derive
// / check, run in a sealed worker when the rules came from a peer), the solver
// (the competitor's own business: a model, or code in a sealed worker), the
// result signer, the clock, the timer. The protocol itself lives in the pure
// reducer (match-reducer.js); this file only sequences effects: when the state
// says a message is owed, send it (and feed our OWN message back through the
// same reducer — both sides run one symmetric state machine).
//
// why a per-match op queue: inbound messages, solver completion, and deadline
// timers all land asynchronously; serializing them through one promise chain
// per match means the reducer never sees interleaved half-applied updates.

import { createMatch, applyMessage, applySeed, applyVerdict, applyTimeout, finalizeUnsigned, isGameMessage, phaseDuration } from './match-reducer.js';
import { makeCommit, verifyReveal, combineSeed, randomHex } from './commit-reveal.js';
import { canonicalResult } from './match-log.js';

export class GameProtocolError extends Error {
  /** @param {string} message */
  constructor(message) { super(message); this.name = 'GameProtocolError'; }
}

// Live matches a driver will track at once (finished ones stay for log export,
// so this also bounds memory across a session; a flood beyond it is dropped).
const MAX_LIVE_MATCHES = 64;

/**
 * @param {{
 *   selfDid: string,
 *   send: (toDid: string, msg: Record<string, any>) => Promise<any>,
 *   rules: {
 *     derive: (seedHex: string, info: { matchId: string, gameId: string, rulesHash: string }) => Promise<any>,
 *     check: (seedHex: string, answer: string, info: { matchId: string, gameId: string, rulesHash: string }) => Promise<{ correct: boolean, score?: number }>,
 *   },
 *   solve: (challenge: any, info: { matchId: string, gameId: string, rulesHash: string, deadlineAt: number }) => Promise<{ answer: string }>,
 *   signResult?: ((resultString: string) => Promise<string>) | null,
 *   verifyResultSig?: ((did: string, sigHex: string, resultString: string) => Promise<boolean>) | null,
 *   acceptPolicy?: (info: { from: string, gameId: string, matchId: string, rulesHash: string }) => Promise<boolean> | boolean,
 *   onEvent?: (evt: { type: string, matchId: string, state: any }) => void,
 *   now?: () => number,
 *   schedule?: (fn: () => void, ms: number) => any,
 *   cancel?: (handle: any) => void,
 * }} deps
 */
export const createMatchDriver = ({
  selfDid, send, rules, solve,
  signResult = null, verifyResultSig = null,
  acceptPolicy = () => false,           // why fail-closed: an unsolicited challenge costs compute; the host opts in
  onEvent = () => {},
  now = Date.now,
  schedule = (fn, ms) => setTimeout(fn, ms),
  cancel = (h) => clearTimeout(h),
}) => {
  /**
   * @typedef {{
   *   state: import('./match-reducer.js').MatchState,
   *   peer: string,
   *   log: Array<{ dir: 'in'|'out', from: string, at: number, msg: Record<string, any> }>,
   *   secrets: { seedNonce?: string, seedSalt?: string, answer?: string, answerSalt?: string, sawPeerFirst?: boolean },
   *   pendingSigs: Record<string, string>,
   *   sent: Record<string, boolean>,
   *   challengeObj: any,
   *   resultString: string|null,
   *   chain: Promise<void>,
   *   timer: any,
   *   finished: boolean,
   *   done: Promise<any>,
   *   resolveDone: (v: any) => void,
   * }} MatchRec
   */
  /** @type {Map<string, MatchRec>} */
  const matches = new Map();

  /** @param {import('./match-reducer.js').MatchState} state @param {string} peer @returns {MatchRec} */
  const newRec = (state, peer) => {
    /** @type {any} */ let resolveDone;
    const done = new Promise((res) => { resolveDone = res; });
    return { state, peer, log: [], secrets: {}, pendingSigs: {}, sent: {}, challengeObj: null, resultString: null, chain: Promise.resolve(), timer: null, finished: false, done, resolveDone };
  };

  /** @param {MatchRec} rec */
  const snapshot = (rec) => structuredClone({ ...rec.state, resultString: rec.resultString });

  /** @param {MatchRec} rec @param {string} type */
  const emit = (rec, type) => { try { onEvent({ type, matchId: rec.state.matchId, state: snapshot(rec) }); } catch { /* a UI listener must never break the match */ } };

  /** Queue one serialized step for a match. @param {MatchRec} rec @param {() => Promise<void>} fn */
  const enqueue = (rec, fn) => {
    rec.chain = rec.chain.then(fn).catch(() => { /* per-step errors are handled inside; the chain must survive */ });
    return rec.chain;
  };

  /** @param {MatchRec} rec @param {string} reason */
  const abortLocal = (rec, reason) => {
    if (rec.state.phase === 'done') return;
    rec.state = { ...rec.state, phase: 'done', phaseAt: now(), outcome: { kind: 'aborted', reason } };
  };

  /** Send + apply one of our OWN protocol messages (symmetric reducer feed).
   * @param {MatchRec} rec @param {Record<string, any>} body */
  const sendOwn = async (rec, body) => {
    const msg = { __game: 1, matchId: rec.state.matchId, ...body };
    const at = now();
    try { await send(rec.peer, msg); }
    catch { abortLocal(rec, 'send-failed'); return; }
    rec.log.push({ dir: 'out', from: selfDid, at, msg });
    // Our own reveals match our own commits by construction.
    rec.state = applyMessage(rec.state, { from: selfDid, at, msg, revealOk: true });
  };

  /** @param {MatchRec} rec */
  const armTimer = (rec) => {
    if (rec.timer != null) { cancel(rec.timer); rec.timer = null; }
    if (rec.state.phase === 'done') return;
    const dueIn = Math.max(0, rec.state.phaseAt + phaseDuration(rec.state) - now()) + 25;
    rec.timer = schedule(() => {
      rec.timer = null;
      enqueue(rec, async () => { rec.state = applyTimeout(rec.state, now()); await advance(rec); });
    }, dueIn);
  };

  /**
   * Idempotent effect pump: look at the state, perform whatever WE owe next.
   * `sent` flags are set before the first await of each effect so a re-entrant
   * pass (every queue step ends here) never doubles a send.
   * @param {MatchRec} rec
   */
  const advance = async (rec) => {
    const s = () => rec.state;

    if (s().phase === 'seeding' && !rec.sent.seedCommit) {
      rec.sent.seedCommit = true;
      rec.secrets.seedNonce = randomHex(16);
      rec.secrets.seedSalt = randomHex(16);
      await sendOwn(rec, { type: 'seed_commit', commit: await makeCommit(rec.secrets.seedNonce, rec.secrets.seedSalt) });
    }
    if (s().phase === 'seeding' && !rec.sent.seedReveal
        && s().seed.commits[selfDid] && s().seed.commits[rec.peer]) {
      rec.sent.seedReveal = true;
      await sendOwn(rec, { type: 'seed_reveal', nonce: rec.secrets.seedNonce, salt: rec.secrets.seedSalt });
    }

    if (s().phase === 'solving' && !rec.sent.seedApplied) {
      rec.sent.seedApplied = true;
      const nonces = Object.values(s().seed.reveals).map((r) => r.nonce);
      rec.state = applySeed(rec.state, await combineSeed(rec.state.matchId, nonces));
      emit(rec, 'update');
      // Derive the puzzle, then race: the solver is the competitor's business.
      // info names WHICH game this match plays — one driver, many installed games.
      const deadlineAt = s().phaseAt + phaseDuration(s());
      const info = { matchId: rec.state.matchId, gameId: rec.state.gameId, rulesHash: rec.state.rulesHash };
      (async () => {
        let answer = null;
        try {
          rec.challengeObj = await rules.derive(/** @type {string} */(rec.state.seed.value), info);
          emit(rec, 'update');
          answer = (await solve(rec.challengeObj, { ...info, deadlineAt }))?.answer;
        } catch { /* an unsolved puzzle just runs out the clock (solve-timeout forfeit) */ }
        if (typeof answer !== 'string' || !answer) return;
        enqueue(rec, async () => {
          if (rec.state.phase !== 'solving' || rec.sent.answerCommit) return;
          rec.sent.answerCommit = true;
          rec.secrets.answer = answer;
          rec.secrets.answerSalt = randomHex(16);
          // Captured at commit time: had the peer's commit already landed?
          rec.secrets.sawPeerFirst = !!rec.state.answers.commits[rec.peer];
          await sendOwn(rec, { type: 'answer_commit', commit: await makeCommit(answer, rec.secrets.answerSalt) });
          await advance(rec);
        });
      })();
    }

    if (s().phase === 'revealing' && !rec.sent.answerReveal && rec.secrets.answer != null) {
      rec.sent.answerReveal = true;
      await sendOwn(rec, {
        type: 'answer_reveal', answer: rec.secrets.answer, salt: rec.secrets.answerSalt,
        sawPeerCommitFirst: !!rec.secrets.sawPeerFirst,
      });
    }

    if (s().phase === 'scoring' && !rec.sent.scored) {
      rec.sent.scored = true;
      // Verdicts for BOTH answers, computed locally (sealed worker when the
      // rules are peer content) — both sides do this and must agree.
      const info = { matchId: rec.state.matchId, gameId: rec.state.gameId, rulesHash: rec.state.rulesHash };
      for (const did of [rec.state.players.challenger, rec.state.players.acceptor]) {
        const r = rec.state.answers.reveals[did];
        const v = r ? await rules.check(/** @type {string} */(rec.state.seed.value), r.answer, info).catch(() => ({ correct: false, score: 0 })) : { correct: false, score: 0 };
        rec.state = applyVerdict(rec.state, { did, correct: !!v.correct, score: v.score ?? 0, at: now() });
      }
      emit(rec, 'update');
    }

    if (s().phase === 'signing' && !rec.sent.resultSig) {
      rec.sent.resultSig = true;
      rec.resultString = canonicalResult(rec.state);
      if (signResult && verifyResultSig) {
        try {
          const sig = await signResult(rec.resultString);
          await sendOwn(rec, { type: 'result_sig', sig });
        } catch { rec.state = finalizeUnsigned(rec.state, now()); }
        // A counter-signature that raced ahead of our scoring was buffered —
        // verify + apply it now that the result string is fixed (and log it,
        // so the exported transcript stays complete).
        for (const [did, sig] of Object.entries(rec.pendingSigs)) {
          delete rec.pendingSigs[did];
          if (rec.state.phase !== 'signing') break;
          if (await verifyResultSig(did, sig, rec.resultString).catch(() => false)) {
            const msg = { __game: 1, matchId: rec.state.matchId, type: 'result_sig', sig };
            rec.log.push({ dir: 'in', from: did, at: now(), msg });
            rec.state = applyMessage(rec.state, { from: did, at: now(), msg });
          }
        }
      } else {
        // why both-or-neither: signing without the means to verify the
        // counter-signature can never reach a co-signed log anyway.
        rec.state = finalizeUnsigned(rec.state, now());
      }
    }

    if (s().phase === 'done' && !rec.finished) {
      rec.finished = true;
      if (rec.timer != null) { cancel(rec.timer); rec.timer = null; }
      if (!rec.resultString && rec.state.outcome) rec.resultString = canonicalResult(rec.state);
      emit(rec, 'done');
      rec.resolveDone(snapshot(rec));
      return;
    }
    armTimer(rec);
    emit(rec, 'update');
  };

  /** Process one inbound game message for an existing match.
   * @param {MatchRec} rec @param {string} from @param {Record<string, any>} msg */
  const applyInbound = async (rec, from, msg) => {
    const at = now();
    /** @type {boolean | undefined} */
    let revealOk;
    if (msg.type === 'seed_reveal') {
      revealOk = await verifyReveal({ commit: rec.state.seed.commits[from] ?? '', value: msg.nonce, saltHex: msg.salt });
    } else if (msg.type === 'answer_reveal') {
      revealOk = await verifyReveal({ commit: rec.state.answers.commits[from]?.commit ?? '', value: msg.answer, saltHex: msg.salt });
    } else if (msg.type === 'result_sig') {
      // Verify BEFORE applying — a stored signature is a verified one. If the
      // peer scored faster and its sig raced ahead of our own signing phase,
      // buffer it (latest wins) and re-check once our result string is fixed.
      if (rec.resultString == null) {
        if (rec.state.phase !== 'done') rec.pendingSigs[from] = String(msg.sig ?? '');
        return;
      }
      const ok = !!verifyResultSig
        && await verifyResultSig(from, String(msg.sig ?? ''), rec.resultString).catch(() => false);
      if (!ok) return; // invalid counter-signature: never applied
    }
    rec.log.push({ dir: 'in', from, at, msg });
    rec.state = applyMessage(rec.state, { from, at, msg, revealOk });
    await advance(rec);
  };

  return {
    /**
     * Start a match against a peer. Resolves to the matchId immediately after
     * the challenge is sent; await whenDone(matchId) for the final state.
     * @param {string} peerDid
     * @param {{ gameId: string, rulesHash: string, deadlines?: Record<string, number> }} opts
     */
    async challenge(peerDid, { gameId, rulesHash, deadlines }) {
      if (!peerDid || peerDid === selfDid) throw new GameProtocolError('challenge: need a peer did');
      if (!gameId || !rulesHash) throw new GameProtocolError('challenge: gameId and rulesHash are required');
      const matchId = `m-${now().toString(36)}-${randomHex(4)}`;
      const state = createMatch({ matchId, gameId, rulesHash, challenger: selfDid, acceptor: peerDid, deadlines, at: now() });
      const rec = newRec(state, peerDid);
      matches.set(matchId, rec);
      await enqueue(rec, async () => {
        await sendOwn(rec, { type: 'challenge', gameId, rulesHash, to: peerDid, ...(deadlines ? { deadlines } : {}) });
        emit(rec, 'challenge-sent');
        await advance(rec);
      });
      return matchId;
    },

    /**
     * Route an inbound direct message. Synchronous verdict (is it ours?);
     * processing continues on the match's serialized queue. Mirrors
     * a2a-dispatch.handleInbound so both routers can share one direct channel.
     * @param {string} from @param {unknown} data
     * @returns {{ consumed: boolean }}
     */
    handleInbound(from, data) {
      if (!isGameMessage(data)) return { consumed: false };
      const msg = /** @type {{ __game: 1, matchId: string, type: string } & Record<string, any>} */ (data);
      const existing = matches.get(msg.matchId);
      if (existing) {
        if (from !== existing.peer) return { consumed: true }; // only the match's peer may speak on it
        enqueue(existing, () => applyInbound(existing, from, msg));
        return { consumed: true };
      }
      if (msg.type !== 'challenge') return { consumed: true }; // stray message for an unknown match: drop
      // Bound the live-match table: a challenge flood past the cap is dropped
      // outright (no decline reply — replying to a flood is amplification).
      if (matches.size >= MAX_LIVE_MATCHES) return { consumed: true };
      // A fresh inbound challenge: fail-closed acceptPolicy decides.
      const state = createMatch({
        matchId: msg.matchId, gameId: String(msg.gameId ?? ''), rulesHash: String(msg.rulesHash ?? ''),
        challenger: from, acceptor: selfDid, deadlines: msg.deadlines, at: now(),
      });
      const rec = newRec(state, from);
      matches.set(msg.matchId, rec);
      rec.log.push({ dir: 'in', from, at: now(), msg });
      enqueue(rec, async () => {
        emit(rec, 'challenge-received');
        let ok = false;
        try { ok = await acceptPolicy({ from, gameId: state.gameId, matchId: state.matchId, rulesHash: state.rulesHash }); }
        catch { ok = false; }
        await sendOwn(rec, ok ? { type: 'accept', rulesHash: state.rulesHash } : { type: 'decline', reason: 'not accepted' });
        await advance(rec);
      });
      return { consumed: true };
    },

    /** Resign an active match. @param {string} matchId */
    async resign(matchId) {
      const rec = matches.get(matchId);
      if (!rec) throw new GameProtocolError(`resign: unknown match ${matchId}`);
      await enqueue(rec, async () => {
        if (rec.state.phase === 'done' || rec.state.phase === 'proposed') return;
        await sendOwn(rec, { type: 'resign' });
        await advance(rec);
      });
    },

    /** @param {string} matchId */
    whenDone(matchId) {
      const rec = matches.get(matchId);
      if (!rec) throw new GameProtocolError(`whenDone: unknown match ${matchId}`);
      return rec.done;
    },

    /** @param {string} matchId */
    get(matchId) {
      const rec = matches.get(matchId);
      return rec ? snapshot(rec) : null;
    },

    /** The full auditable log of a finished (or live) match. @param {string} matchId */
    exportLog(matchId) {
      const rec = matches.get(matchId);
      if (!rec) return null;
      return structuredClone({ entries: rec.log, result: rec.resultString ?? '', sigs: rec.state.sigs });
    },

    list: () => [...matches.keys()],

    close() { for (const rec of matches.values()) if (rec.timer != null) { cancel(rec.timer); rec.timer = null; } },
  };
};
