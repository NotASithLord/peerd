// @ts-check
// peerd-runtime/actor — where a web actor's origin state actually lives.
// (issue #251, the plumbing half.)
//
// The rule (landing-rule.js) decides and the shell (origin-lock.js) asks. This
// is the thing in the middle that both of them assumed existed: a per-actor
// state that is READ SYNCHRONOUSLY (the shell's `getState` is sync by design —
// it runs inside a per-tool-call hot path) yet PERSISTS, because a bound actor's
// owned origin and its excursion budget are worth exactly nothing if a service
// worker eviction hands the next turn a blank slate.
//
// So: an in-memory cache is the read path, durable storage is the write path,
// and `hydrate` is what makes the two agree after an eviction. All IO injected.
//
// THREE PROPERTIES THIS FILE EXISTS TO GUARANTEE, each of which was a real hole
// in the design before it had a home:
//
//   1. THE READ-MODIFY-WRITE IS ATOMIC, and it is worth being precise about WHY,
//      because an earlier version of this comment credited the wrong mechanism
//      and a reviewer relying on it would have drawn the wrong boundary.
//
//      The tool loop runs READ-class calls CONCURRENTLY (loop/tool-batch.js
//      partitionToolBatch) and every DOM tool judges its landing, so two judges
//      can be in flight for one actor. They cannot interleave because
//      `makeJudgeLanding` has NO await between `getState()` and `saveState()`,
//      and `write()` below does its compare-and-assign synchronously. Single-
//      threaded JS does the rest. It is NOT the promise chain that protects
//      this — the chain orders the DURABLE writes only.
//
//      *** DO NOT INTRODUCE AN AWAIT into that span. *** Making the classifier
//      async, or awaiting an audit append inside the judge, would let two
//      concurrent judges both read `excursionsUsed: 0` and both store 1 —
//      doubling MAX_EXCURSIONS, whose entire job is to be un-refreshable.
//
//      The chain is keyed PER SESSION, not per store. A global chain would make
//      every actor's `judgeLanding` await every other actor's IDB write — and
//      the injected save is `sessions.update`, which re-reads the whole session
//      — so one slow save in one chat would stall the DOM tools of every web
//      actor in every other chat.
//
//   2. THE CACHE IS UPDATED BEFORE THE AWAIT. The shell's next sync `getState`
//      may happen before the storage write resolves. Applying the patch to the
//      cached object first means the in-heap truth is never behind the decision
//      that produced it; the durable write is catch-up, not the source.
//
//   3. NO-OP WRITES ARE ELIDED. The overwhelmingly common verdict is "continue,
//      nothing changed", whose patch is `{ excursion: null }` over a state that
//      already has no excursion. Persisting that would put an IDB write on every
//      DOM tool call for no information. Elision keeps the durable layer for
//      things that actually changed.
//
// WHAT THIS IS NOT: a policy. Nothing here decides whether an actor may be
// somewhere. It stores what the rule decided. If a change to this file starts
// making that kind of judgement, it belongs next door.

/**
 * @typedef {import('./origin-lock.js').ActorOriginState} ActorOriginState
 */

/**
 * Structural equality for the one nested value we store. Small and explicit
 * rather than a deep-equal helper: the shape is fixed by the Excursion typedef,
 * and a generic comparator would silently keep working (wrongly) if the shape
 * grew a field.
 *
 * @param {import('./landing-rule.js').Excursion | null | undefined} a
 * @param {import('./landing-rule.js').Excursion | null | undefined} b
 */
const sameExcursion = (a, b) => {
  if (!a || !b) return !a === !b;
  return a.returnTo === b.returnTo
    && a.openedAt === b.openedAt
    && a.lastLanding === b.lastLanding
    && a.budget === b.budget
    && a.deadline === b.deadline;
};

/**
 * Does this patch change anything about the stored state?
 * @param {ActorOriginState} state
 * @param {Partial<ActorOriginState>} patch
 */
const changesSomething = (state, patch) => Object.entries(patch).some(([key, next]) => {
  if (key === 'excursion') {
    return !sameExcursion(
      /** @type {any} */ (state).excursion,
      /** @type {any} */ (next),
    );
  }
  // why `?? null` on both sides: an absent field and an explicit null are the
  // same fact here (`ownedOrigin` is optional in the typedef but written as
  // null by the seed), and treating them as different would make the first
  // write after a hydrate always look like a change.
  return (/** @type {any} */ (state)[key] ?? null) !== (next ?? null);
});

/**
 * Build a store.
 *
 * @param {object} deps
 * @param {(sessionId: string, state: ActorOriginState) => Promise<void>} deps.save
 *   write the WHOLE state (not the patch) — the caller owns merging, so a
 *   storage layer that can only put a full record works unchanged.
 * @param {(message: string, error: unknown) => void} [deps.onError]
 */
