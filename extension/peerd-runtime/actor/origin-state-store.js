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
//   1. WRITES ARE SERIALIZED. The tool loop runs READ-class calls CONCURRENTLY
//      (loop/tool-batch.js partitionToolBatch), and every DOM tool judges its
//      landing. Two concurrent judges doing read-modify-write on the same actor
//      would both observe `excursionsUsed: 0` and both store 1 — the lifetime
//      cap silently doubling. A promise chain per store makes each write see the
//      previous one's result. (The SW's actor mailbox serializes for the same
//      reason and the same way; this is that pattern, not a new one.)
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
 * @param {(sessionId: string) => Promise<ActorOriginState | null>} deps.load
 *   read the durable copy. Called at most once per session per store lifetime.
 * @param {(sessionId: string, state: ActorOriginState) => Promise<void>} deps.save
 *   write the WHOLE state (not the patch) — the caller owns merging, so a
 *   storage layer that can only put a full record works unchanged.
 * @param {(message: string, error: unknown) => void} [deps.onError]
 */
export const makeOriginStateStore = ({ load, save, onError }) => {
  /** @type {Map<string, ActorOriginState>} */
  const cache = new Map();
  /** @type {Map<string, Promise<ActorOriginState>>} */
  const hydrating = new Map();
  /** @type {Promise<unknown>} */
  let chain = Promise.resolve();

  const report = (/** @type {string} */ message, /** @type {unknown} */ error) => {
    if (onError) onError(message, error);
    else console.warn('[origin-lock]', message, error);
  };

  /**
   * Make sure this actor's state is in the cache, loading it once if needed.
   * Concurrent callers share one load (the `hydrating` map) — without it, two
   * tool calls racing on a cold cache would each load and each cache, and the
   * loser's writes would land on an object nobody reads afterwards.
   *
   * @param {string} sessionId
   * @param {ActorOriginState} seed  used when nothing is stored yet
   * @returns {Promise<ActorOriginState>}
   */
  const hydrate = (sessionId, seed) => {
    const cached = cache.get(sessionId);
    if (cached) return Promise.resolve(cached);
    const inFlight = hydrating.get(sessionId);
    if (inFlight) return inFlight;
    const p = (async () => {
      let stored = null;
      try { stored = await load(sessionId); }
      catch (e) { report('state load failed — falling back to the seed', e); }
      // why the seed WINS on mode: the seed is what the mint decided this actor
      // is, and a stored record from an older shape may have no mode at all.
      // decideLanding fails closed on an unknown mode, so a hydrate that lost it
      // would end every actor rather than merely forget a budget.
      const state = { ...seed, ...(stored ?? {}), mode: stored?.mode ?? seed.mode };
      // Re-check: a concurrent hydrate may have landed while we awaited.
      const raced = cache.get(sessionId);
      if (raced) return raced;
      cache.set(sessionId, state);
      return state;
    })().finally(() => { hydrating.delete(sessionId); });
    hydrating.set(sessionId, p);
    return p;
  };

  /**
   * The SYNC read the lock's `getState` uses. Null means "not hydrated", which
   * the shell reads as "no lock" — so a caller MUST hydrate before it can rely
   * on the lock applying. That is why hydration happens at context-build time
   * (which is already async) rather than lazily at judge time: making the
   * failure mode "no lock" would be a silent one.
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
    chain = chain
      .then(() => save(sessionId, snapshot))
      .catch((e) => report('state save failed — this actor is heap-only until the next write', e));
    return chain.then(() => undefined);
  };

  /** Drop an actor's cached state (its tab closed, its session was archived). */
  const forget = (/** @type {string} */ sessionId) => { cache.delete(sessionId); };

  /** Test seam: has anything been hydrated for this actor? */
  const isHydrated = (/** @type {string} */ sessionId) => cache.has(sessionId);

  /** Test seam: await every queued durable write. */
  const settled = () => chain.then(() => undefined, () => undefined);

  return Object.freeze({ hydrate, read, write, forget, isHydrated, settled });
};
