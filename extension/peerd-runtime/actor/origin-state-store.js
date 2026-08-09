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
//   1. AUTHORITY TRANSITIONS COMMIT DURABLY BEFORE THEY REACH THE CACHE. Writes
//      for one actor share a promise lane, so concurrent tool calls cannot both
//      spend the same allowance. The operation re-reads current cache state in
//      that lane, writes the full next snapshot, then publishes its patch.
//      Failed persistence therefore cannot leave usable in-memory authority.
//
//      The chain is keyed PER SESSION, not per store. A global chain would make
//      every actor's `judgeLanding` await every other actor's IDB write, so one
//      slow save in one chat would stall unrelated actors.
//
//   2. CALLERS SEE PERSISTENCE FAILURE. The internal lane catches a rejection
//      only so later writes can continue. The individual write still rejects,
//      which makes the policy shell fail closed instead of reporting authority
//      that was never committed.
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
    && a.idpOrigin === b.idpOrigin
    && a.deadline === b.deadline
    && a.authorized === b.authorized;
};

/**
 * @param {import('./landing-rule.js').AuthGrant | null | undefined} a
 * @param {import('./landing-rule.js').AuthGrant | null | undefined} b
 */
const sameAuthGrant = (a, b) => {
  if (!a || !b) return !a === !b;
  return a.returnTo === b.returnTo
    && a.idpOrigin === b.idpOrigin
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
  if (key === 'authGrant') {
    return !sameAuthGrant(
      /** @type {any} */ (state).authGrant,
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
  /** Per-session policy lanes. Decisions and their writes must be one operation. @type {Map<string, Promise<unknown>>} */
  const transitions = new Map();

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
   * Apply a patch in the actor's durable lane, then publish it to the heap.
   * Authority must never become usable before its durable write commits, and
   * a failed consume/clear must leave the old restrictive state in memory.
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
    const operation = (chains.get(sessionId) ?? Promise.resolve()).then(async () => {
      const current = cache.get(sessionId);
      if (!current || !changesSomething(current, patch)) return;
      const snapshot = { ...current, ...patch };
      await save(sessionId, snapshot);
      Object.assign(current, patch);
    });
    // Keep the internal lane recoverable, but return the original operation so
    // security callers fail closed instead of acting on a state that did not
    // persist. A later write still gets a clean predecessor.
    const recovered = operation.catch((e) => {
      report('state save failed; the authority transition was not applied', e);
    });
    chains.set(sessionId, recovered);
    return operation.then(() => undefined).catch((cause) => {
      const error = Object.assign(new Error('origin_state_persistence_failed'), {
        cause,
        endTurn: true,
        content: "peerd could not safely save this helper's browser authority, so it stopped. Review the open tab, then tell peerd what to do next.",
      });
      throw error;
    });
  };

  /**
   * Serialize an authority decision together with every durable write it makes.
   * Serializing writes alone is insufficient: a second caller could decide from
   * a grant that the first caller has committed as spent, then queue a stale
   * patch that resurrects it. All production origin-lock entry points use this
   * lane, so each decision reads the state left by its predecessor.
   *
   * @template T
   * @param {string} sessionId
   * @param {() => Promise<T> | T} operation
   * @returns {Promise<T>}
   */
  const serialize = (sessionId, operation) => {
    const current = transitions.get(sessionId) ?? Promise.resolve();
    const next = current.then(operation);
    transitions.set(sessionId, next.catch(() => {}));
    return next;
  };

  /** Drop an actor's cached state (its session vanished). */
  const forget = (/** @type {string} */ sessionId) => {
    cache.delete(sessionId);
    chains.delete(sessionId);
    transitions.delete(sessionId);
  };

  /** Test seam: has anything been hydrated for this actor? */
  const isHydrated = (/** @type {string} */ sessionId) => cache.has(sessionId);

  /** Test seam: await every queued durable write, across all sessions. */
  const settled = () => Promise.all([...chains.values()]).then(() => undefined, () => undefined);

  return Object.freeze({ hydrate, read, write, serialize, forget, isHydrated, settled });
};