export const makeOriginStateStore = ({ save, onError }) => {
  /** @type {Map<string, ActorOriginState>} */
  const cache = new Map();
  /** Per-SESSION durable-write chains — see property 1. @type {Map<string, Promise<unknown>>} */
  const chains = new Map();

  const report = (/** @type {string} */ message, /** @type {unknown} */ error) => {
    if (onError) onError(message, error);
    else console.warn('[origin-lock]', message, error);
  };

  /**
   * Make sure this actor's state is in the cache, seeding it from the DURABLE
   * record the caller already holds.
   *
   * why the caller supplies the durable state instead of this file loading it:
   * every call site (buildToolContext, the site-client egress route) has already
   * read the actor's session record for other reasons, so a load here would be a
   * second read AND a second failure mode. That failure mode was not neutral —
   * adversarial review caught it: a load that threw fell back to the seed, and
   * the seed is `roaming`, so a transient storage error QUIETLY DEMOTED a bound
   * actor to roaming. For the credential scope that is a WIDENING (bound may
   * spend its session on one origin; roaming may spend it on any non-sensitive
   * one), which is the wrong direction for an error path. With no load there is
   * no such path: the record is either read successfully by the caller or the
   * caller never gets far enough to build a context.
   *
   * SYNCHRONOUS, and that matters too — there is no await between "decide to
   * lock" and "the lock is readable", so no window exists in which read()
   * returns null (== unlocked) for an actor that is already running tools.
   *
   * The cache WINS over a re-seed: it is written by verdicts and is therefore
   * never staler than the record.
   *
   * @param {string} sessionId
   * @param {ActorOriginState | null | undefined} durable  the record's stored state
   * @returns {ActorOriginState}
   */
  const hydrate = (sessionId, durable) => {
    const cached = cache.get(sessionId);
    if (cached) return cached;
    // Fail CLOSED on a stored record whose mode we don't recognize — including
    // one written before the field existed. Not by inventing a mode: `decideLanding`
    // already ends an actor whose mode is unknown, so passing the bad value
    // through is what makes that guard fire instead of silently bypassing it.
    const state = /** @type {ActorOriginState} */ (
      durable && typeof durable === 'object' ? { ...durable } : { mode: 'roaming' }
    );
    cache.set(sessionId, state);
    return state;
  };

  /**
   * The SYNC read the lock's `getState` uses. Null means "not hydrated", which
   * the shell reads as "no lock" — so a caller MUST hydrate before it can rely
   * on the lock applying. Hydration is synchronous precisely so that "must" is
   * easy to satisfy: there is no await to forget and no window to lose.
   *
   * @param {string} sessionId
   * @returns {ActorOriginState | null}
   */
  const read = (sessionId) => cache.get(sessionId) ?? null;

  /**
   * Apply a patch. Cache first (property 2), durable second (properties 1+3).
   *
   * @param {string} sessionId
   * @param {Partial<ActorOriginState>} patch
   * @returns {Promise<void>}
   */
  const write = (sessionId, patch) => {
    const state = cache.get(sessionId);
    // Nothing hydrated means no lock is running for this actor; a write with no
    // state to merge into would invent one. Drop it.
    if (!state) return Promise.resolve();
    if (!changesSomething(state, patch)) return Promise.resolve();
    Object.assign(state, patch);
    const snapshot = { ...state };
    // why the snapshot and not `state`: the chain runs later, by which time a
    // subsequent verdict may have mutated the live object. Persisting the value
    // as it was AT THIS VERDICT keeps the durable record a sequence of real
    // states rather than a smear of two.
    const next = (chains.get(sessionId) ?? Promise.resolve())
      .then(() => save(sessionId, snapshot))
      // Caught HERE so one actor's storage failure cannot poison its own next
      // write, let alone anyone else's.
      .catch((e) => report('state save failed — this actor is heap-only until the next write', e));
    chains.set(sessionId, next);
    return next.then(() => undefined);
  };

  /** Drop an actor's cached state (its session vanished). */
  const forget = (/** @type {string} */ sessionId) => {
    cache.delete(sessionId);
    chains.delete(sessionId);
  };

  /** Test seam: has anything been hydrated for this actor? */
  const isHydrated = (/** @type {string} */ sessionId) => cache.has(sessionId);

  /** Test seam: await every queued durable write, across all sessions. */
  const settled = () => Promise.all([...chains.values()]).then(() => undefined, () => undefined);

  return Object.freeze({ hydrate, read, write, forget, isHydrated, settled });
};
